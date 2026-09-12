# CodeBuddy API Proxy

把 **腾讯云 CodeBuddy** 的账号登录态 / API 代理成 **OpenAI 兼容接口**，供 Cursor、Continue、OpenAI SDK、Codex CLI 等直接调用。

- **内置 OAuth 登录**：直接在管理页用浏览器完成 CodeBuddy 账号登录（支持多账号账号池）。也可从 VSCode 插件读取登录态、或用 refresh_token 手工导入。
- 服务端只用 Node 内置模块（含 `node:sqlite`），入口是 `server.js`，逻辑在 `core/`。
- 管理页是 Vite + Vue 3（Alova 请求、vue-i18n、浅色/深色），构建产物在 `dist/`，**服务启动后从 `dist/` 托管**。

## 核心特性

1. **内置 OAuth 登录**：管理页「账号管理」里点「添加账号」即弹出浏览器完成 CodeBuddy OAuth 登录，支持添加多个账号组成**账号池**（轮询 / 额度加权 / 最省优先三种选号策略，可指定账号）。
2. **会话粘性**：同一个任务（同一段对话）自始至终使用同一个账号，**不会跑到一半换号**，从而保住上游的上下文缓存。可选定时切换与失败转移。
3. **VSCode 登录态读取（可选）**：macOS 上可一键从 VSCode / Cursor 等插件的 SecretStorage 解密 CodeBuddy token 导入账号；也可粘贴 `refresh_token` 手工导入。
4. **每日自动签到**：账号管理页顶部有全局「自动签到」开关（默认开启），服务端按北京时间每天在随机时间自动执行签到，错过窗口会补签。
5. **管理页** `http://127.0.0.1:3800/home`：总览、账号、模型、日志、系统配置；中/英文；浅色 / 深色 / 跟随系统。
6. **OpenAI 兼容**：`/v1/chat/completions`（流式 + 非流式自动聚合）、`/v1/completions`、`/v1/embeddings`。
7. **Responses API**：`/v1/responses`，可接 Codex CLI。
8. **SQLite 日志与配置**：写入 `~/.codebuddy-proxy/proxy.db`，可在管理页查询和改设置。

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
| `npm test` | 语法检查（`server.js` + `core/**` 自动遍历）+ 账号池策略回归测试 + Responses 转换层 / 版本更新回归测试（`scripts/`） |

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
| `/accounts` | 账号管理：OAuth 登录 / 从 VSCode 读取 / 手工导入、账号池策略（消耗模式 / 选号策略 / 会话粘性 / 定时切换 / 失败转移，均带 `?` 帮助）、**顶部全局自动签到开关**、签到状态与积分余额、账号冷却标记、活跃会话查看 |
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

## 账号池策略（会话粘性 / 选号 / 定时切换）

账号管理页在「消耗模式」下方有一块策略配置区，每一项都带 `?` 帮助。四种能力：

### 会话粘性（默认开启）

**解决的问题**：上游 `/v2/chat/completions` 是无状态的，代理原先每个 HTTP 请求都轮询换号。而 Codex / Cursor 跑一个任务要发几十次请求，于是**每轮 tool call 都换一个账号**——每个账号各自维护 prompt cache，等于每次都是冷启动，缓存命中率接近 0，且同一段上下文从多个账号发出。

开启粘性后，同一个任务**从始至终只用一个账号**，任务结束才释放。

会话识别三级回退（上游不返回 session id，只能推断）：

| 优先级 | 信号 | 说明 |
|---|---|---|
| 1 | `X-Session-Id` 请求头（也认 `X-Conversation-Id` / `X-CodeBuddy-Session`） | 客户端显式传则**权威生效**，最准 |
| 2 | 对话前缀指纹 | **零配置**。取所有 `system`/`developer` 消息 + 首条 `user` 消息算 sha256。agent 多轮 tool loop 中这部分逐字不变，天然稳定 |
| 3 | API 密钥 id | 兜底。一个客户端配一个密钥时，同密钥共用一个账号 |

> ⚠️ 已知边界：若客户端把时间戳、当前目录等**每次都变**的内容写进 system 提示词，前缀指纹会不稳定，粘性失效。此时改用 `X-Session-Id`，或把「会话粒度」设为「按 API 密钥」。

**会话何时结束**（决定何时可以换号）：

