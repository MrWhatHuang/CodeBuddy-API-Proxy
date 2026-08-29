# CodeBuddy API Proxy

把 **腾讯云 CodeBuddy** 的账号登录态 / API 代理成 **OpenAI 兼容接口**，供 Cursor、Continue、OpenAI SDK、Codex CLI 等直接调用。

- **内置 OAuth 登录**：直接在管理页用浏览器完成 CodeBuddy 账号登录（支持多账号账号池）。也可从 VSCode 插件读取登录态、或用 refresh_token 手工导入。
- 服务端只用 Node 内置模块（含 `node:sqlite`），入口是 `server.js`，逻辑在 `core/`。
- 管理页是 Vite + Vue 3（Alova 请求、vue-i18n、浅色/深色），构建产物在 `dist/`，**服务启动后从 `dist/` 托管**。

## 核心特性

1. **内置 OAuth 登录**：管理页「账号管理」里点「添加账号」即弹出浏览器完成 CodeBuddy OAuth 登录，支持添加多个账号组成**账号池**（轮询 / 指定账号两种消耗模式）。首次使用无需任何 VSCode 配置。
2. **VSCode 登录态读取（可选）**：macOS 上可一键从 VSCode / Cursor 等插件的 SecretStorage 解密 CodeBuddy token 导入账号；也可粘贴 `refresh_token` 手工导入。
3. **每日自动签到**：账号管理页顶部有全局「自动签到」开关（默认开启），服务端按北京时间每天在随机时间自动执行签到，错过窗口会补签。
4. **管理页** `http://127.0.0.1:3800/home`：总览、账号、模型、日志、系统配置；中/英文；浅色 / 深色 / 跟随系统。
5. **OpenAI 兼容**：`/v1/chat/completions`（流式 + 非流式自动聚合）、`/v1/completions`、`/v1/embeddings`。
6. **Responses API**：`/v1/responses`，可接 Codex CLI。
7. **SQLite 日志与配置**：写入 `~/.codebuddy-proxy/proxy.db`，可在管理页查询和改设置。

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

未执行 `npm run build` 时，打开管理页会提示先构建。若拉取了最新代码但未重新构建管理页，服务端会比对 `web/` 源码与 `dist/` 产物的时间戳，并在管理页顶部提示重新构建（`npm install && npm run build` 后重启）。

## 首次使用

1. `npm install && npm run build && npm start`
2. 打开管理页 `http://127.0.0.1:3800/home`
3. 在「账号管理」页点「添加账号」，浏览器完成 CodeBuddy OAuth 登录（可重复添加多个账号）
4. 把其它工具的 `base_url` 指向 `http://127.0.0.1:3800/v1` 即可调用

> 无需 VSCode 插件。macOS 上也可选「从 VSCode 插件读取」直接导入插件里已保存的登录态。

## 管理页

| 路径 | 页面 |
|---|---|
| `/home` | 总览：登录状态、代理地址、curl 示例、接口一览、Token 消耗趋势图（可按 OAuth 账号 / API 密钥维度切换） |
| `/accounts` | 账号管理：OAuth 登录 / 从 VSCode 读取 / 手工导入、账号池模式、**顶部全局自动签到开关**、签到状态与积分余额 |
| `/apikeys` | API 密钥：新增 / 删除 / 重新生成多个密钥、校验开关 |
| `/usage` | 使用记录：请求与 token 用量明细、按账号 / 密钥 / 模型筛选、CSV 导出 |
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

## 自动签到

账号管理页**顶部**有一个全局「自动签到」开关（**默认开启**），对账号池里所有账号生效。开启后，服务端会按 **Asia/Shanghai（北京时间）** 的自然日，在 **05:00–09:00** 之间随机取整分钟（带秒级抖动）自动签到，避免固定时间点被官方审计识别。

