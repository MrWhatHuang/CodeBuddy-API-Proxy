# CodeBuddy API Proxy — 维护指南（给后续智能体）

> 本文件写给**后续接手维护的 AI 智能体/人类**，重点是「这个项目是怎么工作的、有哪些坑、改哪里」。
> 面向最终用户的说明见 `codebuddy-proxy/README.md`。

## 1. 一句话定位

一个**零依赖**的 Node 单文件代理（`codebuddy-proxy/server.js`），把本地 VSCode 里**腾讯云 CodeBuddy 插件**的登录态/API 暴露成 **OpenAI 兼容接口**（`/v1/chat/completions` + `/v1/responses`），供 Cursor / Codex CLI / OpenAI SDK 等工具调用。

核心卖点：

- **启动即读 VSCode 插件已保存的 token**（逆向解密 Electron SecretStorage），无需重新登录。
- **Codex CLI 可用**：内置 Responses API（`/v1/responses`）双向转换层。

## 2. 环境与运行

- 纯 Node 内置模块，**无 npm 依赖**。需要 **Node ≥ 22.5**（用了内置 `node:sqlite`，实测 Node 24 可用）。
- 启动：
  ```bash
  cd codebuddy-proxy
  node server.js                 # 默认 127.0.0.1:3800，自动打开 /home 管理页
  CODEBUDDY_NO_OPEN=1 PORT=3800 node server.js   # 后台调试用：不弹浏览器
  ```
- 语法检查：`node --check server.js`。
- 会话文件：`~/.codebuddy-proxy/session.json`（权限 0600，存 OAuth 后的 access/refresh token）。

## 3. 文件结构

```
deepseek/
├── .agents/README.md          # 本文件（给智能体的维护指南）
└── codebuddy-proxy/
    ├── server.js              # 全部逻辑，单文件 ~1420 行
    └── README.md              # 用户文档（接口、环境变量、Codex 接入）
```

## 4. 代码地图（server.js 分节，行号为当前版本，改动后可能漂移）

| 行号区间  | 分节注释                  | 内容                                                                                                                                                                                                       |
| --------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 44–63     | 配置                      | 环境变量、常量（`ENDPOINT`/`PREFIX_PATH`/`SESSION_FILE` 等）                                                                                                                                               |
| 64–87     | 模型目录                  | `MODEL_CATALOG`：18 个模型的 id/name/上下文长度/tools/vision                                                                                                                                               |
| 88–148    | 会话存储                  | 全局 `session` + `sessionSource`、`normalizeSession/loadSession/saveSession/clearSession/isLoggedIn`                                                                                                       |
| 149–322   | 工具                      | `log`、`requestJson`、`requestRaw`、`aggregateSseToCompletion`、`pipeToClient`、`readBody`、`sendJson/sendHtml`、`escapeHtml`、`maskedToken`                                                               |
| 324–409   | VSCode SecretStorage 读取 | `getKeychainPassword`、`decryptSafeStorage`、`readSecretFromDb`、`readVscodeSession`（**仅 macOS**）                                                                                                       |
| 410–475   | 认证逻辑                  | `buildNoAuthHeaders`、`authPath`、`isExpiring`、`refreshToken`、`getValidSession`、`buildAuthHeaders`                                                                                                      |
| 476–552   | OAuth 登录                | `pendingLogins`、`fetchAuthState`、`pollAuthToken`、`fetchAccount`、`fetchAccounts`、`completeLogin`                                                                                                       |
| 553–628   | OpenAI 兼容转发           | `UPSTREAM_MAP`、`handleProxy`（`/v1/chat/completions` 等 → `/v2/...`，含非流式聚合）                                                                                                                       |
| 630–1043  | Responses API 转换        | `genId`、`sanitizeForBackend`、`contentToText`、`convertToolChoice`、`responsesToChatInput`、`convertUsage`、`buildResponseObject`、`chatCompletionToResponse`、`streamChatToResponses`、`handleResponses` |
| 1044–1066 | 状态 API                  | `statusObject`                                                                                                                                                                                             |
| 1067–1291 | 页面                      | `homePage`（管理页 HTML）、`loginPage`、`modelsResponse`                                                                                                                                                   |
| 1292–1372 | 路由                      | `route`（所有 HTTP 端点分发）                                                                                                                                                                              |
| 1374–1422 | 启动                      | `openBrowser`、`http.createServer`、`server.listen`（启动时 `readVscodeSession → loadSession` 兜底）                                                                                                       |

