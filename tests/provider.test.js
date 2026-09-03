import { describe, it, expect, afterEach } from "vitest";
import {
	BRAVE_ENDPOINT,
	BRAVE_PROVIDER_ID,
	BraveSearchProvider,
	apply,
	mapBraveResponse,
	resolveBaseURL,
	withTimeout
} from "../lib/index.js";

/** Build a resolveOptions thunk for the provider, with sensible defaults. */
const braveOptions = (overrides = {}) => () => ({
	apiKey: undefined,
	envKey: "",
	hasCredentialResolver: false,
	resolveApiKey: undefined,
	apiKeyEnv: "BRAVE_API_KEY",
	baseURL: BRAVE_ENDPOINT,
	count: 10,
	safesearch: "moderate",
	textDecorations: false,
	searchTimeoutMs: 30000,
	...overrides
});

/** Minimal Response-like for a successful Brave body. */
const okResponse = (body) => ({
	ok: true,
	status: 200,
	json: async () => body
});

const BRAVE_BODY = {
	web: {
		results: [
			{ title: "Brave One", url: "https://x.com/1", description: "desc one", page_age: "2026-08-06T00:05:04" }
		]
	}
};

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("mapBraveResponse", () => {
	it("maps web.results with page_age as publishedAt", () => {
		const result = mapBraveResponse(BRAVE_BODY);
		expect(result.truncated).toBe(false);
		expect(result.sources[0]).toEqual({
			url: "https://x.com/1",
			title: "Brave One",
			snippet: "desc one",
			publishedAt: "2026-08-06T00:05:04"
		});
	});

	it("dedupes by url", () => {
		const result = mapBraveResponse({
			web: {
				results: [
					{ url: "https://x.com", title: "first" },
					{ url: "https://x.com", title: "dup" },
					{ url: "https://y.com" }
				]
			}
		});
		expect(result.sources).toHaveLength(2);
		expect(result.sources[0].title).toBe("first");
	});

	it("drops url-less entries and keeps optional fields absent", () => {
		const result = mapBraveResponse({
			web: { results: [{ title: "no url" }, { url: "https://y.com" }, { url: "" }] }
		});
		expect(result.sources).toEqual([{ url: "https://y.com" }]);
	});

	it("falls back to extra_snippets[0] when description is missing", () => {
		const result = mapBraveResponse({
			web: { results: [{ url: "https://x.com", extra_snippets: ["extra one", "extra two"] }] }
		});
		expect(result.sources[0].snippet).toBe("extra one");
	});

	it("keeps page_age only when it parses as a date", () => {
		const iso = mapBraveResponse({ web: { results: [{ url: "https://x.com", page_age: "2026-08-01T00:00:00" }] } });
		expect(iso.sources[0].publishedAt).toBe("2026-08-01T00:00:00");
		const human = mapBraveResponse({ web: { results: [{ url: "https://x.com", page_age: "2 hours ago" }] } });
		expect(human.sources[0].publishedAt).toBeUndefined();
	});

	it("treats an empty result list as a valid no-results outcome", () => {
		expect(mapBraveResponse({ web: { results: [] } })).toEqual({ sources: [], truncated: false });
	});

	it("throws WEB_PROVIDER_ERROR when the body is not a Brave web response", () => {
		for (const body of [{}, { web: null }, { web: { results: null } }, null, undefined]) {
			expect(() => mapBraveResponse(body)).toThrowError(expect.objectContaining({ code: "WEB_PROVIDER_ERROR" }));
		}
	});
});

