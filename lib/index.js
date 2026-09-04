import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

/**
 * Brave Search API-backed web search provider for the DeepSeek Harness web
 * capability seam (`ctx.web`). Calls the official Brave Search REST endpoint
 * (`GET https://api.search.brave.com/res/v1/web/search`) with an
 * `X-Subscription-Token` header and maps `web.results[]` into the seam's
 * normalized `WebSearchResult` shape. One search is one HTTP request — no
 * model turn.
 *
 * Security posture:
 * - The subscription token is only ever sent to the Brave endpoint, in a
 *   request header (never in the URL, never logged).
 * - `baseURL` is pinned to the official endpoint; a custom endpoint requires
 *   an explicit `allowCustomBaseURL: true` opt-in and must use https, so a
 *   config injection cannot silently redirect the token to another host.
 * - Every request carries a hard timeout (`searchTimeoutMs`) in addition to
 *   the caller's abort signal.
 * @module @huohua-dev/dsh-web-search-brave/provider
 */

/** Stable id this provider registers under. */
const BRAVE_PROVIDER_ID = "brave";
/** Official Brave Search API web endpoint (the only one allowed by default). */
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
/** Default result count requested from the API per search. */
const BRAVE_DEFAULT_COUNT = 10;
/** Maximum `count` the Brave Search API accepts for web results. */
const BRAVE_MAX_COUNT = 20;
/** Default per-request timeout, below the harness tool deadline (60 s). */
const DEFAULT_SEARCH_TIMEOUT_MS = 30000;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = "dsh-web-search-brave/0.1.0";

/**
 * Map a Brave Search API response to a normalized search result. Walks
 * `web.results[]`, joins `description` / first `extra_snippets` entry as the
 * snippet, keeps `page_age` as `publishedAt` when it parses as a date, and
 * dedupes by `url`. An empty result list is a valid "no results" outcome; a
 * missing/malformed list is an error. The web service owns the final
 * `maxResults` truncation, so `truncated` is always `false` here.
 *
 * @param body - the parsed Brave Search API response body.
 * @returns the normalized result with deduped sources.
 * @throws {@link WebError} when the body is not a Brave web search response.
 */
function mapBraveResponse(body) {
	const results = body?.web?.results;
	if (!Array.isArray(results)) {
		throw new WebError("Brave returned no web.results array; the response body is not a Brave Search API web response", "WEB_PROVIDER_ERROR");
	}
	const seen = new Set();
	const sources = [];
	for (const item of results) {
		if (item == null || typeof item.url !== "string" || item.url.length === 0 || seen.has(item.url)) continue;
		seen.add(item.url);
		const snippet = typeof item.description === "string" && item.description.length > 0
			? item.description
			: Array.isArray(item.extra_snippets) && typeof item.extra_snippets[0] === "string" && item.extra_snippets[0].length > 0
				? item.extra_snippets[0]
				: undefined;
		sources.push({
			url: item.url,
			...typeof item.title === "string" && item.title.length > 0 ? { title: item.title } : {},
			...snippet !== undefined ? { snippet } : {},
			...typeof item.page_age === "string" && item.page_age.length > 0 && !Number.isNaN(Date.parse(item.page_age))
				? { publishedAt: item.page_age }
				: {}
		});
	}
	return { sources, truncated: false };
}

/**
 * Resolve the endpoint, enforcing the anti-exfiltration whitelist: only the
 * official Brave endpoint is used unless `allowCustomBaseURL` is set, and a
 * custom endpoint must still use https. The subscription token rides every
 * request in a header, so the endpoint it is sent to is security-critical.
 *
 * @param baseURL - the configured endpoint, or undefined for the official one.
 * @param allowCustom - explicit opt-in for non-official endpoints.
 * @returns the canonical endpoint URL (no trailing slash).
 * @throws {@link WebError} when a custom endpoint is not opted in or not https.
 */
function resolveBaseURL(baseURL, allowCustom) {
	const canonical = (baseURL ?? BRAVE_ENDPOINT).replace(/\/+$/u, "");
	if (canonical === BRAVE_ENDPOINT) return canonical;
	if (allowCustom !== true) {
		throw new WebError(
			`custom baseURL ${JSON.stringify(canonical)} is not allowed; only the official ${BRAVE_ENDPOINT} is permitted unless allowCustomBaseURL: true`,
			"WEB_PROVIDER_ERROR"
		);
	}
	if (!/^https:\/\//u.test(canonical) || !URL.canParse(canonical)) {
		throw new WebError(`custom baseURL must be a parseable https URL, got ${JSON.stringify(canonical)}`, "WEB_PROVIDER_ERROR");
	}
	return canonical;
}