## 5. 核心数据流

### 启动登录态（三级兜底）

```
readVscodeSession()   # 1. 解密 VSCode 插件 SecretStorage（macOS）
  ↓ 失败
loadSession()         # 2. 读 ~/.codebuddy-proxy/session.json
  ↓ 失败
提示用户打开 /home 登录（OAuth 流程）
```

全局变量：`session`（`{account, auth, accounts}`）、`sessionSource`（`'vscode' | 'oauth' | 'file'`）。

### 请求分发（route）

```
POST /v1/chat/completions  ──→ handleProxy  → POST /v2/chat/completions（流式透传 / 非流式聚合）
POST /v1/responses         ──→ handleResponses → 转成 /v2/chat/completions，再把结果转回 Responses 格式
GET  /v1/models            ──→ modelsResponse()
GET  /api/status|/health|/session|/login*|/logout  → 各自处理
```

### 会话对象形状（normalizeSession 产物）

```js
{
  account: { uid, nickname, type, enterpriseId, departmentFullName, lastLogin },
  auth: {
    accessToken, refreshToken, tokenType, domain,
    expiresIn, expiresAt, refreshExpiresIn, refreshExpiresAt, lastRefreshTime,
  },
  accounts: [ /* 多账号 */ ],
}
```

## 6. 逆向得到的协议知识（最宝贵、别丢）

### 6.1 认证接口（外部链接登录 external-link-v2）

| 项目       | 值                                                                 |
| ---------- | ------------------------------------------------------------------ |
| 后端       | `https://copilot.tencent.com`（国际版 `https://www.codebuddy.ai`） |
| prefixPath | `/plugin`（`CODEBUDDY_PREFIX_PATH`）                               |
| 登录类型   | `external-link-v2`                                                 |
| 对话接口   | `POST /v2/chat/completions`（**只支持流式**）                      |
| 补全/向量  | `POST /v2/completions`、`POST /v2/embeddings`                      |

流程：`POST /v2/plugin/auth/state?platform=VSCode` → `{state, authUrl}`；浏览器登录后轮询 `GET /v2/plugin/auth/token?state=…`（code `11217`=登录中）；`GET /v2/plugin/login/account?state=…`；`GET /v2/plugin/accounts`。

刷新：`POST /v2/plugin/auth/token/refresh`，headers `X-Refresh-Token` / `X-Auth-Refresh-Source: plugin` / `X-Domain`。

业务头：`Authorization: Bearer <token>`、`X-User-Id`、`X-Enterprise-Id`/`X-Tenant-Id`（企业）、`X-Domain`。

### 6.2 VSCode SecretStorage 解密（macOS 已实测验证）

- 数据在 `~/Library/Application Support/Code/User/globalStorage/state.vscdb`（SQLite 表 `ItemTable(key,value)`）。
- key：`secret://{"extensionId":"tencent-cloud.coding-copilot","key":"Tencent-Cloud.coding-copilot.new.accessToken"}`。
- value：`{"type":"Buffer","data":[...]}`。
- 加密 = Electron safeStorage = Chromium OSCrypt `v10`：
  - 密钥：`PBKDF2-SHA1(password, salt="saltysalt", iterations=1003, dkLen=16)`；
  - 算法：AES-128-CBC，**IV = 16 个空格（0x20），无存储 IV**（本机实测；随机 IV 反而不对）；
  - 密文格式：`"v10"`(3 字节) + 密文（后面没有单独存 IV）。
  - PBKDF2 的 password = 钥匙串里 `security find-generic-password -s 'Code Safe Storage' -w` 的输出（base64 字符串，**直接用**，不 decode）。
- `decryptSafeStorage` 里保留了多策略回退（`v10+randomIV` / `fixedIV(spaces)` / `fixedIV(nul)` / `fixedIV(0123)`），用 `JSON.parse` 成功与否判定正确策略。
- 其它编辑器目录在 `VSCODE_CANDIDATES`（Insiders/Cursor/VSCodium/Windsurf/Trae 等）。