describe("resolveBaseURL", () => {
	it("uses the official endpoint by default", () => {
		expect(resolveBaseURL(undefined, false)).toBe(BRAVE_ENDPOINT);
	});

	it("normalizes trailing slashes on the official endpoint", () => {
		expect(resolveBaseURL(BRAVE_ENDPOINT + "/", false)).toBe(BRAVE_ENDPOINT);
	});

	it("rejects a custom baseURL unless explicitly allowed", () => {
		expect(() => resolveBaseURL("https://evil.example.com", false)).toThrowError(
			expect.objectContaining({ code: "WEB_PROVIDER_ERROR" })
		);
	});

	it("rejects a non-https custom baseURL even when opted in", () => {
		expect(() => resolveBaseURL("http://evil.example.com", true)).toThrowError(/must be a parseable https URL/);
	});

	it("accepts an https custom baseURL when opted in", () => {
		expect(resolveBaseURL("https://mirror.example.com/search/", true)).toBe("https://mirror.example.com/search");
	});
});

describe("withTimeout", () => {
	it("passes the caller signal through when no timeout is set", () => {
		const controller = new AbortController();
		expect(withTimeout(controller.signal, 0)).toBe(controller.signal);
	});

	it("aborts with TimeoutError after the deadline", async () => {
		const signal = withTimeout(undefined, 20);
		expect(signal.aborted).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(signal.aborted).toBe(true);
		expect(signal.reason).toBeInstanceOf(DOMException);
		expect(signal.reason.name).toBe("TimeoutError");
	});

	it("propagates the caller's abort with its reason", async () => {
		const controller = new AbortController();
		const signal = withTimeout(controller.signal, 60000);
		controller.abort(new Error("caller cancelled"));
		expect(signal.aborted).toBe(true);
		expect(signal.reason?.message).toBe("caller cancelled");
	});
});

describe("BraveSearchProvider.available", () => {
	it("is false when no key is configured anywhere", () => {
		const p = new BraveSearchProvider(braveOptions());
		expect(p.available()).toBe(false);
	});

	it("is true with a literal config key", () => {
		const p = new BraveSearchProvider(braveOptions({ apiKey: "BSA-key" }));
		expect(p.available()).toBe(true);
	});

	it("is true with an environment key", () => {
		const p = new BraveSearchProvider(braveOptions({ envKey: "BSA-key" }));
		expect(p.available()).toBe(true);
	});

	it("is provisionally true when a credential resolver exists", () => {
		const p = new BraveSearchProvider(braveOptions({ hasCredentialResolver: true }));
		expect(p.available()).toBe(true);
	});

	it("never throws, even when the options thunk does", () => {
		const p = new BraveSearchProvider(() => {
			throw new Error("bad config");
		});
		expect(p.available()).toBe(false);
	});

	it("is false for a non-positive count", () => {
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k", count: 0 }));
		expect(p.available()).toBe(false);
	});
});