/**
 * Merge an upstream AbortSignal with a hard timeout: either source cancels
 * the request. A timeout aborts with a `TimeoutError` reason; a caller
 * cancellation keeps the caller's reason.
 *
 * @param signal - the caller's abort signal, if any.
 * @param timeoutMs - the hard deadline; non-positive disables the timeout.
 * @returns the composite signal, or the caller's signal unchanged.
 */
function withTimeout(signal, timeoutMs) {
	if (timeoutMs == null || timeoutMs <= 0) return signal;
	const sources = [AbortSignal.timeout(timeoutMs)];
	if (signal !== undefined) sources.unshift(signal);
	return AbortSignal.any(sources);
}

/**
 * Load undici's ProxyAgent lazily. Proxy support is the only feature that
 * needs a runtime dependency beyond schemastery, so the import is deferred:
 * users without a proxy never pay for it, and `optionalDependencies` covers
 * users who do.
 *
 * @returns the ProxyAgent constructor.
 * @throws {@link WebError} when undici is not installed.
 */
async function loadProxyAgent() {
	try {
		return (await import("undici")).ProxyAgent;
	} catch (error) {
		throw new WebError("a proxy is configured but the \"undici\" package is unavailable; reinstall the plugin (undici is an optional dependency) or clear the proxy setting", "WEB_PROVIDER_ERROR", { cause: error });
	}
}

