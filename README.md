# CodeBuddy API Proxy

把本地 VSCode 里 **腾讯云 CodeBuddy** 插件的登录态 / API 代理成 **OpenAI 兼容接口**，供 Cursor、Continue、OpenAI SDK、Codex CLI 等直接调用。

- 服务端只用 Node 内置模块（含 `node:sqlite`），入口是 `server.js`，逻辑在 `core/`。
- 管理页是 Vite + Vue 3（Alova 请求、vue-i18n、浅色/深色），构建产物在 `dist/`，**服务启动后从 `dist/` 托管**。

## 核心特性

1. **直接读 VSCode 插件登录态**（macOS）：启动时从 VSCode / Cursor 等 SecretStorage 解密 CodeBuddy token，读不到再走 OAuth。
2. **管理页** `http://127.0.0.1:3800/home`：总览、模型、日志、系统配置；中/英文；浅色 / 深色 / 跟随系统。
3. **OpenAI 兼容**：`/v1/chat/completions`（流式 + 非流式自动聚合）、`/v1/completions`、`/v1/embeddings`。
4. **Responses API**：`/v1/responses`，可接 Codex CLI。
5. **SQLite 日志与配置**：写入 `~/.codebuddy-proxy/proxy.db`，可在管理页查询和改设置。

## 运行

需要 **Node ≥ 22.5**（内置 `node:sqlite`；实测 Node 24 可用）。

```bash
npm install
npm run build          # 把 web/ 构建到 dist/
npm start              # node server.js，默认 http://127.0.0.1:3800
```

| 脚本 | 说明 |
|---|---|
| `npm start` | 启动代理；管理页来自 `dist/` |
| `npm run build` | 构建管理页 |
| `npm run dev` | 只起 Vite（`:5173`），API 代理到 `:3800`，需另开终端 `npm start` |
| `npm test` | 语法检查 |

启动后会自动打开管理页。关掉自动打开：

```bash
CODEBUDDY_NO_OPEN=1 npm start
```

也可在管理页「系统配置」里关闭「启动后自动打开管理页」。`CODEBUDDY_NO_OPEN` 优先级更高。

未执行 `npm run build` 时，打开管理页会提示先构建。

## 管理页

| 路径 | 页面 |
|---|---|
| `/home` | 总览：登录状态、代理地址、curl 示例、接口一览 |
| `/models` | 模型列表（浏览器访问为页面；`Accept: application/json` 时仍返回模型 JSON） |
| `/logs` | 日志：级别 / 分类 / 关键字、详情展开、自动刷新、清空 |
| `/settings` | 系统配置 |
| `/login` | OAuth 登录 |

右上角可切换主题和语言（保存在浏览器 `localStorage`，不写入服务端）。

系统配置里可改：

- 日志开关、是否记录详细情况（模型 / 消息数 / 耗时 / tokens 等摘要）
- 日志级别、保留天数、最大条数
- 启动后自动打开管理页
- 默认模型、强制模型
- 上游请求超时、CORS Origin

## 数据文件

默认都在 `~/.codebuddy-proxy/`（可用 `CODEBUDDY_DATA_DIR` 覆盖）：

| 文件 | 说明 |
|---|---|
| `session.json` | OAuth / VSCode 登录态（权限 `0600`），含 `accessToken`、`refreshToken`、账号。也可用 `CODEBUDDY_SESSION_FILE` 单独指定 |
| `proxy.db` | SQLite：`logs` 表 + `config` 表 + `models` 表（自定义模型）。也可用 `CODEBUDDY_DB_FILE` 单独指定 |

启动读登录态的优先级：

1. VSCode 系编辑器 SecretStorage（macOS）
2. 本地 `session.json`
3. 都没有 → 管理页提示 OAuth 登录

管理页「从 VSCode 重新读取」对应 `GET /api/import-vscode`。

VSCode 解密（逆向自 `tencent-cloud.coding-copilot`）：token 在 `state.vscdb` 的 `ItemTable`，key 为

```
secret://{"extensionId":"tencent-cloud.coding-copilot","key":"Tencent-Cloud.coding-copilot.new.accessToken"}
```

值用 Electron `safeStorage` 加密：`PBKDF2-SHA1(钥匙串密码, "saltysalt", 1003, 16)` 派生 AES-128-CBC，密文前缀 `v10`，IV 为 16 个空格。钥匙串服务名如 `Code Safe Storage`。也支持 Code - Insiders / Cursor / VSCodium / Windsurf / Trae。

## 使用示例

```bash
# 流式
curl -N http://127.0.0.1:3800/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"default","stream":true,"messages":[{"role":"user","content":"你好"}]}'

# 非流式（上游只支持流式，由本代理聚合）
curl http://127.0.0.1:3800/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"你好"}]}'
```