### 6.3 三个「后加」的关键修复（对应代码里的注释）

1. **CodeBuddy 对话接口只支持流式**：非流式请求要强制 `stream:true`，再用 `aggregateSseToCompletion` 聚合（见 `handleProxy` 的 `needAggregate`）。
2. **CodeBuddy 后端有内容过滤器**：拦截含 **"Codex"/"OpenAI" 品牌词的系统提示词**，返回 `11128 "Illegal API invocation from an unapproved channel"`。用 `sanitizeForBackend` 净化（`Codex`→`CodeBuddy`、`OpenAI`→`Tencent`）。
   - ⚠️ **必须角色感知**：只净化 `instructions` / `developer`/`system` 消息，**不能动 user/assistant/tool 内容**（否则会篡改用户输入，实测 `echo hello-from-codex` 会被改成 `hello-from-CodeBuddy`）。
3. **usage 字段名要转换**：chat 的 `prompt_tokens/completion_tokens` 必须转成 Responses 的 `input_tokens/output_tokens`（`convertUsage`），否则 Codex 报 `failed to parse ResponseCompleted: missing field 'input_tokens'`。

## 7. 坑与陷阱（踩过的、别再踩）

- **`node:sqlite` 的 SQL 字符串**：用单引号 `'table'`，双引号会被当成列名（`no such column`）。
- **SSE 分隔符**：CodeBuddy 上游用 `\n\n`（`0a 0a`，用 `xxd` 确认；macOS 的 `cat -A` 不存在，用 `xxd` 或 `od -c`）。
- **流式分支必须 `res.end()`**：`streamChatToResponses` 曾漏写 `clientRes.end()`，导致连接挂起、curl 超时。改流式代码务必确认所有分支都 end。
- **写 SSE 前先 writeHead**：`handleResponses` 先 `writeHead(200, text/event-stream)`，若上游返回非 SSE（错误），不能再 `writeHead`（`ERR_HTTP_HEADERS_SENT`）；要改成读 body 后走 `response.failed` 事件（已处理）。
- **`shell` 单引号冲突**：调试时别写 `node -e '...包含单引号...'`，写到临时 `.js` 文件再 `node`。
- **Windows 上 `execFile('npm.cmd')` 会抛 `spawn EINVAL`**：Node 18+ 对 `.cmd/.bat` 要求 `shell: true`（CVE-2024-27980 的缓解）。`core/update.js` 的 `run()` 已按 `\.(cmd|bat)$/` 自动加 `shell`，**改动那里时别把它删掉**，否则更新到 `npm install`/`npm run build` 这一步必失败。
- **自更新不能在有本地改动时 pull**：`applyUpdate()` 先用 `git status --porcelain` 判定，脏工作区直接拒绝。这是有意为之——`git pull` 会覆盖未提交修改。别为了「让更新更顺」去掉这个判断。
- **自更新不自动重启**：`git pull` 只改磁盘文件，进程内已是旧代码。刻意不做自动重启（Windows 上易产生孤儿进程 / 端口占用），由面板提示用户手动重启。
- **测试自更新别在真实仓库上跑**：`git pull`/`npm install` 有副作用。用 `git clone` 到临时目录再测（`scripts/test-update.js` 只测护栏与纯逻辑，不真的 pull）。
- **token 别泄露**：任何输出/日志里 token 都要打码（用 `maskedToken` 或手动截断）；`/session` 返回明文，生产要删或加鉴权。
- **`CODEBUDDY_DEBUG=1`** 会把最近一次 `/v1/responses` 的原始请求+转换结果 dump 到 `/tmp/codebuddy-debug-last.json`（含用户 prompt），仅调试用。

## 8. 测试方法