- 客户端显式传 `X-Session-End: 1` 头或 body 里 `sessionEnd: true`；
- 或者**绑定空闲超过「粘性有效期」**（默认 30 分钟）被自动清理。

绑定持久化在 SQLite（`session_bindings` 表，**只存指纹 hash，不存消息原文**），所以服务重启后正在进行的任务不会丢粘性。

### 选号策略

| 策略 | 逻辑 | 依赖 |
|---|---|---|
| `round-robin`（默认） | 每个新会话依次分配到下一个账号 | 无 |
| `quota-weighted` | 按剩余积分加权随机，剩余越多越容易被选中 | 积分余额 |
| `least-used` | 选「今日消耗」最少的账号，一天下来最均匀 | 积分余额 |

后两种依赖积分余额：服务端每 10 分钟（`quotaRefreshMin`）在后台刷新一次并缓存在**内存**，选号只读缓存，**绝不在请求热路径里发网络请求**。若拿不到积分数据，会自动退回 `round-robin` 并在管理页给出提示。

### 定时切换（默认关闭）

按固定间隔（默认 60 分钟 ±10 分钟随机抖动）把选号指针推进到下一个账号，让一天的额度消耗更均匀。

**关键：切换只影响之后新建的会话，绝不打断正在进行的任务。** 已在运行的会话继续用原账号直到任务结束或空闲超时。所以效果是「新任务逐渐分散到不同账号」，而不是「跑到一半被抢走」。

### 失败转移（默认开启）

某个账号被上游拒绝时（token 失效 401/403、被限流 429、额度耗尽），代理会：

1. 把它标记为**冷却中**（401/403 冷却 5 分钟、429 冷却 1 分钟、额度不足冷却 30 分钟），冷却期内选号跳过它；
2. 对**本次请求**换一个账号重试一次。

流式响应一旦已开始向客户端输出就无法重试，此时只做标记。管理页账号列表会给冷却中的账号打「冷却中」标记并显示原因与恢复时间。

### 排查

`GET /api/pool/sessions` 返回当前活跃的会话绑定（会话指纹 → 账号、请求数、最近活动）与处于冷却期的账号，用于排查「这个任务为什么用了某个账号」。管理页「活跃会话」按钮是它的图形入口。

### 池配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `stickyEnabled` | `true` | 会话粘性开关 |
| `stickyTtlMin` | `30` | 绑定空闲多久后释放（1–1440） |
| `stickyGranularity` | `auto` | `auto` / `fingerprint` / `apikey` |
| `strategy` | `round-robin` | `round-robin` / `quota-weighted` / `least-used` |
| `switchEnabled` | `false` | 定时切换开关 |
| `switchIntervalMin` | `60` | 切换间隔（1–1440） |
| `switchJitterMin` | `10` | 间隔随机抖动（0–720） |
| `quotaRefreshMin` | `10` | 额度缓存刷新间隔（1–1440） |
| `failoverEnabled` | `true` | 失败转移开关 |

以上字段都可用 `PUT /api/pool` 修改（带白名单与范围校验，非法值被忽略、超范围被夹取）。老库缺少这些字段时**自动补默认值，无需迁移**。

## 数据文件

默认都在 `~/.codebuddy-proxy/`（可用 `CODEBUDDY_DATA_DIR` 覆盖）：

| 文件 | 说明 |
|---|---|
| `session.json` | OAuth / VSCode 登录态（权限 `0600`），含 `accessToken`、`refreshToken`、账号。也可用 `CODEBUDDY_SESSION_FILE` 单独指定 |
| `proxy.db` | SQLite：`logs` 表 + `config` 表 + `models` 表（自定义模型）+ `api_keys` 表 + `usage` 表（用量统计）+ `accounts`/账号池 + `checkin_state`（自动签到状态）+ `credit_snapshots`（每日积分快照）+ `session_bindings`（会话粘性绑定，只存指纹 hash）。也可用 `CODEBUDDY_DB_FILE` 单独指定 |

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

### 会话粘性相关请求头（可选）

代理会自动用「对话前缀指纹」推断会话，通常**无需任何配置**。你的客户端若满足以下任一情况，可显式传头以获得更准的粘性：

