import { describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { createConfiguredOAuthProvider } from "@oh-my-pi/pi-ai/oauth/configured";
import type { OAuthAuthInfo } from "@oh-my-pi/pi-ai/oauth/types";

function config(fetchImpl: FetchImpl) {
	return {
		name: "Configured OAuth",
		clientId: "client-id",
		clientSecret: "client-secret",
		authorizationUrl: "https://accounts.example.com/oauth/authorize",
		tokenUrl: "https://accounts.example.com/oauth/token",
		scopes: ["openid", "email"],
		callbackPort: 0,
		useIdToken: true,
		authorizationParams: { access_type: "offline", prompt: "consent" },
		fetch: fetchImpl,
	};
}

describe("configured provider OAuth", () => {
	it("runs authorization-code PKCE login and returns the configured token field", async () => {
		let authInfo: OAuthAuthInfo | undefined;
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
			expect(body.get("client_secret")).toBe("client-secret");
			expect(body.get("code_verifier")).toBeTruthy();
			return Response.json({ id_token: "id-token", refresh_token: "refresh-token", expires_in: 3600 });
		});
		const provider = createConfiguredOAuthProvider("custom", config(fetchMock));
		const login = provider.login({
			onAuth(info) {
				authInfo = info;
				const authorize = new URL(info.url);
				expect(authorize.searchParams.get("client_id")).toBe("client-id");
				expect(authorize.searchParams.get("scope")).toBe("openid email");
				expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
				expect(authorize.searchParams.get("access_type")).toBe("offline");
				void fetch(
					`${authorize.searchParams.get("redirect_uri")}?code=auth-code&state=${authorize.searchParams.get("state")}`,
				);
			},
			onPrompt: async () => "",
			fetch: fetchMock,
		});

		const credentials = await login;
		expect(authInfo?.launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/launch$/);
		expect(credentials.access).toBe("id-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("refreshes tokens and retains the prior refresh token when rotation omits one", async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("refresh-old");
			return Response.json({ id_token: "id-new", expires_in: "7200" });
		});
		const provider = createConfiguredOAuthProvider("custom", config(fetchMock));
		const credentials = await provider.refreshToken({ access: "id-old", refresh: "refresh-old", expires: 1 });
		expect(credentials.access).toBe("id-new");
		expect(credentials.refresh).toBe("refresh-old");
		expect(provider.getApiKey(credentials)).toBe("id-new");
	});

	it("treats a token without expires_in as non-expiring", async () => {
		const fetchMock = vi.fn(async () => Response.json({ id_token: "id-new", refresh_token: "refresh-new" }));
		const provider = createConfiguredOAuthProvider("custom", config(fetchMock));
		const credentials = await provider.refreshToken({ access: "id-old", refresh: "refresh-old", expires: 1 });
		expect(credentials.expires).toBe(8.64e15);
	});

	it("keeps protocol parameters authoritative over custom params", async () => {
		let requestBody = "";
		let authorizationUrl = "";
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			requestBody = String(init?.body);
			return Response.json({ id_token: "id-token", refresh_token: "refresh-token", expires_in: 3600 });
		});
		const provider = createConfiguredOAuthProvider("custom", {
			...config(fetchMock),
			authorizationParams: { state: "overridden", redirect_uri: "https://bad.example/callback" },
			tokenParams: { code: "overridden", grant_type: "bad" },
		});
		await provider.login({
			onAuth(info) {
				authorizationUrl = info.url;
				const url = new URL(info.url);
				void fetch(`${url.searchParams.get("redirect_uri")}?code=real-code&state=${url.searchParams.get("state")}`);
			},
			onPrompt: async () => "",
		});
		const authorization = new URL(authorizationUrl);
		expect(authorization.searchParams.get("state")).not.toBe("overridden");
		expect(authorization.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		const token = new URLSearchParams(requestBody);
		expect(token.get("code")).toBe("real-code");
		expect(token.get("grant_type")).toBe("authorization_code");
	});
});
