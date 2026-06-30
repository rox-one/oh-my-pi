import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { AuthStorage, type FetchImpl, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchDuckDuckGo } from "@oh-my-pi/pi-coding-agent/web/search/providers/duckduckgo";
import { applyQueryConstraints, parseSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search/query";

function duckResult(index: number): string {
	return `<div class="result results_links"><a class="result__a" href="https://example.com/${index}">Result ${index}</a><a class="result__snippet">Snippet ${index}</a></div>`;
}

function duckPage(indices: readonly number[], continuation = false): string {
	const results = indices.map(duckResult).join("\n");
	if (!continuation) return results;
	return `${results}
		<div class="nav-link">
			<form action="/html/" method="post">
				<input type="submit" class="btn btn--alt" value="Next" />
				<input type="hidden" name="q" value="open source software" />
				<input value="10" type="hidden" name="s" />
				<input type="hidden" name="nextParams" value="" />
				<input type="hidden" name="v" value="l" />
				<input type="hidden" name="o" value="json" />
				<input type="hidden" name="dc" value="11" />
				<input type="hidden" name="api" value="d.js" />
				<input value="test-vqd" name="vqd" type="hidden" />
				<input name="kl" value="us-en" type="hidden" />
			</form>
		</div>`;
}

describe("DuckDuckGo web search pagination", () => {
	it("submits the returned continuation form to satisfy a 20-result limit", async () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		const requests: URLSearchParams[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			expect(init?.method).toBe("POST");
			const body = new URLSearchParams(String(init?.body));
			requests.push(body);
			const html =
				requests.length === 1
					? duckPage([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], true)
					: duckPage([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
			return new Response(html, { status: 200 });
		};

		await searchDuckDuckGo({ ...makeParams("how to fix bug in code", fetchMock), recency: "week" });

		expect(captured.url).toBe("https://html.duckduckgo.com/html/");
		expect(capturedInit?.method).toBe("POST");
		const form = new URLSearchParams(capturedInit?.body as string);
		expect(form.get("q")).toBe("how to fix bug in code");
		expect(form.get("kl")).toBe("us-en");
		expect(form.get("b")).toBe("");
		expect(form.get("df")).toBe("w");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
		expect(headers["User-Agent"]).toContain("Mozilla/5.0");
		expect(headers.Referer).toBe("https://html.duckduckgo.com/");
		expect(headers["Accept-Language"]).toContain("en");
		expect(headers["Sec-Fetch-Mode"]).toBe("navigate");
		expect(headers["Sec-Ch-Ua"]).toContain("Chromium");
	});

	it("omits the df form param when no recency is requested", async () => {
		let capturedInit: RequestInit | undefined;
		const fetchMock: FetchImpl = (_input, init) => {
			capturedInit = init;
			return Promise.resolve(
				new Response(htmlPage({ url: "https://example.com/x", title: "X" }), {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);
		};

		await searchDuckDuckGo(makeParams("plain query", fetchMock));

		const form = new URLSearchParams(capturedInit?.body as string);
		expect(form.has("df")).toBe(false);
	});

	it("parses result blocks, unwraps DDG redirect URLs, and clamps to numSearchResults", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(
					htmlPage(
						{
							url: "https://example.com/first",
							title: "First &amp; result",
							snippet: "Snippet <b>one</b>",
						},
						{ url: "https://example.com/second", title: "Second" },
						{ url: "https://example.com/third", title: "Third" },
					),
					{ status: 200, headers: { "Content-Type": "text/html" } },
				),
			);

		const response = await searchDuckDuckGo({ ...makeParams("multi", fetchMock), numSearchResults: 2 });

		expect(response.provider).toBe("duckduckgo");
		expect(response.answer).toBeUndefined();
		expect(response.sources).toEqual([
			{
				title: "First & result",
				url: "https://example.com/first",
				snippet: "Snippet one",
			},
			{
				title: "Second",
				url: "https://example.com/second",
				snippet: undefined,
			},
		]);
	});

	it("deduplicates results that share the same target URL", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(
					htmlPage(
						{ url: "https://example.com/dup", title: "First copy", snippet: "one" },
						{ url: "https://example.com/dup", title: "Second copy", snippet: "two" },
						{ url: "https://example.com/unique", title: "Other" },
					),
					{ status: 200, headers: { "Content-Type": "text/html" } },
				),
			);

		const response = await searchDuckDuckGo(makeParams("dup query", fetchMock));

		expect(response.sources.map(s => s.url)).toEqual(["https://example.com/dup", "https://example.com/unique"]);
	});

	it("clamps oversized result limits to the provider maximum", async () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			url: `https://example.com/r-${i}`,
			title: `Result ${i}`,
		}));
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(htmlPage(...many), {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);

		const response = await searchDuckDuckGo({ ...makeParams("clamp", fetchMock), numSearchResults: 999 });

		expect(response.sources).toHaveLength(20);
		expect(response.sources.at(0)?.url).toBe("https://example.com/r-0");
		expect(response.sources.at(-1)?.url).toBe("https://example.com/r-19");
	});

	it("supports unwrapped result hrefs (sponsored/instant rows)", async () => {
		const html = `<div class="result"><h2 class="result__title">
			<a class="result__a" href="https://direct.example/page">Direct</a>
		</h2></div>`;
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }));

		const response = await searchDuckDuckGo(makeParams("direct", fetchMock));

		expect(response.sources).toEqual([{ title: "Direct", url: "https://direct.example/page", snippet: undefined }]);
	});

	it("throws a clear SearchProviderError when DDG serves the anomaly modal", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(anomalyPage(), {
					status: 202,
					headers: { "Content-Type": "text/html" },
				}),
			);

		try {
			const response = await searchDuckDuckGo({
				query: "open source software",
				limit: 20,
				systemPrompt: "Test DuckDuckGo search",
				authStorage,
				fetch: fetchMock,
			});

			expect(requests).toHaveLength(2);
			expect(Object.fromEntries(requests[0])).toEqual({ q: "open source software", kl: "us-en", b: "" });
			expect(Object.fromEntries(requests[1])).toEqual({
				q: "open source software",
				s: "10",
				nextParams: "",
				v: "l",
				o: "json",
				dc: "11",
				api: "d.js",
				vqd: "test-vqd",
				kl: "us-en",
			});
			expect(response.provider).toBe("duckduckgo");
			expect(response.sources).toHaveLength(20);
			expect(response.sources[0]?.url).toBe("https://example.com/0");
			expect(response.sources.at(-1)?.url).toBe("https://example.com/19");
		} finally {
			authStorage.close();
		}
	});
});

const sharedAuthStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
afterAll(() => sharedAuthStorage.close());

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage: sharedAuthStorage,
		systemPrompt: "DuckDuckGo search test prompt",
		fetch,
	};
}

/** One result block in the shape DuckDuckGo's no-JS HTML page renders live. */
function resultBlock(
	url: string,
	title: string,
	snippet: string,
	timestamp?: string,
	snippetTag: "a" | "span" = "a",
): string {
	return `
		<div class="result results_links results_links_deep web-result ">
			<div class="links_main links_deep result__body">
				<h2 class="result__title">
					<a rel="nofollow" class="result__a" href="${url}">${title}</a>
				</h2>
				<div class="result__extras">
					<div class="result__extras__url">
						<span class="result__icon">
							<a rel="nofollow" href="${url}"><img class="result__icon__img" width="16" height="16" alt="" src="//external-content.duckduckgo.com/ip3/example.ico" name="i15" /></a>
						</span>
						<a class="result__url" href="${url}">${url}</a>
						${timestamp ? `<span>&nbsp; &nbsp; ${timestamp}</span>` : ""}
					</div>
				</div>
				<${snippetTag} class="result__snippet" href="${url}">${snippet}</${snippetTag}>
				<div class="clear"></div>
			</div>
		</div>`;
}

function resultsPage(blocks: string): string {
	return `<!DOCTYPE html><html><body><div id="links" class="results">${blocks}<div class="nav-link"></div></div></body></html>`;
}

describe("DuckDuckGo web search provider", () => {
	it("extracts result timestamps into publishedDate/ageSeconds so date bounds can be enforced", async () => {
		const html = resultsPage(
			[
				resultBlock("https://example.com/fresh", "Fresh page", "A recent article.", "2026-07-30T20:19:00.0000000"),
				resultBlock("https://example.com/undated", "Undated page", "No timestamp here."),
			].join(""),
		);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchDuckDuckGo(makeParams("weather", fetchMock));

		expect(response.provider).toBe("duckduckgo");
		expect(response.sources).toHaveLength(2);

		const dated = response.sources[0];
		expect(dated.url).toBe("https://example.com/fresh");
		expect(dated.publishedDate).toBe("2026-07-30T20:19:00.0000000");
		expect(dated.ageSeconds).toBeGreaterThan(0);

		const undated = response.sources[1];
		expect(undated.url).toBe("https://example.com/undated");
		expect(undated.publishedDate).toBeUndefined();
		expect(undated.ageSeconds).toBeUndefined();
	});

	it("does not mistake a date-leading span snippet for a publication timestamp", async () => {
		const html = resultsPage(
			resultBlock("https://example.com/undated-span", "Undated span result", "2020-01-02", undefined, "span"),
		);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchDuckDuckGo(makeParams("history", fetchMock));

		expect(response.sources[0].publishedDate).toBeUndefined();
		expect(response.sources[0].ageSeconds).toBeUndefined();
	});

	it("honors after:/before: bounds against DuckDuckGo's extracted timestamps", async () => {
		const html = resultsPage(
			[
				resultBlock(
					"https://example.com/in-range",
					"In range",
					"Within the window.",
					"2026-07-10T09:00:00.0000000",
				),
				resultBlock(
					"https://example.com/too-new",
					"Too new",
					"After the window ends.",
					"2026-07-30T09:00:00.0000000",
				),
				resultBlock("https://example.com/undated", "Undated", "No timestamp, cannot prove violation."),
			].join(""),
		);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const query = "weather after:2026-07-01 before:2026-07-15";
		const response = await searchDuckDuckGo(makeParams(query, fetchMock));
		const { sources } = applyQueryConstraints(response.sources, parseSearchQuery(query));

		const urls = sources.map(s => s.url);
		expect(urls).toContain("https://example.com/in-range");
		expect(urls).toContain("https://example.com/undated");
		expect(urls).not.toContain("https://example.com/too-new");
	});
});
