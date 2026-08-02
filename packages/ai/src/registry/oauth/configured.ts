import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types";

const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export interface ConfiguredOAuthProvider {
	name: string;
	clientId: string;
	clientSecret?: string;
	authorizationUrl: string;
	tokenUrl: string;
	scopes: string[];
	redirectUri?: string;
	callbackPort?: number;
	callbackPath?: string;
	accessTokenField?: string;
	refreshTokenField?: string;
	expiresInField?: string;
	useIdToken?: boolean;
	pkce?: boolean;
	authorizationParams?: Record<string, string>;
	tokenParams?: Record<string, string>;
	fetch?: FetchImpl;
}

type TokenPayload = Record<string, unknown>;

function configuredProviderError(
	providerId: string,
	message: string,
	kind: "configuration" | "token-exchange" | "token-refresh" | "validation",
	status?: number,
): AIError.OAuthError {
	return new AIError.OAuthError(message, { kind, provider: providerId, status });
}

function requireTokenField(payload: TokenPayload, field: string, providerId: string, label: string): string {
	const value = payload[field];
	if (typeof value !== "string" || value.length === 0) {
		throw configuredProviderError(providerId, `OAuth ${label} response missing ${field}`, "validation");
	}
	return value;
}

function optionalTokenField(payload: TokenPayload, field: string): string | undefined {
	const value = payload[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expiresAt(payload: TokenPayload, field: string, providerId: string, accessToken: string): number {
	const value = payload[field];
	const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000;
	const encodedPayload = accessToken.split(".")[1];
	if (encodedPayload) {
		try {
			const claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as { exp?: unknown };
			if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) return claims.exp * 1000;
		} catch {
			// Non-JWT tokens may omit expires_in and remain valid until revoked.
		}
	}
	return 8.64e15;
}

async function postToken(
	providerId: string,
	config: ConfiguredOAuthProvider,
	body: URLSearchParams,
	kind: "token-exchange" | "token-refresh",
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<TokenPayload> {
	const timeoutSignal = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	let response: Response;
	try {
		response = await fetchImpl(config.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: requestSignal,
		});
	} catch (cause) {
		if (signal?.aborted) throw new AIError.LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`);
		const operation = kind === "token-exchange" ? "exchange" : "refresh";
		throw new AIError.OAuthError(`OAuth token ${operation} request failed for ${providerId}`, {
			kind,
			provider: providerId,
			cause,
		});
	}
	const text = await response.text();
	if (!response.ok) {
		throw configuredProviderError(
			providerId,
			`OAuth token ${kind === "token-exchange" ? "exchange" : "refresh"} failed: ${response.status}${text ? ` ${text}` : ""}`,
			kind,
			response.status,
		);
	}
	try {
		const payload = JSON.parse(text) as unknown;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not an object");
		return payload as TokenPayload;
	} catch (cause) {
		throw new AIError.OAuthError(`OAuth token response returned invalid JSON for ${providerId}`, {
			kind: "validation",
			provider: providerId,
			cause,
		});
	}
}

function callbackOptions(config: ConfiguredOAuthProvider) {
	if (config.redirectUri) {
		let parsed: URL;
		try {
			parsed = new URL(config.redirectUri);
		} catch (cause) {
			throw new AIError.ConfigurationError(`Invalid OAuth redirectUri: ${config.redirectUri}`, { cause });
		}
		if (parsed.protocol !== "http:" || (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1")) {
			throw new AIError.ConfigurationError(
				"Configured provider OAuth redirectUri must use a localhost HTTP callback.",
			);
		}
		const port = Number(parsed.port || "80");
		return {
			preferredPort: port,
			callbackHostname: parsed.hostname,
			callbackPath: parsed.pathname,
			redirectUri: config.redirectUri,
			allowPortFallback: false,
		};
	}
	return {
		preferredPort: config.callbackPort ?? 0,
		callbackHostname: "127.0.0.1",
		callbackPath: config.callbackPath,
		allowPortFallback: (config.callbackPort ?? 0) === 0,
	};
}

class ConfiguredOAuthFlow extends OAuthCallbackFlow {
	#verifier?: string;
	readonly #providerId: string;
	readonly #config: ConfiguredOAuthProvider;
	readonly #fetch: FetchImpl;

	constructor(providerId: string, config: ConfiguredOAuthProvider, callbacks: OAuthLoginCallbacks) {
		super(callbacks, callbackOptions(config));
		this.#providerId = providerId;
		this.#config = config;
		this.#fetch = callbacks.fetch ?? config.fetch ?? fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const params = new URLSearchParams({
			...this.#config.authorizationParams,
			client_id: this.#config.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: this.#config.scopes.join(" "),
			state,
		});
		if (this.#config.pkce !== false) {
			const pkce = await generatePKCE();
			this.#verifier = pkce.verifier;
			params.set("code_challenge", pkce.challenge);
			params.set("code_challenge_method", "S256");
		}
		const url = new URL(this.#config.authorizationUrl);
		for (const [key, value] of params) url.searchParams.set(key, value);
		return { url: url.toString(), instructions: `Complete ${this.#config.name} sign-in in your browser.` };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const body = new URLSearchParams({
			...this.#config.tokenParams,
			client_id: this.#config.clientId,
			code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri,
		});
		if (this.#config.clientSecret) body.set("client_secret", this.#config.clientSecret);
		if (this.#verifier) body.set("code_verifier", this.#verifier);
		const payload = await postToken(
			this.#providerId,
			this.#config,
			body,
			"token-exchange",
			this.#fetch,
			this.ctrl.signal,
		);
		return credentialsFromPayload(this.#providerId, this.#config, payload);
	}
}

function credentialsFromPayload(
	providerId: string,
	config: ConfiguredOAuthProvider,
	payload: TokenPayload,
	previousRefresh?: string,
): OAuthCredentials {
	const accessField = config.useIdToken ? "id_token" : (config.accessTokenField ?? "access_token");
	const refreshField = config.refreshTokenField ?? "refresh_token";
	const expiresField = config.expiresInField ?? "expires_in";
	const access = requireTokenField(payload, accessField, providerId, "token");
	return {
		access,
		refresh: optionalTokenField(payload, refreshField) ?? previousRefresh ?? "",
		expires: expiresAt(payload, expiresField, providerId, access),
	};
}

export function createConfiguredOAuthProvider(
	providerId: string,
	config: ConfiguredOAuthProvider,
): {
	name: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
} {
	return {
		name: config.name,
		login: callbacks => new ConfiguredOAuthFlow(providerId, config, callbacks).login(),
		async refreshToken(credentials) {
			if (!credentials.refresh) {
				throw configuredProviderError(
					providerId,
					`OAuth credential for ${providerId} has no refresh token`,
					"validation",
				);
			}
			const body = new URLSearchParams({
				...config.tokenParams,
				client_id: config.clientId,
				refresh_token: credentials.refresh,
				grant_type: "refresh_token",
			});
			if (config.clientSecret) body.set("client_secret", config.clientSecret);
			const payload = await postToken(providerId, config, body, "token-refresh", config.fetch ?? fetch);
			return credentialsFromPayload(providerId, config, payload, credentials.refresh);
		},
		getApiKey: credentials => credentials.access,
	};
}
