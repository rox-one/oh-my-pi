/**
 * MCP Client.
 *
 * Handles connection initialization, tool listing, and tool calling.
 */
import * as path from "node:path";
import * as url from "node:url";
import { getProjectDir, logger, withTimeout } from "@oh-my-pi/pi-utils";
import { describeMCPTimeout, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "./timeout";
import { createHttpTransport } from "./transports/http";
import { createSseTransport } from "./transports/sse";
import { createStdioTransport } from "./transports/stdio";
import type {
	MCPGetPromptParams,
	MCPGetPromptResult,
	MCPHttpServerConfig,
	MCPInitializeParams,
	MCPInitializeResult,
	MCPPrompt,
	MCPPromptsListResult,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadParams,
	MCPResourceReadResult,
	MCPResourceSubscribeParams,
	MCPResourcesListResult,
	MCPResourceTemplate,
	MCPResourceTemplatesListResult,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPToolsListResult,
	MCPTransport,
	MCPUrlElicitation,
	MCPUrlElicitationResponse,
} from "./types";

import { MCP_PROTOCOL_VERSION, MCPRequestError } from "./types";

/** Client info sent during initialization */
const CLIENT_INFO = {
	name: "omp-coding-agent",
	version: "1.0.0",
};

/**
 * Default handler for standard MCP server-to-client requests.
 * Handles `ping` and `roots/list`; rejects unknown methods with -32601.
 * Reads getProjectDir() at call time so the root stays stable even if
 * the process cwd changes during tool execution.
 */
async function defaultRequestHandler(method: string, _params: unknown): Promise<unknown> {
	switch (method) {
		case "ping":
			return {};
		case "roots/list": {
			const cwd = getProjectDir();
			return {
				roots: [{ uri: url.pathToFileURL(cwd).href, name: path.basename(cwd) }],
			};
		}
		default:
			throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
	}
}

function parseUrlElicitation(params: unknown): MCPUrlElicitation {
	if (typeof params !== "object" || params === null) {
		throw Object.assign(new Error("Invalid URL elicitation request"), { code: -32602 });
	}
	const value = params as Record<string, unknown>;
	if (value.mode !== "url" || typeof value.elicitationId !== "string" || value.elicitationId.length === 0) {
		throw Object.assign(new Error("Invalid URL elicitation request"), { code: -32602 });
	}
	if (typeof value.url !== "string" || typeof value.message !== "string") {
		throw Object.assign(new Error("Invalid URL elicitation request"), { code: -32602 });
	}
	try {
		const parsed = new URL(value.url);
		if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
			throw new Error("URL must use HTTPS without embedded credentials");
		}
	} catch {
		throw Object.assign(new Error("Invalid URL elicitation URL"), { code: -32602 });
	}
	return {
		mode: "url",
		elicitationId: value.elicitationId,
		url: value.url,
		message: value.message,
	};
}

function isUrlElicitationRequest(params: unknown): boolean {
	if (typeof params !== "object" || params === null || !("mode" in params)) return false;
	return params.mode === "url";
}

/**
 * Create a transport for the given server config.
 */
async function createTransport(config: MCPServerConfig): Promise<MCPTransport> {
	const serverType = config.type ?? "stdio";

	switch (serverType) {
		case "stdio":
			return createStdioTransport(config as MCPStdioServerConfig);
		case "http":
			return createHttpTransport(config as MCPHttpServerConfig);
		case "sse":
			return createSseTransport(config as MCPSseServerConfig);
		default:
			throw new Error(`Unknown server type: ${serverType}`);
	}
}

/**
 * Initialize connection with MCP server.
 */