/** The Brave Search API-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
class BraveSearchProvider {
	resolveOptions;
	cachedProxy;
	cachedDispatcher;
	id = BRAVE_PROVIDER_ID;
	/**
	 * @param resolveOptions - the options for the NEXT operation, snapshotted
	 * once at each operation's entry so one search never mixes two sections. A
	 * thunk rather than a value because the plugin's settings section can
	 * change between searches without re-registering the provider.
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}
	/**
	 * Synchronous usability check. Must not throw (the seam calls it without
	 * a guard during provider selection) and must not make network calls: an
	 * invalid config reads as "unavailable", and the precise error surfaces at
	 * search time instead. A present credential resolver makes the provider
	 * provisionally usable — the key itself resolves asynchronously at search
	 * time, where a precise `WEB_PROVIDER_CREDENTIAL_MISSING` can be raised.
	 */
	available() {
		let options;
		try {
			options = this.resolveOptions();
		} catch {
			return false;
		}
		return ((options.apiKey?.length ?? 0) > 0 || options.envKey.length > 0 || options.hasCredentialResolver)
			&& isPositiveInteger(options.count);
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		const apiKey = await this.apiKey(options, signal);
		throwIfSearchAborted(signal);
		// Apply the caller's bound at the request layer as a cost/latency
		// optimization (never exceeding the configured count or the API cap);
		// the seam enforces the bound regardless.
		const requested = isPositiveInteger(request.maxResults) ? Math.min(request.maxResults, options.count) : options.count;
		const count = Math.min(Math.max(1, requested), BRAVE_MAX_COUNT);
		const params = new URLSearchParams();
		params.set("q", request.query);
		params.set("count", String(count));
		params.set("safesearch", options.safesearch);
		// text_decorations adds <b> highlight markers to snippets; the seam
		// renders raw text, so keep snippets clean unless configured otherwise.
		params.set("text_decorations", String(options.textDecorations));
		if (options.country != null && options.country.length > 0) params.set("country", options.country);
		if (options.searchLang != null && options.searchLang.length > 0) params.set("search_lang", options.searchLang);
		if (options.freshness != null && options.freshness.length > 0) params.set("freshness", options.freshness);
		const endpoint = `${options.baseURL}?${params.toString()}`;
		options.recordRequest?.({ endpoint });
		throwIfSearchAborted(signal);
		const dispatcher = await this.dispatcher(options);
		const effectiveSignal = withTimeout(signal, options.searchTimeoutMs);
		let response;
		try {
			response = await fetch(endpoint, {
				method: "GET",
				redirect: "error",
				headers: {
					"x-subscription-token": apiKey,
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				...effectiveSignal !== undefined ? { signal: effectiveSignal } : {},
				...dispatcher !== undefined ? { dispatcher } : {}
			});
		} catch (error) {
			// A caller cancellation wins over the timeout when both race.
			if (signal?.aborted === true) throw searchAborted(signal, error);
			if (isTimeoutError(error)) {
				throw new WebError(`Brave search timed out after ${options.searchTimeoutMs}ms`, "WEB_PROVIDER_ERROR", { cause: error });
			}
			if (isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Brave search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			throw new WebError(await apiErrorMessage(response, "Brave"), "WEB_PROVIDER_ERROR");
		}
		try {
			return mapBraveResponse(await response.json());
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (error instanceof WebError) throw error;
			throw new WebError(`Brave returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
	/**
	 * Resolve one operation's credential without retaining it on the provider.
	 * @param options - the caller's snapshot, so the key and the endpoint it is
	 *   sent to come from one section.
	 * @param signal - abort signal for the surrounding search.
	 * @returns the resolved key.
	 */
	async apiKey(options, signal) {
		throwIfSearchAborted(signal);
		if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Brave search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (resolved !== undefined && resolved.length > 0) return resolved;
		throw new WebError(
			`Brave search has no API key for "${options.apiKeyEnv}": add "${options.apiKeyEnv}: <token>" to $DSH_HOME/.credentials.yaml, export ${options.apiKeyEnv} in the launching environment, or set a literal "apiKey" in the plugin config`,
			"WEB_PROVIDER_CREDENTIAL_MISSING"
		);
	}
	/**
	 * Return a cached undici ProxyAgent for the current proxy URL, or undefined
	 * when no proxy is configured. The agent is reused across searches for
	 * connection pooling; a changed proxy URL replaces the previous agent. DNS
	 * for the target then resolves through the proxy, which sidesteps polluted
	 * resolvers that would otherwise fail the connection.
	 * @param options - the caller's snapshot.
	 * @returns the dispatcher, or undefined for a direct connection.
	 */
	async dispatcher(options) {
		const proxy = options.proxy;
		if (proxy === undefined || proxy.length === 0) return undefined;
		if (this.cachedProxy === proxy) return this.cachedDispatcher;
		const ProxyAgent = await loadProxyAgent();
		if (this.cachedDispatcher !== undefined) {
			this.cachedDispatcher.close?.().catch(() => {});
		}
		this.cachedProxy = proxy;
		this.cachedDispatcher = new ProxyAgent(proxy);
		return this.cachedDispatcher;
	}
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable(operation, signal) {
	if (signal === undefined) return operation;
	if (signal.aborted) return Promise.reject(searchAborted(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(searchAborted(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
		});
	});
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("Brave search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/** True for an `AbortSignal.timeout` rejection, surfaced as a provider timeout. */
function isTimeoutError(error) {
	return error instanceof DOMException && error.name === "TimeoutError";
}

/** True for positive integers (result counts and request bounds). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

/** Extract a human-readable detail from a failed provider response. */
async function apiErrorMessage(response, provider) {
	let message = `${provider} Search API error (HTTP ${response.status})`;
	try {
		const parsed = await response.json();
		const detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? parsed.detail ?? parsed.title;
		if (detail !== undefined && detail.length > 0) message = detail;
	} catch {
		// non-JSON error body: keep the status-line message
	}
	return message;
}

/**
 * Register a Brave Search API-backed provider in `ctx.web`.
 *
 * The subscription token resolves per operation, in order:
 *   1. literal `apiKey` from the plugin config / settings section (secret
 *      role — redacted from settings describe output);
 *   2. the DSH credentials service (e.g. `$DSH_HOME/.credentials.yaml`);
 *   3. the environment variable named by `apiKeyEnv` (default
 *      `BRAVE_API_KEY`), read from the launch environment first and the raw
 *      process environment second.
 * @module @huohua-dev/dsh-web-search-brave
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-brave";
/** The web seam this provider registers into. */
const inject = ["web"];
const DEFAULT_API_KEY_ENV = "BRAVE_API_KEY";

const Config = z.object({
	apiKey: z.string().role("secret"),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string(),
	// Security: only the official endpoint is allowed unless explicitly opted
	// in; a custom baseURL still requires https. This blocks config injection
	// from redirecting the subscription token to an arbitrary host.
	allowCustomBaseURL: z.boolean().default(false),
	count: z.number().step(1).min(1).max(BRAVE_MAX_COUNT).default(BRAVE_DEFAULT_COUNT),
	country: z.string(),
	searchLang: z.string(),
	freshness: z.string(),
	safesearch: z.union(["strict", "moderate", "off"]).default("moderate"),
	textDecorations: z.boolean().default(false),
	// HTTP proxy URL; defaults to the launch environment's HTTPS_PROXY /
	// HTTP_PROXY. Node's fetch does not read proxy variables itself, and when
	// api.search.brave.com's DNS is polluted a proxy lets the hostname resolve
	// on the proxy side instead.
	proxy: z.string(),
	searchTimeoutMs: z.number().step(1).min(1000).max(55000).default(DEFAULT_SEARCH_TIMEOUT_MS),
	enabled: z.boolean().default(true)
});

/** Settings namespace carrying this provider's token reference and request options. */
const WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE = "web-search-brave";

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined;
	const environment = launchEnvironmentOf(ctx);
	// Synchronous env snapshot for available() (the credentials store is async).
	const ambient = environment.get(apiKeyEnv);
	const ambientValue = ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
	const raw = process.env[apiKeyEnv];
	const envKey = ambientValue ?? (typeof raw === "string" && raw.length > 0 ? raw : "");
	const credentials = ctx.get("credentials");
	return {
		...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
		envKey,
		hasCredentialResolver: credentials !== undefined,
		resolveApiKey: async () => {
			// Managed store first (matches the official DeepSeek provider), the
			// ambient environment second.
			if (credentials !== undefined) {
				const resolved = (await credentials.resolve(apiKeyEnv))?.value;
				if (resolved !== undefined && resolved.length > 0) return resolved;
			}
			return envKey.length > 0 ? envKey : undefined;
		},
		apiKeyEnv,
		baseURL: resolveBaseURL(config.baseURL, config.allowCustomBaseURL === true),
		count: config.count ?? BRAVE_DEFAULT_COUNT,
		country: config.country,
		searchLang: config.searchLang,
		freshness: config.freshness,
		safesearch: config.safesearch ?? "moderate",
		textDecorations: config.textDecorations ?? false,
		proxy: config.proxy ?? environment.get("HTTPS_PROXY")?.value ?? environment.get("HTTP_PROXY")?.value,
		searchTimeoutMs: config.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
		// Do NOT append "web/brave-search-request" to the session log here.
		// `Session.append()` cannot mark an event `ignorable`, and the harness
		// persistence layer refuses to load any log containing an event type
		// outside its built-in KNOWN_SESSION_EVENT_TYPES (plugin event types have
		// no registration surface yet). A recorded search therefore made the whole
		// session unreadable on the next load (SessionFormatUnsupportedError).
		// Re-enable only once the harness exposes an ignorable-append or
		// plugin-event registration API.
		recordRequest: () => {
		}
	};
}

/**
 * Register the Brave search provider with the live settings section, honoring
 * `enabled`. Re-registration on section change tears the old registration down
 * first, so duplicate-name registrations never throw.
 */
function apply(ctx, config) {
	let current = () => config;
	let disposeProvider;
	const sync = () => {
		if (disposeProvider !== undefined) {
			disposeProvider();
			disposeProvider = undefined;
		}
		const value = current() ?? {};
		if (value.enabled === false) return;
		disposeProvider = ctx.web.registerSearchProvider(new BraveSearchProvider(() => resolveOptions(ctx, current())));
	};
	// dsh-settings >= 0.1.2 exposes section wiring as a service method
	// (`ctx.settings.installSection`) instead of the removed
	// `installSettingsSection` helper; inject so a deployment without a
	// settings service still loads.
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, Config, config ?? {}, {
			setSource: (source) => {
				current = source;
			},
			onChange: sync
		});
	});
	// Initial registration from the composition entry (covers deployments with
	// no settings service, whose installSection never fires its hooks).
	sync();
}

export { BRAVE_DEFAULT_COUNT, BRAVE_ENDPOINT, BRAVE_MAX_COUNT, BRAVE_PROVIDER_ID, BraveSearchProvider, Config, DEFAULT_API_KEY_ENV, WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, apply, inject, mapBraveResponse, name, resolveBaseURL, withTimeout };