```bash
# 1. 语法
node --check server.js

# 2. 起服务（后台）
CODEBUDDY_NO_OPEN=1 PORT=3800 node server.js

# 3. 冒烟
curl -s http://127.0.0.1:3800/health                     # {"ok":true,"loggedIn":true}
curl -s http://127.0.0.1:3800/api/status                 # 登录态（token 打码）
curl -s http://127.0.0.1:3800/v1/models                  # 模型列表

# 4. chat 非流式/流式
curl -s http://127.0.0.1:3800/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"default","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
curl -sN http://127.0.0.1:3800/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"default","stream":true,"max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'

# 5. Responses 非流式/流式
curl -s http://127.0.0.1:3800/v1/responses -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","input":"hi","max_output_tokens":8}'
curl -sN http://127.0.0.1:3800/v1/responses -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","stream":true,"input":"hi","max_output_tokens":8}' | grep -oE 'event: [a-z._]+'

# 6. Codex CLI 端到端（若本机装了 ~/.codex/plugins/.plugin-appserver/codex）
cd /tmp && OPENAI_API_KEY=dummy codex exec --skip-git-repo-check --ephemeral -s read-only -C /tmp "say PONG"
```

验证标准：`/v1/responses` 流式应输出完整事件序列
`response.created → in_progress → output_item.added → content_part.added → output_text.delta → output_text.done → content_part.done → output_item.done → completed`；工具调用多出 `output_item.done` 里的 `function_call` 项（含完整 name/arguments）。

## 9. 常见维护任务

| 任务              | 改哪里                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| 加/改模型         | `MODEL_CATALOG`（第 64 行起）；同时更新 `README.md` 模型表                                                    |
| 加环境变量        | 配置区（第 44 行起）+ `README.md` 环境变量表                                                                  |
| 加新端点          | `route`（第 1292 行起）分发；转发类加 `UPSTREAM_MAP`，特殊逻辑加 `handleProxy`/`handleResponses`              |
| 改 Responses 转换 | `responsesToChatInput`（请求）、`streamChatToResponses`（流式响应）、`chatCompletionToResponse`（非流式响应） |
| 改解密策略        | `decryptSafeStorage`（第 349 行），用 `JSON.parse` 判定策略对错                                               |
| 调试 Codex 请求   | 设 `CODEBUDDY_DEBUG=1`，读 `/tmp/codebuddy-debug-last.json`                                                   |
| 改版本检查 / 自更新 | `core/update.js`（`checkRemoteVersion` / `applyUpdate`）+ `core/routes.js` 的 `/api/update/*`；前端在 `web/src/components/TopBar.vue` |
| 发版 / 改版本号   | `package.json` 的 `version`（唯一来源，见第 10.1 节）；改完必须重新 `npm run build`                            |

## 10. 约定与规范

- 函数 `camelCase`；分节用 `/* ============================ X ============================ */`。
- 响应统一走 `sendJson(res, status, obj)` / `sendHtml(res, status, html)`；请求体用 `readBody(req)`。
- 日志统一 `log(level, msg)`（level：info/warn/error）。
- 上游 JSON 请求用 `requestJson`（返回 `{status, headers, body, json}`），收 SSE 用 `requestRaw`（返回原始字符串）。
- 全局状态只有 `session` 和 `sessionSource`，别再加散落全局。
- 改完必跑 `node --check` + 上面第 8 节冒烟测试；提交前按第 10.1 节的清单确认**版本号**是否该动（**新增配置项/端点即使写在 `fix:` 里也要升 MINOR**）。

### 10.1 版本号更新规则（改代码必读）

**唯一来源是 `package.json` 的 `version` 字段**，不要在别处（前端、`core/config.js`、README 表格）再写一份版本号常量。运行时链路是：

```
package.json.version
  → core/config.js 的 VERSION（require 读取，带 '1.0.0' 兜底）
  → core/routes.js 的 GET /api/config 里的 runtime.version
  → 管理页右上角 TopBar 的版本徽标 + /settings「运行时信息 · 版本」
```

启动日志也会打印 `服务已启动 (v<version>)`。