async function initializeConnection(
	transport: MCPTransport,
	options?: {
		signal?: AbortSignal;
		/** Called after notifications/initialized succeeds. */
		onInitialized?: () => void | Promise<void>;
		/** Whether URL-mode elicitation is supported by an installed handler. */
		urlElicitation?: boolean;
	},
): Promise<MCPInitializeResult> {
	const params: MCPInitializeParams = {
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities: {
			roots: { listChanged: false },
			...(options?.urlElicitation ? { elicitation: { url: {} } } : {}),
		},
		clientInfo: CLIENT_INFO,
	};

	const result = await transport.request<MCPInitializeResult>(
		"initialize",
		params as unknown as Record<string, unknown>,
		{ signal: options?.signal },
	);

	if (options?.signal?.aborted) {
		throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
	}

	// Echo the negotiated protocol version on every subsequent request. The MCP
	// Streamable HTTP spec requires the MCP-Protocol-Version header after
	// initialize; transports that don't need it ignore this.
	transport.setProtocolVersion?.(result.protocolVersion);

	// Send initialized before opening the optional GET SSE stream. Servers may
	// reject or terminate sessions that receive session traffic before this
	// notification; POST response streams already carry messages during setup.
	await transport.notify("notifications/initialized");

	await options?.onInitialized?.();

	return result;
}

/**
 * Connect to an MCP server.
 * Has a 30 second timeout by default to prevent blocking startup.
 * Set OMP_MCP_TIMEOUT_MS=0 to disable MCP client-side timeouts.
 */
export async function connectToServer(
	name: string,
	config: MCPServerConfig,
	options?: {
		signal?: AbortSignal;
		onNotification?: (method: string, params: unknown) => void;
		onRequest?: (method: string, params: unknown) => Promise<unknown>;
		urlElicitationHandler?: (serverName: string, request: MCPUrlElicitation) => Promise<MCPUrlElicitationResponse>;
	},
): Promise<MCPServerConnection> {
	const timeoutMs = resolveMCPTimeoutMs(config.timeout);
	let transport: MCPTransport | undefined;

	const connect = async (): Promise<MCPServerConnection> => {
		const t = await createTransport(config);
		transport = t;
		if (options?.onNotification) {
			t.onNotification = options.onNotification;
		}

		// Always handle standard MCP server-to-client requests (ping, roots/list).
		// The initialize request declares roots capability, so we must respond to
		// roots/list — even for short-lived test connections. URL elicitation is
		// advertised unconditionally; clients without a consent handler decline it.
		const handleUrlElicitation = options?.urlElicitationHandler ?? (async () => ({ action: "decline" as const }));
		t.urlElicitationHandler = async request => handleUrlElicitation(name, request);
		t.onRequest = async (method, params) => {
			if (method === "elicitation/create" && isUrlElicitationRequest(params)) {
				const request = parseUrlElicitation(params);
				return t.urlElicitationHandler ? t.urlElicitationHandler(request) : { action: "decline" as const };
			}
			return (options?.onRequest ?? defaultRequestHandler)(method, params);
		};

		try {
			const initResult = await initializeConnection(t, {
				signal: options?.signal,
				urlElicitation: true,
				async onInitialized() {
					// Open the optional GET SSE stream only after the initialized
					// notification makes the session ready for further traffic.
					if ("startSSEListener" in t && typeof t.startSSEListener === "function") {
						await t.startSSEListener();
					}
				},
			});

			return {
				name,
				config,
				transport: t,
				serverInfo: initResult.serverInfo,
				capabilities: initResult.capabilities,
				urlElicitationHandler: options?.urlElicitationHandler,
				instructions: initResult.instructions,
			};
		} catch (error) {
			await t.close();
			throw error;
		}
	};

	try {
		if (!isMCPTimeoutEnabled(timeoutMs)) {
			return await connect();
		}
		return await withTimeout(
			connect(),
			timeoutMs,
			`Connection to MCP server "${name}" timed out after ${describeMCPTimeout(timeoutMs)}`,
			options?.signal,
		);
	} catch (error) {
		// If withTimeout rejected (timeout/abort) while connect() was still pending,
		// the transport may be alive with an open SSE listener. Close it.
		if (transport) {
			void transport.close().catch(() => {});
		}
		throw error;
	}
}

/**
 * List tools from a connected server.
 */
