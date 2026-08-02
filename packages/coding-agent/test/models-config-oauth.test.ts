import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { getOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "configured-oauth";

async function writeModelsConfig(tempDir: TempDir, clientSecret = "secret-literal") {
	await Bun.write(
		path.join(tempDir.path(), "models.yml"),
		`providers:\n  ${PROVIDER}:\n    baseUrl: https://api.example.com/v1\n    api: openai-completions\n    authHeader: true\n    oauth:\n      name: Configured OAuth\n      clientId: client-id\n      clientSecret: ${clientSecret}\n      authorizationUrl: https://accounts.example.com/oauth/authorize\n      tokenUrl: https://accounts.example.com/oauth/token\n      scopes: [openid, email]\n      callbackPort: 0\n    models:\n      - id: configured-model\n        name: Configured Model\n        reasoning: false\n        input: [text]\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n        contextWindow: 128000\n        maxTokens: 32000\n`,
	);
}

afterEach(() => {
	delete Bun.env.CONFIGURED_OAUTH_SECRET;
});

describe("models.yml provider OAuth", () => {
	test("registers OAuth and permits custom models without apiKey", async () => {
		const tempDir = TempDir.createSync("@models-config-oauth-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			await writeModelsConfig(tempDir);
			const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
			expect(registry.getError()).toBeUndefined();
			expect(registry.find(PROVIDER, "configured-model")).toBeDefined();
			expect(getOAuthProvider(PROVIDER)?.name).toBe("Configured OAuth");
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	test("removes configured OAuth registration after config deletion", async () => {
		const tempDir = TempDir.createSync("@models-config-oauth-reload-");
		const authStorage = await AuthStorage.create(":memory:");
		const modelsPath = path.join(tempDir.path(), "models.yml");
		try {
			await writeModelsConfig(tempDir);
			const registry = new ModelRegistry(authStorage, modelsPath);
			expect(getOAuthProvider(PROVIDER)).toBeDefined();
			await Bun.write(modelsPath, "providers: {}\n");
			await registry.refresh("offline");
			expect(getOAuthProvider(PROVIDER)).toBeUndefined();
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	test("replaces only the colliding provider across model registries", async () => {
		const firstDir = TempDir.createSync("@models-config-oauth-first-");
		const secondDir = TempDir.createSync("@models-config-oauth-second-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			await writeModelsConfig(firstDir);
			const firstPath = path.join(firstDir.path(), "models.yml");
			const firstText = await Bun.file(firstPath).text();
			await Bun.write(
				firstPath,
				`${firstText}\n  unrelated-oauth:\n    baseUrl: https://api.example.com/v1\n    api: openai-completions\n    oauth:\n      name: Unrelated OAuth\n      clientId: client-id\n      authorizationUrl: https://accounts.example.com/oauth/authorize\n      tokenUrl: https://accounts.example.com/oauth/token\n      scopes: [openid]\n      callbackPort: 0\n`,
			);
			new ModelRegistry(authStorage, firstPath);
			expect(getOAuthProvider("unrelated-oauth")).toBeDefined();
			await writeModelsConfig(secondDir);
			new ModelRegistry(authStorage, path.join(secondDir.path(), "models.yml"));
			expect(getOAuthProvider(PROVIDER)).toBeDefined();
			expect(getOAuthProvider("unrelated-oauth")).toBeDefined();
		} finally {
			authStorage.close();
			await Promise.all([firstDir.remove(), secondDir.remove()]);
		}
	});

	test("resolves OAuth client secrets from environment variables", async () => {
		const tempDir = TempDir.createSync("@models-config-oauth-env-");
		const authStorage = await AuthStorage.create(":memory:");
		Bun.env.CONFIGURED_OAUTH_SECRET = "resolved-secret";
		try {
			await writeModelsConfig(tempDir, "CONFIGURED_OAUTH_SECRET");
			new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
			const provider = getOAuthProvider(PROVIDER);
			expect(provider).toBeDefined();
			let authorizationUrl = "";
			const login = provider!.login({
				onAuth(info) {
					authorizationUrl = info.url;
					const url = new URL(info.url);
					void fetch(`${url.searchParams.get("redirect_uri")}?code=code&state=${url.searchParams.get("state")}`);
				},
				onPrompt: async () => "",
				fetch: async (_input, init) => {
					const body = new URLSearchParams(String(init?.body));
					expect(body.get("client_secret")).toBe("resolved-secret");
					return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
				},
			});
			await login;
			expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("client-id");
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});
});