```bash
# 多任务并发、或 system 提示词里含每次都变的内容（时间戳 / cwd）
curl http://127.0.0.1:3800/v1/chat/completions \
  -H "X-Session-Id: my-task-001" \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"你好"}]}'

# 任务明确结束时，告诉代理可以释放账号绑定（下一个任务就能换号）
curl http://127.0.0.1:3800/v1/chat/completions \
  -H "X-Session-Id: my-task-001" \
  -H "X-Session-End: 1" \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"结束了"}]}'
```

| 请求头 | 说明 |
|---|---|
| `X-Session-Id`（或 `X-Conversation-Id` / `X-CodeBuddy-Session`） | 显式指定会话 id，**优先级最高**，同一个 id 的请求固定用同一个账号 |
| `X-Session-End: 1` | 声明本次请求结束了一个会话，代理随即释放该会话的账号绑定 |
| `X-CodeBuddy-Account`（或 `X-Account-Id` / `X-Account-Name`） | 显式指定本次请求用哪个账号（优先级高于会话粘性与池策略，且不写入绑定） |

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

实测（Codex CLI 0.153）：文本回复、shell 工具调用、多轮 tool loop 均正常。

> 1. Codex 可能提示 `Model metadata for '...' not found`（自定义模型不在 Codex 内置目录），不影响使用。
> 2. CodeBuddy 会拦截含 `Codex` / `OpenAI` 的系统提示词（`11128 Illegal API invocation from an unapproved channel`）。代理会净化 `instructions` / `developer` 系统消息（`Codex`→`CodeBuddy`、`OpenAI`→`Tencent`），用户消息和工具参数不动。

### Responses → chat/completions 转换说明

上游 `copilot.tencent.com` **只有 `chat/completions`，没有 `Responses` 路由**（`POST /v1/responses`、`/v2/responses` 均返回 `404 Route Not Found`），所以本代理必须做协议转换。转换中需要特别注意的几点：

- **工具展平**：Codex 会下发多种工具类型，其中 `namespace`（内置工具组，如 `multi_agent_v1`、`mcp__cua_repl`、`mcp__node_repl`）与 `web_search` 不是 `chat/completions` 认识的 `type: 'function'`。代理会把它们**展平成 function 工具**（子工具命名为 `命名空间__子工具`，如 `multi_agent_v1__spawn_agent`），而不是丢弃——早期版本会静默丢掉这些工具，导致 Codex 的子代理 / 浏览器 / node_repl 等内置工具全部不可用。上游回传工具调用时再还原成 Codex 认得的原始子工具名；历史里的 `function_call` 也会重新映射回扁平名，保证多轮 tool loop 不断链。
- **思维链（reasoning）**：上游用 `delta.reasoning_content` 回传思维链，代理会转成 `response.reasoning_summary_text.delta` 等 Responses 事件（`reasoning` 输出项固定排在 `output_index: 0`，正文与工具调用依次后移）。早期版本只累加不发送，流式下思维链完全丢失。同时兼容 `delta.reasoning` 为字符串或对象（`{content}`）的写法；若 reasoning 在正文/工具调用**之后**才到达，则只并入最终 `response.completed`，不再补发流式事件（补发会破坏已发出的 `output_index`）。
- **`output_index` 分配**：`output_index` 按「基址 + 固定位置」统一计算（`reasoning` 占 0，其后依次是各 `function_call`，`message` 排最后），`output_item.added` 与 `output_item.done` 必须用同一公式，且 index 连续无空洞、item 按 index 升序完结。早期版本在 `added` 时重复计入了一次工具数量，导致**多个工具调用时**同一 item 的 `added`/`done` 拿到不同 index（单工具时碰巧正确，不易发现）。
- **`max_output_tokens`**：上游只认 `max_tokens`，代理会做字段改名（`max_output_tokens` / `max_completion_tokens` 在上游是**静默忽略**的）。
- **usage**：主动带 `stream_options: { include_usage: true }`，确保流式末块带上 token 用量。
- 上游对 `temperature` / `top_p` / `stop` / `presence_penalty` / `response_format` 等参数**静默忽略**（不报错也不生效），`tools` / `messages` / 数组形式的 `content` 则正常支持。

#### 已知限制：Codex 的 namespace 子工具（浏览器 / 子代理）无法调用

用非 OpenAI 官方 provider（即 `wire_api = "responses"` 的自定义 base_url，也就是本代理这种用法）时，**Codex 自己不会把 `namespace` 里的子工具注册成可调用项**。表现是模型发起调用后 Codex 打印：