- 每个账号独立随机，互不相同。
- 若服务在窗口结束后才启动/恢复（例如电脑睡眠到早上 10 点），会**立即补签**，不会因为随机时间已过而漏掉。
- 签到目标时间与「上次签到日期」持久化在 SQLite（`checkin_state` 表），服务重启后不会重复签到，也不会漏签。
- 签到失败（如 token 失效、活动未开）会自动在稍后随机间隔重试，并在日志（分类 `auth`）里记录结果。
- 账号列表会显示「今日已签」或「今日未签 · 预计 HH:mm 自动签到」。
- 也可随时点账号行内的「签到」按钮手动签到；顶部开关只影响后台自动任务，不影响手动签到。
- 可用环境变量 `CODEBUDDY_TZ` 覆盖签到时区（默认 `Asia/Shanghai`）。

## 积分与今日消耗

账号管理页的「积分余额」列会显示每个账号当前**剩余积分**，下方附带**今日消耗**（今天 0 时以来已消耗的积分）。

- 服务端会在**每天 0 时后**（本地日期首次 tick，含服务重启后补快照）把每个账号当前的已消耗/剩余/总积分快照写入 SQLite（`credit_snapshots` 表）。
- **今日消耗** = 当前已消耗积分（`usageUsed`）－ 今日 0 时快照的已消耗积分。
- 若当天还没有快照（例如服务当天刚启动、尚未到 0 时），会以当前值作为当日基线写入，此时今日消耗记为 `0`，之后再查询即为「现在 － 今日 0 时基线」。

## 数据文件

默认都在 `~/.codebuddy-proxy/`（可用 `CODEBUDDY_DATA_DIR` 覆盖）：

| 文件 | 说明 |
|---|---|
| `session.json` | OAuth / VSCode 登录态（权限 `0600`），含 `accessToken`、`refreshToken`、账号。也可用 `CODEBUDDY_SESSION_FILE` 单独指定 |
| `proxy.db` | SQLite：`logs` 表 + `config` 表 + `models` 表（自定义模型）+ `api_keys` 表 + `usage` 表（用量统计）+ `accounts`/账号池 + `checkin_state`（自动签到状态）+ `credit_snapshots`（每日积分快照）。也可用 `CODEBUDDY_DB_FILE` 单独指定 |

账号登录态的优先级（多种方式，取其一即可）：

1. **OAuth 网页登录**（管理页「添加账号」，推荐，无需 VSCode）
2. VSCode 系编辑器 SecretStorage（macOS，管理页「从 VSCode 插件读取」）
3. refresh_token 手工导入

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
| `CODEBUDDY_TZ` | `Asia/Shanghai` | 自动签到使用的时区（按该时区的自然日与 05:00–09:00 窗口） |
| `CODEBUDDY_FORCE_MODEL` | 空 | 强制替换请求 model |
| `CODEBUDDY_DEFAULT_MODEL` | `default` | 缺省 model |
| `CODEBUDDY_API_KEY` | 空 | 兼容旧版：指定单个 API 密钥（首次启动时迁移进 API 密钥表）。也可在管理页「API 密钥」里管理多个密钥 |
| `CODEBUDDY_NO_OPEN` | 空 | 设置则不自动打开管理页 |
| `CODEBUDDY_ADMIN_USERNAME` | `admin` | 管理页鉴权的管理员用户名 |
| `CODEBUDDY_ADMIN_PASSWORD` | 空 | 管理页鉴权初始密码。首次启动时写入并强制首次登录改密；为空则自动生成一次性随机密码并打印到启动日志 |
| `CODEBUDDY_TRUST_PROXY` | 空（关闭） | 设为 `true` / `1` 才信任反向代理（Cloudflare / nginx）注入的 `X-Forwarded-For`。**未设置时不信任**，限流按直连 IP 计算，防止伪造 XFF 绕过限流 |
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