describe("BraveSearchProvider.search", () => {
	it("sends the token in a header and never in the URL", async () => {
		let seen;
		globalThis.fetch = async (url, init) => {
			seen = { url: String(url), init };
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ apiKey: "BSA-secret" }));
		const result = await p.search({ query: "hello world" });
		expect(seen.init.headers["x-subscription-token"]).toBe("BSA-secret");
		expect(seen.url).not.toContain("BSA-secret");
		expect(seen.url.startsWith(BRAVE_ENDPOINT + "?")).toBe(true);
		expect(result.sources[0].url).toBe("https://x.com/1");
	});

	it("encodes the query and applies default params", async () => {
		let url;
		globalThis.fetch = async (u) => {
			url = new URL(u);
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k", country: "cn", searchLang: "zh-hans", freshness: "pw" }));
		await p.search({ query: "深 seek & co" });
		expect(url.searchParams.get("q")).toBe("深 seek & co");
		expect(url.searchParams.get("count")).toBe("10");
		expect(url.searchParams.get("safesearch")).toBe("moderate");
		expect(url.searchParams.get("text_decorations")).toBe("false");
		expect(url.searchParams.get("country")).toBe("cn");
		expect(url.searchParams.get("search_lang")).toBe("zh-hans");
		expect(url.searchParams.get("freshness")).toBe("pw");
	});

	it("caps the request at the API maximum when the configured count allows it", async () => {
		let url;
		globalThis.fetch = async (u) => {
			url = new URL(u);
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k", count: 20 }));
		await p.search({ query: "x", maxResults: 50 });
		expect(url.searchParams.get("count")).toBe("20");
	});

	it("never asks for more than the configured count, even when maxResults allows it", async () => {
		let url;
		globalThis.fetch = async (u) => {
			url = new URL(u);
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k", count: 5 }));
		await p.search({ query: "x", maxResults: 15 });
		expect(url.searchParams.get("count")).toBe("5");
	});

	it("shrinks count to the caller's maxResults when smaller", async () => {
		let url;
		globalThis.fetch = async (u) => {
			url = new URL(u);
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k" }));
		await p.search({ query: "x", maxResults: 3 });
		expect(url.searchParams.get("count")).toBe("3");
	});

	it("resolves the key through resolveApiKey when no literal key is set", async () => {
		let seen;
		globalThis.fetch = async (u, init) => {
			seen = init;
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ resolveApiKey: async () => "BSA-from-store" }));
		await p.search({ query: "x" });
		expect(seen.headers["x-subscription-token"]).toBe("BSA-from-store");
	});

	it("prefers the literal key over the resolver", async () => {
		let seen;
		globalThis.fetch = async (u, init) => {
			seen = init;
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ apiKey: "BSA-literal", resolveApiKey: async () => "BSA-from-store" }));
		await p.search({ query: "x" });
		expect(seen.headers["x-subscription-token"]).toBe("BSA-literal");
	});

	it("fails with WEB_PROVIDER_CREDENTIAL_MISSING when no key resolves", async () => {
		const p = new BraveSearchProvider(braveOptions({ resolveApiKey: async () => undefined }));
		await expect(p.search({ query: "x" })).rejects.toMatchObject({ code: "WEB_PROVIDER_CREDENTIAL_MISSING" });
	});

	it("fails fast with WEB_ABORTED on an already-aborted signal, without fetching", async () => {
		let fetched = false;
		globalThis.fetch = async () => {
			fetched = true;
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k" }));
		await expect(p.search({ query: "x" }, AbortSignal.abort())).rejects.toMatchObject({ code: "WEB_ABORTED" });
		expect(fetched).toBe(false);
	});

	it("maps a hard timeout to WEB_PROVIDER_ERROR with a timeout message", async () => {
		globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
		});
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k", searchTimeoutMs: 30 }));
		await expect(p.search({ query: "x" })).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
			message: expect.stringMatching(/timed out after 30ms/)
		});
	});

	it("prefers WEB_ABORTED when the caller aborts mid-flight", async () => {
		const controller = new AbortController();
		globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
		});
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k", searchTimeoutMs: 30000 }));
		const pending = p.search({ query: "x" }, controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "WEB_ABORTED" });
	});

	it("surfaces the provider error detail on HTTP failures", async () => {
		globalThis.fetch = async () => ({
			ok: false,
			status: 429,
			json: async () => ({ error: { message: "rate limited" } })
		});
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k" }));
		await expect(p.search({ query: "x" })).rejects.toMatchObject({ code: "WEB_PROVIDER_ERROR", message: "rate limited" });
	});

	it("falls back to the status line when the error body is not JSON", async () => {
		globalThis.fetch = async () => ({
			ok: false,
			status: 502,
			json: async () => {
				throw new SyntaxError("not json");
			}
		});
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k" }));
		await expect(p.search({ query: "x" })).rejects.toMatchObject({ message: "Brave Search API error (HTTP 502)" });
	});

	it("surfaces a config error at search time without fetching", async () => {
		// available() already reads a throwing options thunk as "unavailable";
		// search() must propagate the precise error instead.
		let fetched = false;
		globalThis.fetch = async () => {
			fetched = true;
			return okResponse(BRAVE_BODY);
		};
		const bad = new BraveSearchProvider(() => {
			throw Object.assign(new Error("custom baseURL is not allowed"), { code: "WEB_PROVIDER_ERROR" });
		});
		expect(bad.available()).toBe(false);
		await expect(bad.search({ query: "x" })).rejects.toMatchObject({ code: "WEB_PROVIDER_ERROR" });
		expect(fetched).toBe(false);
	});

	it("sends requests through a proxy dispatcher when proxy is configured", async () => {
		let seen;
		globalThis.fetch = async (u, init) => {
			seen = init;
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k", proxy: "http://127.0.0.1:7890" }));
		await p.search({ query: "x" });
		expect(seen.dispatcher).toBeDefined();
		await seen.dispatcher.close?.();
	});

	it("reuses the cached dispatcher for an unchanged proxy", async () => {
		const seen = [];
		globalThis.fetch = async (u, init) => {
			seen.push(init);
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k", proxy: "http://127.0.0.1:7890" }));
		await p.search({ query: "a" });
		await p.search({ query: "b" });
		expect(seen[0].dispatcher).toBe(seen[1].dispatcher);
		await seen[0].dispatcher.close?.();
	});

	it("omits the dispatcher when no proxy is configured", async () => {
		let seen;
		globalThis.fetch = async (u, init) => {
			seen = init;
			return okResponse(BRAVE_BODY);
		};
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k" }));
		await p.search({ query: "x" });
		expect(seen.dispatcher).toBeUndefined();
	});

	it("records the endpoint through recordRequest", async () => {
		const recorded = [];
		globalThis.fetch = async () => okResponse(BRAVE_BODY);
		const p = new BraveSearchProvider(braveOptions({ apiKey: "k", recordRequest: (r) => recorded.push(r) }));
		await p.search({ query: "x" });
		expect(recorded).toHaveLength(1);
		expect(recorded[0].endpoint.startsWith(BRAVE_ENDPOINT + "?")).toBe(true);
	});
});