把其它工具的 `base_url` 指向 `http://127.0.0.1:3800/v1`。

## 接 Codex CLI（Responses API）

Codex 走 `/v1/responses`。代理把请求转成 `chat/completions`，再把上游 SSE 转回 Responses 事件流。`~/.codex/config.toml` 示例：

```toml
model_provider = "custom"
model = "deepseek-v4-flash"          # 或 default / claude-4.0 等目录里的模型
model_reasoning_effort = "medium"
disable_response_storage = true
preferred_auth_method = "apikey"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://127.0.0.1:3800/v1"
```

代理默认忽略 `OPENAI_API_KEY`，真正鉴权用 CodeBuddy token。若设置了 API 密钥（见下文），则客户端必须携带该密钥：

```bash
export OPENAI_API_KEY=<你的密钥>   # 或在请求头 X-API-Key 提供
codex exec "你的任务"
```

未设置密钥时，`OPENAI_API_KEY` 可填任意占位值（如 `dummy`）。

实测（Codex CLI 0.148）：文本回复、shell 工具调用、多轮 tool loop 均正常。

> 1. Codex 可能提示 `Model metadata for '...' not found`（自定义模型不在 Codex 内置目录），不影响使用。
> 2. CodeBuddy 会拦截含 `Codex` / `OpenAI` 的系统提示词（`11128 Illegal API invocation from an unapproved channel`）。代理会净化 `instructions` / `developer` 系统消息（`Codex`→`CodeBuddy`、`OpenAI`→`Tencent`），用户消息和工具参数不动。

## 环境变量

启动时生效，改完需重启。`defaultModel` / `forceModel` / `autoOpen` 可被管理页里已保存的值覆盖；`CODEBUDDY_NO_OPEN` 始终禁止自动打开浏览器。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `CODEBUDDY_PROXY_PORT` | `3800` | 监听端口 |
| `HOST` / `CODEBUDDY_PROXY_HOST` | `127.0.0.1` | 监听地址 |
| `CODEBUDDY_ENDPOINT` | `https://copilot.tencent.com` | 后端地址 |
| `CODEBUDDY_PREFIX_PATH` | `/plugin` | 认证接口前缀 |
| `CODEBUDDY_PLATFORM` | `VSCode` | 平台标识 |
| `CODEBUDDY_DATA_DIR` | `~/.codebuddy-proxy` | 数据目录 |
| `CODEBUDDY_SESSION_FILE` | `~/.codebuddy-proxy/session.json` | 会话文件 |
| `CODEBUDDY_DB_FILE` | `~/.codebuddy-proxy/proxy.db` | SQLite 数据库 |
| `CODEBUDDY_FORCE_MODEL` | 空 | 强制替换请求 model |
| `CODEBUDDY_DEFAULT_MODEL` | `default` | 缺省 model |
| `CODEBUDDY_API_KEY` | 空 | 客户端访问 `/v1` 与 `/responses` 所需的 API 密钥；空则不校验。也可在管理页「系统配置」里设置 |
| `CODEBUDDY_NO_OPEN` | 空 | 设置则不自动打开管理页 |
| `CODEBUDDY_DEBUG` | 空 | 把最近一次 Responses 请求 dump 到 `/tmp/codebuddy-debug-last.json` |

国际版可设 `CODEBUDDY_ENDPOINT=https://www.codebuddy.ai`。

## 系统配置（管理页 / API）

`GET /api/config` 读取，`PUT /api/config` 更新，持久化在 SQLite `config` 表。

```bash
curl -X PUT http://127.0.0.1:3800/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "logging": { "enabled": true, "details": true, "level": "info", "retentionDays": 7, "maxRows": 10000 },
    "autoOpen": true,
    "defaultModel": "default",
    "forceModel": "",
    "requestTimeoutMs": 300000,
    "corsOrigin": "*"
  }'
```

设置 / 清除 API 密钥（设置后客户端访问 `/v1` 与 `/responses` 必须携带）：

