# @huohua-dev/dsh-web-search-brave

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 **Brave Search API** 网络搜索提供方插件，挂载到官方 web 能力接缝（`ctx.web`）。一次搜索就是一次 HTTP 请求——不需要模型参与，比 DeepSeek 官方提供方（每次搜索消耗一次完整模型轮次）更轻、更快。

调用 Brave 官方搜索端点 `https://api.search.brave.com/res/v1/web/search`，把结构化 `web.results[]` 映射为接缝规范化的 `WebSearchResult`，模型看到的仍是稳定的 `web_search` 工具。

## 特性

- **纯检索端点**：一次搜索 = 一次 HTTP GET，无模型轮次开销。
- **安全优先**：
  - 订阅 token 只发往 Brave 端点，放在 `X-Subscription-Token` 请求头——不进 URL、不进日志；
  - `baseURL` 默认锁定官方端点；自定义端点必须显式 `allowCustomBaseURL: true` 且强制 https，配置注入无法把 key 静默重定向到其他主机；
  - 每个请求带硬超时（`searchTimeoutMs`，默认 30 秒），叠加在调用方取消信号之上。
- **请求塑形**：调用方 `maxResults` 在请求层生效；`count` 永不超过配置值和 API 上限（20）；按 URL 去重；`page_age` 仅在能解析为日期时映射为 `publishedAt`。
- **代理支持**：可选 `proxy`（默认取启动环境的 `HTTPS_PROXY` / `HTTP_PROXY`）。当 `api.search.brave.com` 的 DNS 被污染时，走代理可让域名在代理侧解析。基于懒加载的 `undici`（optional dependency）：不配代理则完全不加载该依赖。
- **热更新**：设置在两次搜索之间重新读取，修改 profile 的 patch 文件保存即生效，无需重启 DSH。`enabled` 开关可在不卸载插件的情况下停用提供方。
- **零配置切换**：自带的 bundle patch 一步完成挂载并把 `searchProvider` 切换为 `brave`。

## 环境要求

- `dsh` `0.1.1-rc.2` 或更高版本
- Node.js `>=20.3.0`
- Brave Search API 订阅 token——到 [api-dashboard.search.brave.com](https://api-dashboard.search.brave.com/) 获取（有免费额度）

## 安装

从 GitHub 安装：

```sh
dsh plugin --profile web add github:huohua-dev/dsh-web-search-brave
```

从本地检出安装（开发调试）：

```sh
git clone https://github.com/huohua-dev/dsh-web-search-brave.git
dsh plugin --profile web add link:$(pwd)/dsh-web-search-brave
```

bundle 的 `cordis.patch.yml` 会自动挂载插件并把 `web.searchProvider` 从基础包的 `deepseek-official` 切换为 `brave`。如需切回，删除本插件，或在 profile 的 patch（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）中覆盖：

```yaml
- id: web
  config:
    searchProvider: deepseek-official
```

## API key

token 按以下顺序解析，先命中生效：

1. **DSH 凭据服务（推荐）**：在 `$DSH_HOME/.credentials.yaml` 追加 `BRAVE_API_KEY: <你的令牌>`；
2. **环境变量**：启动 dsh 前导出 `BRAVE_API_KEY=<你的令牌>`（可经 `apiKeyEnv` 改名）；
3. **插件配置里的字面量 `apiKey`**（secret 角色，设置输出中脱敏）。

缺少 key 时搜索以 `WEB_PROVIDER_CREDENTIAL_MISSING` 报错，错误信息会重申以上配置途径。

## 配置项

所有字段均可选；在 profile 的 `cordis.patch.yml` 中编辑 `web-search-brave` 条目：

```yaml
- id: web-search-brave
  config:
    apiKeyEnv: BRAVE_API_KEY
    count: 10
    country: cn
    searchLang: zh-hans
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | — | 字面量订阅令牌（secret），设置时优先于凭据服务 |
| `apiKeyEnv` | `BRAVE_API_KEY` | 凭据引用名，经凭据服务或启动环境解析 |
| `baseURL` | `https://api.search.brave.com/res/v1/web/search` | API 端点；自定义值需 `allowCustomBaseURL: true` 且强制 https |
| `allowCustomBaseURL` | `false` | 非官方端点的显式开关 |
| `count` | `10` | 每次搜索请求的结果条数（1–20，同时受调用方 `maxResults` 约束） |
| `country` | — | 两位国家/地区码（如 `cn`、`us`） |
| `searchLang` | — | 搜索语言（如 `zh-hans`、`en`） |
| `freshness` | — | 时效过滤：`pd` / `pw` / `pm` / `py` 或 ISO 日期区间 |
| `safesearch` | `moderate` | `strict` / `moderate` / `off` |
| `textDecorations` | `false` | Brave 摘要的 `<b>` 高亮标记；关闭可保持喂给模型的文本干净 |
| `proxy` | 启动环境的 `HTTPS_PROXY` / `HTTP_PROXY` | 搜索请求的 HTTP 代理 URL |
| `searchTimeoutMs` | `30000` | 单请求硬超时（1000–55000 毫秒，低于 harness 工具期限） |
| `enabled` | `true` | 总开关；`false` 时注销提供方但保留插件 |

## 验证

```sh
dsh --profile web --dump-config   # 确认 web-search-brave 条目已挂载
```

然后在对话中直接让模型使用 `web_search` 工具。成功的搜索会向会话日志追加一条 `web/brave-search-request` 记录（仅端点，不含 key）。

## 开发

```sh
npm install
npm test    # vitest，43 个用例：映射 / 白名单 / 超时 / 取消 / 代理 / apply
```

本包直接交付手写 ESM 源码——所见即所运行，无构建步骤。

## 安全说明

- 唯一的出站目标是 Brave Search API 端点（或你显式批准的 https 镜像）。
- `available()` 按接缝契约保证不抛错、不发网络请求。
- 无遥测、无安装钩子、patch 中不使用 `!!js` 表达式。
- 结构与错误语义对齐官方 [@deepseek-ai/dsh-web-search-deepseek](https://www.npmjs.com/package/@deepseek-ai/dsh-web-search-deepseek) 提供方。

## 致谢

实现参考了官方 DeepSeek 搜索提供方，以及社区插件 [@dsh-ltctfer/dsh-web-search-brave](https://github.com/LTctfer/dsh-web-search-brave) 与 [cnChenKai/dsh-web-search-brave](https://github.com/cnChenKai/dsh-web-search-brave)（均为 MIT）。

## 许可

[MIT](LICENSE)
