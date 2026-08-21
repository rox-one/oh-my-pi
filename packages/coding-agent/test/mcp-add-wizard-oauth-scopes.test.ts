import { afterEach, beforeEach, expect, test } from "bun:test";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPAddWizard, type MCPAddWizardOAuthResult } from "@oh-my-pi/pi-coding-agent/modes/components/mcp-add-wizard";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";

/** Resource-bound scopes discovery returns (after #9100, resource scopes win). */
const DISCOVERED_SCOPES = "https://gateway.example.com/mcp/mcp.invoke";
/** Scopes the user substitutes for the discovered set. */
const CHOSEN_SCOPES = "https://gateway.example.com/mcp/mcp.invoke openid";

let server: Bun.Server<undefined> | null = null;

beforeEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

afterEach(() => {
	server?.stop(true);
	server = null;
});

/**
 * Serve the metadata pair that reproduces the precedence the override exists
 * for: the resource advertises one resource-bound scope while its authorization
 * server advertises a tenant-wide list, and discovery resolves to the latter.
 */
function startMetadataServer(): string {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const { pathname, origin } = new URL(request.url);
			if (pathname === "/.well-known/oauth-protected-resource") {
				return Response.json({
					resource: `${origin}/mcp`,
					authorization_servers: [origin],
					scopes_supported: ["https://gateway.example.com/mcp/mcp.invoke"],
				});
			}
			if (pathname === "/.well-known/oauth-authorization-server") {
				return Response.json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					client_id: "discovered-client",
					scopes_supported: ["openid", "email", "phone", "profile"],
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	return server.url.origin;
}

/**
 * Drive `/mcp add` to the point where the user replaces the scopes discovery
 * chose, then authorizes again.
 *
 * Two things are observable, and losing either one returns the user to the
 * scopes they rejected: the second authorization must carry their scopes as an
 * override (so it also outranks a `scope` embedded in the authorization URL),
 * and the saved config must record them so a later `/mcp reauth` does not fall
 * back to discovery.
 */
test("scopes chosen in the wizard reach the retry and the saved config", async () => {
	const origin = startMetadataServer();

	const oauthCalls: Array<{ scopes: string; scopeOverride: string | undefined }> = [];
	let probeCount = 0;
	let savedConfig: MCPServerConfig | null = null;

	const wizard = new MCPAddWizard(
		(_name, config) => {
			savedConfig = config;
		},
		() => {},
		async (_authUrl, _tokenUrl, _clientId, _clientSecret, scopes, options): Promise<MCPAddWizardOAuthResult> => {
			oauthCalls.push({ scopes, scopeOverride: options?.scopeOverride });
			return { credentialId: "cred-1" };
		},
		async () => {
			if (++probeCount === 1) {
				throw new Error(
					`HTTP 401: Unauthorized (WWW-Authenticate: Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource")`,
				);
			}
		},
		() => {},
		"gateway",
	);

	wizard.handleInput(DOWN);
	wizard.handleInput(ENTER);

	for (const char of `${origin}/mcp`) wizard.handleInput(char);
	wizard.handleInput(ENTER);

	await waitFor(() => oauthCalls.length === 1, "the first authorization");
	await waitFor(() => probeCount === 2, "the post-authorization health check");
	await Bun.sleep(1200);

	wizard.handleInput(ESCAPE);
	for (let i = 0; i < DISCOVERED_SCOPES.length; i++) wizard.handleInput(BACKSPACE);
	for (const char of CHOSEN_SCOPES) wizard.handleInput(char);
	wizard.handleInput(ENTER);

	await waitFor(() => oauthCalls.length === 2, "the second authorization");
	await Bun.sleep(1200);

	wizard.handleInput(ENTER);
	wizard.handleInput(ENTER);
	await waitFor(() => savedConfig !== null, "the wizard to save the server");

	expect(oauthCalls[0]).toEqual({ scopes: DISCOVERED_SCOPES, scopeOverride: undefined });
	expect(oauthCalls[1]).toEqual({ scopes: CHOSEN_SCOPES, scopeOverride: CHOSEN_SCOPES });
	expect((savedConfig as unknown as MCPServerConfig).oauth?.scopes).toBe(CHOSEN_SCOPES);
}, 30_000);

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}