```
ERROR codex_core::tools::router: error=unsupported call: mcp__cua_repl__js
```

这**不是代理丢工具**——代理已把 `mcp__cua_repl/js` 正确展平成 `mcp__cua_repl__js` 发给上游（可在「记录完整请求体」日志的 `convertedTools` 里看到），上游也正常返回了调用。断点在 Codex 侧的路由器。实测对照（Codex CLI 0.153）：

| 回传的工具名 | 结果 |
|---|---|
| `exec_command`（普通 function 工具） | ✅ 正常执行 |
| `write_stdin` / `view_image` / `create_goal` | ✅ 正常执行 |
| `js`（子工具裸名） | ❌ `unsupported call: js` |
| `mcp__cua_repl__js`（扁平名） | ❌ `unsupported call: mcp__cua_repl__js` |
| `mcp__cua_repl.js` / `mcp__cua_repl:js` | ❌ 同样失败 |

也就是说，**普通 function 工具（`exec_command` / shell / apply_patch 等）完全可用，namespace 子工具在当前 Codex 版本下怎么命名都调不通**，属于 Codex 上游问题，代理侧无法绕过。相关 issue：[openai/codex#23186](https://github.com/openai/codex/issues/23186)、[#26234](https://github.com/openai/codex/issues/26234)、[#26977](https://github.com/openai/codex/issues/26977)、[#42488](https://github.com/openai/codex/issues/42488)。

> 之所以仍然把 namespace/web_search 展平转发而不是丢弃：一是让**模型**能看到这些工具的存在并正确理解自身能力边界，二是等 Codex 修好后无需再改代理；三是部分客户端（非 Codex）能正常路由这些名字。

### 排查 agent 客户端请求

想看 Codex / Cursor 等客户端到底发了什么，可在「系统配置 → 记录完整请求体」打开 `logging.requestBody`（或用 API 设置）。开启后每次请求会把**原始请求体全文**写入日志（分类 `responses` / `proxy`，条目形如 `[request body] /v1/responses 34325 bytes`），meta 里附带 `toolTypes`（各类型工具计数）与 `convertedTools`（转换后发给上游的工具名列表）。请求体可能较大且包含对话内容，默认关闭，排查完建议关掉；`logging.requestBodyMaxKb` 控制截断上限。

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
| `CODEBUDDY_UPDATE_BRANCH` | `main` | 版本检查读取的 GitHub 分支（自更新也按该分支 `git pull`） |

国际版可设 `CODEBUDDY_ENDPOINT=https://www.codebuddy.ai`。

## 系统配置（管理页 / API）

`GET /api/config` 读取，`PUT /api/config` 更新，持久化在 SQLite `config` 表。

```bash
curl -X PUT http://127.0.0.1:3800/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "logging": { "enabled": true, "details": true, "requestBody": false, "requestBodyMaxKb": 256, "level": "info", "retentionDays": 7, "maxRows": 10000 },
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
| `logging.requestBody` | `false` | 把客户端发来的**完整请求体**写入日志（含 `messages` / `tools` / `input`），用于排查 Codex 等 agent 客户端的调用问题 |
| `logging.requestBodyMaxKb` | `256` | 请求体日志截断上限（KB），**按 UTF-8 字节**截断（不会切碎中文，结果不会超出上限） |
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
| GET | `/api/accounts` | 账号池列表 + 池配置 + 全局 `autoCheckin` 开关 + 各账号健康度/额度缓存（`quotaReady` 表示额度数据是否可用） |
| PUT | `/api/accounts` | 全局自动签到开关（body `{ autoCheckin }`） |
| PUT | `/api/accounts/:id` | 重命名（body `{ name }`） |
| POST | `/api/accounts/login` | 发起 OAuth 登录，返回 `authUrl` |
| GET | `/api/accounts/login/status` | 查询 OAuth 登录进度 |
| POST | `/api/accounts/import` | 用 refresh_token 手工导入账号 |
| DELETE | `/api/accounts/:id` | 删除账号（同时清理其签到状态、积分快照与会话绑定） |
| GET | `/api/pool` | 读取账号池配置（含粘性/策略/定时切换/失败转移字段） |
| PUT | `/api/pool` | 更新账号池配置（白名单 + 范围校验） |
| GET | `/api/pool/sessions` | 当前活跃的会话绑定 + 处于冷却期的账号（排查用） |
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
| GET | `/api/update/check` | 检查 GitHub 上的最新版本（只读，不修改任何文件） |
| POST | `/api/update/apply` | 执行自更新：`git pull` → 按需 `npm install` → `npm run build`（Linux/macOS 随后自动重启） |

## 版本更新提示

管理页右上角的版本徽标会自动检查 GitHub 上的最新版本：

- 有新版时徽标变绿并显示 `v1.1.1 → v1.2.0`，点击打开更新面板。
- 点「立即更新」会依次执行 **`git pull` →（`package.json` 变化时）`npm install` → `npm run build`**，每步结果都显示在面板里。
- 版本来源是 `raw.githubusercontent.com` 上 `main` 分支的 `package.json`（无需 token，也不受 GitHub API 限流影响）。可用 `CODEBUDDY_UPDATE_BRANCH` 换分支。

### 更新后如何重启（按系统区分）

| 系统 | 行为 |
|---|---|
| **Linux / macOS（裸进程）** | **自动重启**：服务端先 `close()` 释放端口，再以原 `argv`/`cwd` 拉起新进程（`detached` + `stdio: inherit`），随后旧进程退出。前端会轮询 `/health`，服务起来后**自动刷新页面**，全程无需操作。 |
| **Linux + systemd** | **提示手动重启**：面板给出 `sudo systemctl restart codebuddy-proxy`。代理*不会*自行重启——它是 `spawn` 新进程再让主进程退出，而 systemd 见主进程退出会按 `Restart=always` 再拉一个，两个进程抢同一端口；且新进程会脱离 unit 的 cgroup，日志不再进 journald。 |
| **Windows** | **提示手动重启**：子进程易产生孤儿进程与端口占用（`EADDRINUSE`），面板提示关闭进程后重新 `npm start`，并提供「刷新页面」按钮。 |

启动时会自动识别是否由 systemd 托管（检测 `INVOCATION_ID` / `JOURNAL_STREAM`），无需手工配置。

自动重启最多等待 60 秒；超时会在面板里提示（服务可能启动失败），此时需手动检查。

**安全约束**（`core/update.js`）：

- **工作区有未提交改动时拒绝更新**，避免 `git pull` 覆盖你的本地修改；面板会提示先 `git stash` 或提交。
- 非 git 仓库、未配置 `origin` 远端时同样拒绝，并给出手动更新命令。
- 外部命令一律用 `execFile` + 参数数组（不拼 shell 字符串），避免命令注入。
- 同一时刻只允许一个更新任务，并发请求返回 `409`。

**为什么要重启**：`git pull` 改的是磁盘上的 `core/*.js`，而进程里已加载的仍是旧代码，所以服务端改动必须重启才生效。前端资源有新哈希、刷新即可，但服务端代码不行。重启方式见上面的系统对照表。

> ⚠️ 该功能要求部署目录是一个**干净的 git 工作区**。若你是下载 zip 解压部署的（没有 `.git`），徽标仍会提示有新版本，但「立即更新」会禁用并给出手动命令。

> ⚠️ 若用 `pm2` / `systemd` 等进程管理器托管，代理不会自行重启（原因见上表），请在管理器侧重启。systemd 会自动识别并给出命令；pm2 请手工执行 `pm2 restart <name>`。

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
  session.js       登录态 / 账号池 / 会话粘性 / 选号策略 / 账号健康度
  sessionScheduler.js  账号池调度（定时切换 + 额度缓存刷新 + 绑定清理）
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
  update.js        版本检查与自更新（git pull + 构建）
web/               管理页源码（Vite + Vue）
dist/              管理页构建产物
scripts/           校验脚本
  check-all.js     语法检查（server.js + core/ 遍历）
  test-account-pool.js  账号池策略回归测试（会话粘性 / 定时切换 / 健康度 / 选号）
  test-responses.js  Responses 转换层回归测试
  test-update.js   版本比较与自更新护栏测试
```

## 安全提示

- 默认只监听 `127.0.0.1`，不要直接暴露到公网。
- `session.json` 含明文 token；`/api/status` 只返回打码 token。
- 解密 VSCode 密钥需要本机钥匙串权限（macOS 首次可能弹授权）。

## License

[MIT](LICENSE)