export async function listTools(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPToolDefinition[]> {
	// Check if server supports tools
	if (!connection.capabilities.tools) {
		return [];
	}

	// Return cached tools if available
	if (connection.tools) {
		return connection.tools;
	}

	const allTools: MCPToolDefinition[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await requestWithUrlElicitationRetry<MCPToolsListResult>(
			connection,
			"tools/list",
			params,
			options,
		);
		allTools.push(...result.tools);
		cursor = result.nextCursor;
	} while (cursor);

	// Cache tools
	connection.tools = allTools;

	return allTools;
}

/**
 * Call a tool on a connected server.
 */
export async function callTool(
	connection: MCPServerConnection,
	toolName: string,
	args: Record<string, unknown> = {},
	options?: MCPRequestOptions,
): Promise<MCPToolCallResult> {
	const params: MCPToolCallParams = {
		name: toolName,
		arguments: args,
	};

	return connection.transport.request<MCPToolCallResult>(
		"tools/call",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Disconnect from a server.
 */
export async function disconnectServer(connection: MCPServerConnection): Promise<void> {
	await connection.transport.close();
}

const URL_ELICITATION_REQUIRED_CODE = -32042;
const DEFAULT_URL_ELICITATION_WAIT_TIMEOUT_MS = 300_000;
const URL_ELICITATION_TIMEOUT_ENV = "OMP_MCP_URL_ELICITATION_TIMEOUT_MS";

function resolveUrlElicitationWaitTimeoutMs(): number {
	const configured = Number.parseInt(process.env[URL_ELICITATION_TIMEOUT_ENV] ?? "", 10);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_URL_ELICITATION_WAIT_TIMEOUT_MS;
}

function getUrlElicitations(error: unknown): MCPUrlElicitation[] | undefined {
	if (!(error instanceof MCPRequestError) || error.code !== URL_ELICITATION_REQUIRED_CODE) return undefined;
	if (typeof error.data !== "object" || error.data === null || !("elicitations" in error.data)) return undefined;
	const values = (error.data as { elicitations?: unknown }).elicitations;
	if (!Array.isArray(values) || values.length === 0) return undefined;
	const requests: MCPUrlElicitation[] = [];
	for (const value of values) {
		try {
			requests.push(parseUrlElicitation(value));
		} catch {
			return undefined;
		}
	}
	return requests;
}

async function requestWithUrlElicitationRetry<T>(
	connection: MCPServerConnection,
	method: string,
	params: Record<string, unknown>,
	options?: MCPRequestOptions,
): Promise<T> {
	try {
		return await connection.transport.request<T>(method, params, options);
	} catch (error) {
		const elicitations = getUrlElicitations(error);
		const handler = connection.urlElicitationHandler;
		if (!elicitations || !handler) throw error;

		for (const elicitation of elicitations) {
			const completionController = connection.waitForUrlElicitationCompletion ? new AbortController() : undefined;
			const completionSignal = completionController
				? options?.signal
					? AbortSignal.any([options.signal, completionController.signal])
					: completionController.signal
				: options?.signal;
			const completionPromise = connection.waitForUrlElicitationCompletion?.(
				elicitation.elicitationId,
				completionSignal,
			);
			try {
				const response = await handler(connection.name, elicitation);
				if (response.action !== "accept") {
					throw new Error(
						`MCP server "${connection.name}" URL authorization was ${response.action} for ${method}.`,
					);
				}
				if (completionPromise) {
					try {
						await withTimeout(
							completionPromise,
							resolveUrlElicitationWaitTimeoutMs(),
							"MCP URL elicitation completion wait expired",
							options?.signal,
						);
					} catch (waitError) {
						if (options?.signal?.aborted) throw waitError;
					}
				}
			} finally {
				completionController?.abort();
				await completionPromise?.catch(() => {});
			}
		}

		return connection.transport.request<T>(method, params, options);
	}
}

/**
 * Check if a server supports tools.
 */
export function serverSupportsTools(capabilities: MCPServerCapabilities): boolean {
	return capabilities.tools !== undefined;
}

/**
 * List resources from a connected server.
 */
export async function listResources(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResource[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resources) {
		return connection.resources;
	}

	const allResources: MCPResource[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await requestWithUrlElicitationRetry<MCPResourcesListResult>(
			connection,
			"resources/list",
			params,
			options,
		);
		allResources.push(...result.resources);
		cursor = result.nextCursor;
	} while (cursor);

	connection.resources = allResources;
	return allResources;
}

/** True when an error is a JSON-RPC "method not found" (-32601) response. */
function isMethodNotFoundError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("-32601") || /method not found/i.test(message);
}

/**
 * List resource templates from a connected server.
 *
 * A server MAY advertise the `resources` capability without implementing the
 * optional `resources/templates/list` method (it is optional in the MCP spec).
 * Such servers reject the request with JSON-RPC -32601 ("Method not found").
 * Treat that as "no templates" and return `[]` rather than throwing — otherwise
 * a caller that loads resources and templates together (see `MCPManager`'s
 * `Promise.all([listResources, listResourceTemplates])`) would discard the
 * server's concrete resources too. Any other error still propagates.
 */
export async function listResourceTemplates(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResourceTemplate[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resourceTemplates) {
		return connection.resourceTemplates;
	}

	const allTemplates: MCPResourceTemplate[] = [];
	let cursor: string | undefined;

	try {
		do {
			const params: Record<string, unknown> = {};
			if (cursor) {
				params.cursor = cursor;
			}

			const result = await requestWithUrlElicitationRetry<MCPResourceTemplatesListResult>(
				connection,
				"resources/templates/list",
				params,
				options,
			);
			allTemplates.push(...result.resourceTemplates);
			cursor = result.nextCursor;
		} while (cursor);
	} catch (error) {
		// A server that doesn't implement the optional templates method answers
		// -32601; cache an empty list so we neither retry nor let the failure
		// bubble up and discard the server's concrete resources.
		if (isMethodNotFoundError(error)) {
			connection.resourceTemplates = [];
			return [];
		}
		throw error;
	}

	connection.resourceTemplates = allTemplates;
	return allTemplates;
}

/**
 * Read a resource from a connected server.
 */
export async function readResource(
	connection: MCPServerConnection,
	uri: string,
	options?: MCPRequestOptions,
): Promise<MCPResourceReadResult> {
	const params: MCPResourceReadParams = { uri };
	return requestWithUrlElicitationRetry<MCPResourceReadResult>(
		connection,
		"resources/read",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Subscribe to resource update notifications.
 */
export async function subscribeToResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return requestWithUrlElicitationRetry(
				connection,
				"resources/subscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to subscribe to MCP resource", { error: result.reason });
		}
	}
}

/**
 * Unsubscribe from resource update notifications.
 */
export async function unsubscribeFromResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return requestWithUrlElicitationRetry(
				connection,
				"resources/unsubscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to unsubscribe from MCP resource", { error: result.reason });
		}
	}
}