设置 / 清除 API 密钥：建议在管理页「API 密钥」页面新增、删除或重新生成多个密钥。也兼容旧版的单密钥设置方式（写入密钥表）：

```bash
# 设置密钥（作为新密钥加入，非覆盖）
curl -X PUT http://127.0.0.1:3800/api/config -H "Content-Type: application/json" -d '{"apiKey": "my-secret-key"}'
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
| `apiKeyEnabled` | `true` | 是否校验客户端访问 `/v1` 与 `/responses` 所需的 API 密钥 |
| `apiKey` | 空 | 兼容旧版：加入一个密钥到密钥表；不影响校验开关 |
| `adminAuthEnabled` | `false` | 是否开启管理页/管理接口鉴权（登录后访问） |

日志查询：

```bash
curl "http://127.0.0.1:3800/api/logs?level=info&category=proxy&q=chat&limit=50&offset=0"
```

支持 `level`、`category`（`system` / `auth` / `proxy` / `responses` / `config`）、`q`、`from`、`to`（毫秒时间戳）、`limit`（1–1000）、`offset`。

## 管理页鉴权

部署到公网/服务器时，建议开启管理页鉴权（默认关闭，向后兼容）。开启后访问管理页及所有管理接口都需登录，**AI 对话接口（`/v1/*`、`/responses`）不受影响**，仍只校验 API 密钥。

- 在管理页「系统配置」里打开「管理页鉴权」开关即可启用。保存后请打开 [`/admin-login`](http://127.0.0.1:3800/admin-login) 登录。
- 管理员账号默认 `admin`；初始密码来自环境变量 `CODEBUDDY_ADMIN_PASSWORD`，或首次启动时自动生成并打印到启动日志（一次性，搜 `[重要] 管理页初始密码`）。
- 首次登录后建议在「系统配置」里「修改密码」。
- 若已开启鉴权却不知道密码：把 `CODEBUDDY_ADMIN_PASSWORD` 设成新密码后删除数据库里的管理员记录再重启（见下方「忘记密码」），或临时把配置里的 `adminAuthEnabled` 改回 `false`。
- 密码用 scrypt（随机盐）哈希存储，新密码要求至少 8 位且同时包含字母和数字。
- 登录失败按 IP+用户名限流（15 分钟窗口内 8 次失败后锁定），**持久化到 SQLite（服务重启后仍锁定）**，锁定到期时间独立存储不因窗口滑动被清掉。
- 客户端 IP 仅在设置 `CODEBUDDY_TRUST_PROXY=true` 时信任 `X-Forwarded-For`，否则用直连 IP，防止伪造 XFF 绕过限流。
- 登录会话持久化到 SQLite（服务重启后仍有效），通过 HttpOnly + SameSite=Strict Cookie 下发，也支持 `Authorization: Bearer <token>` 供脚本调用。
- 自定义 API 密钥最短 16 位；API 密钥校验同样有失败限流（按 IP 持久化，20 次失败后锁定）。

相关接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/login` | 登录，body `{ username, password }` |
| POST | `/api/admin/logout` | 退出登录（注销当前会话） |
| POST | `/api/admin/change-password` | 修改密码，body `{ currentPassword, newPassword }` |
| GET | `/api/admin/status` | 鉴权状态（是否开启 / 是否已登录） |

浏览器打开 `http://127.0.0.1:3800/admin-login`，用户名默认 `admin`，密码用启动日志里的初始密码。也可用 curl：

```bash
curl -c /tmp/cbp-admin.cookie -X POST http://127.0.0.1:3800/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"你的密码"}'
# 之后带 cookie 访问管理接口
curl -b /tmp/cbp-admin.cookie http://127.0.0.1:3800/api/config
```

### 忘记密码

初始密码只在**第一次启动**时打印。之后可用 sqlite 关掉鉴权或重置管理员：

```bash
# 临时关闭鉴权（然后重启，进入管理页改密后再打开）
sqlite3 ~/.codebuddy-proxy/proxy.db "UPDATE config SET value='false' WHERE key='adminAuthEnabled';"

# 或删除管理员记录后重启，会重新生成初始密码并打印到启动日志
sqlite3 ~/.codebuddy-proxy/proxy.db "DELETE FROM admin_users; DELETE FROM admin_sessions;"
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` `/home` `/logs` `/settings` `/login` `/accounts` | 管理页 SPA（`dist/`） |
| GET | `/models` | 浏览器：管理页；JSON Accept：模型列表 |
| GET | `/api/status` | 登录状态、打码 token、模型目录 |
| GET | `/api/config` | 系统配置 + 运行时信息 |
| PUT | `/api/config` | 更新系统配置 |
| GET | `/api/logs` | 日志查询 |
| DELETE | `/api/logs` | 清空日志 |
| GET | `/api/stats` | 日志统计 |
| GET | `/api/import-vscode` | 从 VSCode 重读登录态 |
| GET | `/api/accounts` | 账号池列表 + 池配置 + 全局 `autoCheckin` 开关 |
| PUT | `/api/accounts` | 全局自动签到开关（body `{ autoCheckin }`） |
| PUT | `/api/accounts/:id` | 重命名（body `{ name }`） |
| POST | `/api/accounts/login` | 发起 OAuth 登录，返回 `authUrl` |
| GET | `/api/accounts/login/status` | 查询 OAuth 登录进度 |
| POST | `/api/accounts/import` | 用 refresh_token 手工导入账号 |
| DELETE | `/api/accounts/:id` | 删除账号 |
| GET | `/api/checkin/status` | 查询签到状态（可指定 `accountId`） |
| POST | `/api/checkin` | 执行签到（可指定 `accountId`） |
| GET | `/api/credits` | 查询积分余额（可指定 `accountId`） |
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
| GET | `/api/keys` | API 密钥列表（打码） + 校验开关状态 |
| POST | `/api/keys` | 新增 API 密钥（可自动生成或手填） |
| POST | `/api/keys/regenerate/:id` | 重新生成密钥（旧密钥立即失效） |
| DELETE | `/api/keys/:id` | 删除 API 密钥 |
| GET | `/api/usage` | 用量记录：按时间 / 账号 / 密钥 / 模型筛选、分页，含 token 汇总 |
| GET | `/api/usage/stats?dimension=account|apiKey` | 按天聚合的 token 用量，供首页图表 |

## 用量统计

每次 `/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/responses` 请求都会写入 SQLite `usage` 表，记录：时间、接口、模型、所用 OAuth 账号、所用 API 密钥（未走密钥则归到「空密钥」维度）、输入/输出/总 token、**缓存命中 token**（`prompt_cache_hit_tokens` / `cached_tokens`）及**缓存命中率**（`cacheHitRate`，= 命中 token / 输入 token，仅后端按需计算、不入库）、耗时与状态。流式请求也会在结束时解析 `usage` 块以采集 token。旧库会自动补充 `cached_tokens` 列。

管理页「总览」的 Token 消耗趋势图可按 **OAuth 账号** 或 **API 密钥** 维度查看近 14 天用量，柱体中浅色部分即缓存命中 token，并可看到「缓存命中」图例；「使用记录」页提供明细（含缓存命中列与每行命中率、汇总统计卡片含缓存命中率）、筛选与 CSV 导出（含 `cache_hit_rate` 列）。

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
  store.js         SQLite 日志 + 系统配置 + 账号池 + 签到状态
  logger.js        统一日志
  session.js       登录态 / 账号池
  auth.js          OAuth / token 刷新
  vscode.js        从 VSCode 解密登录态
  checkin.js       每日签到（查询 / 执行）
  checkinScheduler.js  自动签到调度（随机时间）
  credits.js       积分余额 / 今日消耗
  creditScheduler.js   每日积分快照调度（0 时后）
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