```bash
# 设置密钥
curl -X PUT http://127.0.0.1:3800/api/config -H "Content-Type: application/json" -d '{"apiKey": "my-secret-key"}'
# 清除（关闭校验）
curl -X PUT http://127.0.0.1:3800/api/config -H "Content-Type: application/json" -d '{"apiKey": ""}'
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `logging.enabled` | `true` | 是否写入 SQLite 日志 |
| `logging.details` | `true` | 是否记录请求摘要（模型、耗时、tokens 等） |
| `logging.level` | `info` | `debug` / `info` / `warn` / `error`，只记该级别及以上 |
| `logging.retentionDays` | `7` | 超过天数删除；`0` = 永久 |
| `logging.maxRows` | `10000` | 超过条数删最旧；`0` = 不限制 |
| `autoOpen` | `true` | 启动后自动打开管理页 |
| `defaultModel` | `default` | 请求未带 `model` 时使用 |
| `forceModel` | 空 | 非空则覆盖所有请求的 `model` |
| `requestTimeoutMs` | `300000` | 上游超时（1s–30min） |
| `corsOrigin` | `*` | `Access-Control-Allow-Origin` |
| `apiKey` | 空 | 客户端访问 `/v1` 与 `/responses` 所需的 API 密钥；空 = 不校验 |

日志查询：

```bash
curl "http://127.0.0.1:3800/api/logs?level=info&category=proxy&q=chat&limit=50&offset=0"
```

支持 `level`、`category`（`system` / `auth` / `proxy` / `responses` / `config`）、`q`、`from`、`to`（毫秒时间戳）、`limit`（1–1000）、`offset`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` `/home` `/logs` `/settings` `/login` | 管理页 SPA（`dist/`） |
| GET | `/models` | 浏览器：管理页；JSON Accept：模型列表 |
| GET | `/api/status` | 登录状态、打码 token、模型目录 |
| GET | `/api/config` | 系统配置 + 运行时信息 |
| PUT | `/api/config` | 更新系统配置 |
| GET | `/api/logs` | 日志查询 |
| DELETE | `/api/logs` | 清空日志 |
| GET | `/api/stats` | 日志统计 |
| GET | `/api/import-vscode` | 从 VSCode 重读登录态 |
| POST | `/api/logout` | 退出登录（JSON） |
| GET | `/health` | 健康检查 |
| GET | `/login/state` | 获取 OAuth `state` + `authUrl` |
| GET | `/login/status?state=` | 查询登录进度 |
| GET | `/logout` | 退出登录并跳转 `/home` |
| GET | `/v1/models` | 模型列表（内置 + 自定义合并） |
| GET | `/api/models` | 模型列表（内置 + 自定义，带 `builtin` 标记） |
| POST | `/api/models` | 新增 / 更新自定义模型（存 SQLite `models` 表） |
| DELETE | `/api/models/:id` | 删除自定义模型 |
| POST | `/v1/responses` `/responses` | Responses API（流式/非流式） |
| POST | `/v1/chat/completions` `/v2/chat/completions` | 对话 |
| POST | `/v1/completions` `/v2/completions` | 补全 |
| POST | `/v1/embeddings` `/v2/embeddings` | 向量 |

## 认证机制（逆向）

| 项目 | 值 |
|---|---|
| 后端 | `https://copilot.tencent.com`（国际版 `https://www.codebuddy.ai`） |
| 认证 prefixPath | `/plugin` |
| 登录类型 | `external-link-v2` |
| 对话 | `POST /v2/chat/completions`（**仅流式**，非流式由本代理聚合） |
| 补全 | `POST /v2/completions` |
| 向量 | `POST /v2/embeddings` |

登录：

```
POST /v2/plugin/auth/state?platform=VSCode      → { state, authUrl }
   浏览器打开 authUrl
GET  /v2/plugin/auth/token?state=...            → 轮询（code 11217 = 登录中）
GET  /v2/plugin/login/account?state=...         → 账号（Bearer）
```

刷新：

```
POST /v2/plugin/auth/token/refresh
Headers: X-Refresh-Token, X-Auth-Refresh-Source: plugin, X-Domain
```

转发头：

```
Authorization: Bearer <accessToken>
X-User-Id: <uid>
X-Enterprise-Id / X-Tenant-Id: <enterpriseId>   # 企业版
X-Domain: <domain>
```

## 目录

```
server.js          启动入口
core/              服务端
  index.js         HTTP 服务装配
  config.js        环境变量 / 默认值
  store.js         SQLite 日志 + 系统配置
  logger.js        统一日志
  session.js       登录态
  auth.js          OAuth / token 刷新
  vscode.js        从 VSCode 解密登录态
  openai.js        OpenAI 兼容转发
  responses.js     /v1/responses 转换
  models.js        模型目录
  routes.js        路由与 dist 静态资源
  util.js          请求 / 响应工具
web/               管理页源码（Vite + Vue）
dist/              管理页构建产物
```

## 安全提示

- 默认只监听 `127.0.0.1`，不要直接暴露到公网。
- `session.json` 含明文 token；`/api/status` 只返回打码 token。
- 解密 VSCode 密钥需要本机钥匙串权限（macOS 首次可能弹授权）。

## License

[MIT](LICENSE)