/**
 * Check if a server supports resource subscriptions.
 */
export function serverSupportsResourceSubscriptions(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources?.subscribe === true;
}

/**
 * Check if a server supports resources.
 */
export function serverSupportsResources(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources !== undefined;
}

/**
 * List prompts from a connected server.
 */
export async function listPrompts(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPPrompt[]> {
	if (!connection.capabilities.prompts) {
		return [];
	}

	if (connection.prompts) {
		return connection.prompts;
	}

	const allPrompts: MCPPrompt[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await requestWithUrlElicitationRetry<MCPPromptsListResult>(
			connection,
			"prompts/list",
			params,
			options,
		);
		allPrompts.push(...result.prompts);
		cursor = result.nextCursor;
	} while (cursor);

	connection.prompts = allPrompts;
	return allPrompts;
}

/**
 * Get a specific prompt from a connected server.
 */
export async function getPrompt(
	connection: MCPServerConnection,
	name: string,
	args?: Record<string, string>,
	options?: MCPRequestOptions,
): Promise<MCPGetPromptResult> {
	const params: MCPGetPromptParams = { name };
	if (args && Object.keys(args).length > 0) {
		params.arguments = args;
	}

	return requestWithUrlElicitationRetry<MCPGetPromptResult>(
		connection,
		"prompts/get",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Check if a server supports prompts.
 */
export function serverSupportsPrompts(capabilities: MCPServerCapabilities): boolean {
	return capabilities.prompts !== undefined;
}
