# @huohua-dev/dsh-web-search-brave

English | [中文](README.zh.md)

A [Brave Search API](https://brave.com/search/api/) web search provider plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), mounted on the official web capability seam (`ctx.web`). One search is one HTTP request — lighter and faster than the bundled DeepSeek provider, which spends a full model turn per search.

It calls Brave's official endpoint `https://api.search.brave.com/res/v1/web/search` and maps the structured `web.results[]` into the seam's normalized `WebSearchResult`; the model keeps seeing the same stable `web_search` tool.

## Features

- **Pure retrieval**: one search = one HTTP GET, no model-turn cost.
- **Security first**:
  - the subscription token is only ever sent to the Brave endpoint, in the `X-Subscription-Token` header — never in the URL, never logged;
  - `baseURL` is pinned to the official endpoint; a custom endpoint requires an explicit `allowCustomBaseURL: true` opt-in and must use https, so a config injection cannot silently redirect your key to another host;
  - every request carries a hard timeout (`searchTimeoutMs`, default 30 s) on top of the caller's abort signal.
- **Careful request shaping**: caller `maxResults` is honored at the request layer, `count` never exceeds the configured value or the API cap (20), URLs are deduped, and `page_age` is surfaced as `publishedAt` only when it parses as a date.
- **Proxy support**: optional `proxy` (defaults to the launch environment's `HTTPS_PROXY` / `HTTP_PROXY`). Useful when `api.search.brave.com` suffers DNS pollution — the hostname then resolves on the proxy side. Implemented with a lazily imported `undici` (optional dependency): no proxy configured, no dependency loaded.
- **Hot reload**: the settings section is re-read between searches; edits to the profile patch apply without restarting DSH. An `enabled` switch lets you park the provider without uninstalling.
- **Zero-config switch**: the shipped bundle patch mounts the plugin and selects `searchProvider: brave` in one step.

## Requirements

- `dsh` `0.1.1-rc.2` or later
- Node.js `>=20.3.0`
- A Brave Search API subscription token — get one at [api-dashboard.search.brave.com](https://api-dashboard.search.brave.com/) (a free tier exists)

## Install

From GitHub:

```sh
dsh plugin --profile web add github:huohua-dev/dsh-web-search-brave
```

From a local checkout (development):

```sh
git clone https://github.com/huohua-dev/dsh-web-search-brave.git
dsh plugin --profile web add link:$(pwd)/dsh-web-search-brave
```

The bundle's `cordis.patch.yml` mounts the plugin and switches `web.searchProvider` from the base bundle's `deepseek-official` to `brave` automatically. To switch back, remove the plugin, or override in your profile patch (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: web
  config:
    searchProvider: deepseek-official
```

## API key

The token resolves per search, first hit wins:

1. **DSH credentials service (recommended)**: append `BRAVE_API_KEY: <your-token>` to `$DSH_HOME/.credentials.yaml`;
2. **Environment variable**: export `BRAVE_API_KEY=<your-token>` before launching dsh (rename via `apiKeyEnv`);
3. **Literal `apiKey` in the plugin config** (secret role — redacted from settings describe output).

A missing key fails searches with `WEB_PROVIDER_CREDENTIAL_MISSING`, whose message restates these options.

## Configuration

All fields optional; edit under the `web-search-brave` entry in your profile's `cordis.patch.yml`:

```yaml
- id: web-search-brave
  config:
    apiKeyEnv: BRAVE_API_KEY
    count: 10
    country: cn
    searchLang: zh-hans
```

| Field | Default | Description |
| --- | --- | --- |
| `apiKey` | — | Literal subscription token (secret); wins over the credentials store when set |
| `apiKeyEnv` | `BRAVE_API_KEY` | Credential reference name, resolved via the credentials service or the launch environment |
| `baseURL` | `https://api.search.brave.com/res/v1/web/search` | API endpoint; custom values need `allowCustomBaseURL: true` and https |
| `allowCustomBaseURL` | `false` | Explicit opt-in for a non-official endpoint |
| `count` | `10` | Results requested per search (1–20; also bounded by the caller's `maxResults`) |
| `country` | — | Two-letter country code (e.g. `cn`, `us`) |
| `searchLang` | — | Search language (e.g. `zh-hans`, `en`) |
| `freshness` | — | Recency filter: `pd` / `pw` / `pm` / `py` or an ISO date range |
| `safesearch` | `moderate` | `strict` / `moderate` / `off` |
| `textDecorations` | `false` | Brave `<b>` highlight markers in snippets; off keeps snippets clean for the model |
| `proxy` | `HTTPS_PROXY` / `HTTP_PROXY` from the launch environment | HTTP proxy URL for the search request |
| `searchTimeoutMs` | `30000` | Hard per-request timeout (1000–55000 ms, below the harness tool deadline) |
| `enabled` | `true` | Master switch; `false` unregisters the provider without uninstalling |

## Verify

```sh
dsh --profile web --dump-config   # the web-search-brave entry is mounted
```

Then ask the model to use `web_search` in a conversation. **Note: installing a new plugin requires a dsh restart to take effect** — the running host does not hot-mount newly installed plugins (edits to an already-mounted plugin's config are hot-reloaded).

## Development

```sh
npm install
npm test    # vitest, 43 cases covering mapping / whitelist / timeout / abort / proxy / apply
```

The package ships hand-written ESM sources — what you read is what runs; there is no build step.

## Security notes

- The only outbound destination is the Brave Search API endpoint (or your explicitly approved https mirror).
- `available()` never throws and never makes network calls, per the seam contract.
- No telemetry, no install hooks, no `!!js` expressions in the shipped patch.
- Structure and error semantics follow the official [@deepseek-ai/dsh-web-search-deepseek](https://www.npmjs.com/package/@deepseek-ai/dsh-web-search-deepseek) provider.

## Acknowledgements

Built with reference to the official DeepSeek search provider and the community plugins [@dsh-ltctfer/dsh-web-search-brave](https://github.com/LTctfer/dsh-web-search-brave) and [cnChenKai/dsh-web-search-brave](https://github.com/cnChenKai/dsh-web-search-brave) (all MIT).

## License

[MIT](LICENSE)