**何时必须动版本号**（只增不减，遵循 [SemVer](https://semver.org/lang/zh-CN/)）：

| 改动性质 | 版本位 | 例子 |
| --- | --- | --- |
| 破坏兼容：改接口路径 / 请求响应结构、删环境变量或配置项、改数据表结构导致旧库需迁移 | **MAJOR** | `/v1/responses` 字段改名 |
| 新增功能且向后兼容：新端点、新模型、新环境变量/配置项、新页面 | **MINOR** | 新增 `/api/keys` 或管理页新页面 |
| 修 bug、内部重构、纯文案/样式、依赖升级 | **PATCH** | 修复图片被压平成文本；加版本徽标 |

#### ✅ 提交前必查：这次改动要不要动版本号？

**先跑一遍这个清单**，任何一条命中就必须升版本（多条命中取最高的那一档）：

```bash
# 1) 有没有新增/删除配置项或环境变量？（MINOR / MAJOR）
git diff HEAD~1 -- core/config.js | grep -E "^[+-]\s*'[a-zA-Z.]+':"

# 2) 有没有新增端点或路由？（MINOR）
git diff HEAD~1 -- core/routes.js core/openai.js | grep -E "^\+.*(pathname ===|UPSTREAM_MAP)"

# 3) 有没有改请求/响应结构或数据表结构？（MAJOR）
git diff HEAD~1 -- core/store.js core/responses.js | grep -E "^\+.*(CREATE TABLE|ALTER TABLE|schema)"

# 4) 只是修 bug / 重构 / 文案？（PATCH）
git diff HEAD~1 --stat
```

**典型误判（真实踩过，务必避开）**：

- ❌ **「只是修 bug，所以不用动版本」——错。** 如果一个 `fix:` 提交**顺带**加了新配置项、新端点或新页面，那它就是 **MINOR**，不是 PATCH。按主题词（`fix:`→PATCH）判断是这个规则最容易失效的地方：**版本位由「改动内容」决定，不由 commit 前缀决定**。
  - 实例：`fix: 修复 Responses 流式 output_index…` 同时新增了 `logging.requestBody` / `logging.requestBodyMaxKb` 两个配置项，按表应为 **MINOR**（1.1.1 → 1.2.0），而不是停在 1.1.1。
- ❌ **「改动很小，不值得升版本」——错。** 只要能被用户观察到（行为修复、配置项、界面文案），就该有版本痕迹。
- ❌ **「等发版时再一起升」——仅限本地开发期。** 一旦推到远端 / 部署到服务器，必须已经在版本号上体现，否则无法从管理页判断线上跑的是哪一版。
- ✅ 「同一版本号下多次提交」是允许的：开发中途可以攒着，**但推送到远端或部署前必须补上**。

**判断不准时**：宁可升 MINOR（多升一档的代价远小于「修了 bug 但线上看不出是哪版」）。

**怎么改**（三处必须同步，缺一不可）：

1. `package.json` 的 `version` 改成新值（**只改这一处版本号**）。
2. 跑 `npm run build` 重新构建 `dist/`。
   - ⚠️ 改 `web/` 下任何源码后**必须**重建：`core/build.js` 会比较 `web/` 与 `dist/` 的 mtime，不重建则管理页顶部出现「需要重新构建」告警，而**版本徽标读的是服务端 `runtime.version`，与 `dist/` 无关** —— 这就是「API 显示新版本、页面还是旧的」这类困惑的根源。
   - 只改 `core/`（不动 `web/`）时可以跳过重建。
3. 提交信息用 `chore: 发布 vX.Y.Z` 或把版本写进 `feat:` / `fix:` 主题里，方便回溯。

**注意事项**：

- 同一版本号下多次提交是允许的（开发过程中不必每提交都改版本）；**对外发布 / 部署到服务器时必须体现版本变化**，否则无法从管理页判断线上跑的是哪一版。
- 改版本号**不需要**动数据库、环境变量或任何运行时配置；`VERSION` 是进程启动时读一次的，**必须重启服务才会生效**。
- 不要为了「让页面显示新版本」而只改 `dist/` 里的产物或在前端写死版本号 —— 前端写死必然与服务端漂移。
- 版本号与 `logs`、`session.json`、`proxy.db` 的存储格式无关；数据层的版本字段（如账号池 `version: 2`）是独立概念，别混用。

## 11. 安全注意

- 默认只监听 `127.0.0.1`（`HOST`），**别改成 0.0.0.0 暴露公网**。
- `session.json` 0600；token 只在内存 + 该文件里，日志/响应要打码。
- 解密 VSCode 密钥需要本机钥匙串读权限，macOS 首次可能弹授权。
- `sanitizeForBackend` 是绕过 CodeBuddy 竞品内容过滤的必要手段；若上游改规则（换了拦截词），对应调它即可，但**务必保持角色感知**。