describe("apply", () => {
	/** Minimal cordis-like context double for registration/sync behavior. */
	function mockCtx({ withSettings = true, credentials } = {}) {
		const registered = [];
		const watchers = [];
		let source;
		const ctx = {
			// dsh-settings' isUnloading reads the consumer fiber's state; any
			// state other than UNLOADING(4)/DISPOSED(5) keeps the wiring live.
			fiber: { state: 0 },
			get(name) {
				if (name === "credentials") return credentials;
				return undefined;
			},
			web: {
				registerSearchProvider(provider) {
					registered.push(provider);
					return () => {
						const index = registered.indexOf(provider);
						if (index >= 0) registered.splice(index, 1);
					};
				}
			},
			inject(services, callback) {
				if (!withSettings && services.includes("settings")) return;
				callback(sctx);
			}
		};
		const sctx = {
			settings: {
				register(ns, schema, { base }) {
					source = base;
					return {
						get: () => source,
						watch: (listener) => watchers.push(listener)
					};
				}
			},
			effect() {}
		};
		return {
			ctx,
			registered,
			updateSource(value) {
				source = value;
				for (const listener of watchers) listener();
			}
		};
	}

	it("registers one provider under the stable id", () => {
		const { ctx, registered } = mockCtx();
		apply(ctx, {});
		expect(registered).toHaveLength(1);
		expect(registered[0].id).toBe(BRAVE_PROVIDER_ID);
	});

	it("registers even without a settings service (composition config)", () => {
		const { ctx, registered } = mockCtx({ withSettings: false });
		apply(ctx, { apiKey: "k" });
		expect(registered).toHaveLength(1);
	});

	it("unregisters when enabled flips to false and re-registers on true", () => {
		const { ctx, registered, updateSource } = mockCtx();
		apply(ctx, {});
		expect(registered).toHaveLength(1);
		updateSource({ enabled: false });
		expect(registered).toHaveLength(0);
		updateSource({ enabled: true });
		expect(registered).toHaveLength(1);
	});

	it("re-registers exactly once per settings change (no duplicates)", () => {
		const { ctx, registered, updateSource } = mockCtx();
		apply(ctx, {});
		updateSource({ count: 5 });
		expect(registered).toHaveLength(1);
		updateSource({ count: 8 });
		expect(registered).toHaveLength(1);
	});
});
