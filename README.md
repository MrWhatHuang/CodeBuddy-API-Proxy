# CodeBuddy API Proxy

把本地 VSCode 里 **腾讯云 CodeBuddy** 插件的登录态 / API 代理成一个 **OpenAI 兼容接口**，供其它 agent 工具（Cursor、Continue、OpenAI SDK 客户端等）直接调用。

> 纯 Node 内置模块实现，无需 `npm install`，单文件即可运行。

## 核心特性

1. **直接读 VSCode 插件登录态**：启动时自动从 VSCode 的 SecretStorage 里解密出 CodeBuddy 已保存的 token（无需重新登录）。读不到时再走 OAuth 登录。
2. **启动自动打开管理页** `http://127.0.0.1:3800/home`。
3. **OpenAI 兼容**：`/v1/chat/completions`（流式 + 非流式自动聚合）、`/v1/completions`、`/v1/embeddings`。
4. **Responses API**：`/v1/responses`（OpenAI Responses API 格式，流式 + 非流式），可接 **Codex CLI** 等工具。

## 运行

```bash
node server.js
```

> 需要 Node ≥ 22.5（读取 VSCode 密钥用到内置 `node:sqlite`；实测 Node 24 可用）。

启动后浏览器会自动打开管理页。若想关闭自动打开：

```bash
CODEBUDDY_NO_OPEN=1 node server.js
```

## 三个问题的直接回答

### 1. OAuth 登录后的 refreshToken 存到哪了？

存到本地会话文件 **`~/.codebuddy-proxy/session.json`**（权限 `0600`），里面包含 `auth.accessToken`、`auth.refreshToken`、账号信息等。路径可用 `CODEBUDDY_SESSION_FILE` 覆盖。

### 2. 默认能直接取 VSCode 插件保存的 token 吗？

**能。** 启动时优先级：

1. **VSCode 插件 SecretStorage**（macOS 自动解密）—— 本机已验证可用；
2. 本地会话文件 `session.json`；
3. 都没有 → 提示 OAuth 登录。

实现细节（逆向自插件）：token 存在 VSCode 的 `state.vscdb`（SQLite 表 `ItemTable`）里，key 为
`secret://{"extensionId":"tencent-cloud.coding-copilot","key":"Tencent-Cloud.coding-copilot.new.accessToken"}`，
值用 Electron `safeStorage` 加密：`PBKDF2-SHA1(钥匙串密码, "saltysalt", 1003, 16)` 派生 AES-128-CBC 密钥，
密文前缀 `v10`，IV 为 16 个空格。钥匙串服务名为 `Code Safe Storage`。
（也支持 Code - Insiders / Cursor / VSCodium / Windsurf / Trae 等目录。）

管理页有「从 VSCode 重新读取」按钮，或调用 `GET /api/import-vscode`。

### 3. 管理页

启动自动打开 `http://127.0.0.1:3800/home`，包含：

- 模型列表（18 个，含名称/上下文/tool/vision 标签）
- 当前登录状态（用户、UID、域名、来源、token 过期时间）
- 一键复制代理地址
- 快速测试 curl、接口一览、登录/退出/重读按钮

## 逆向提取的认证机制

| 项目 | 值 |
|---|---|
| 后端 | `https://copilot.tencent.com`（国际版 `https://www.codebuddy.ai`）|
| 认证 prefixPath | `/plugin` |
| 登录类型 | `external-link-v2` |
| 对话接口 | `POST /v2/chat/completions`（**仅支持流式**，非流式由本代理聚合）|
| 补全接口 | `POST /v2/completions` |
| 向量接口 | `POST /v2/embeddings` |

登录流程：

```
POST /v2/plugin/auth/state?platform=VSCode      → { state, authUrl }
   浏览器打开 authUrl 完成登录
GET  /v2/plugin/auth/token?state=...            → 轮询 token（code 11217 = 登录中）
GET  /v2/plugin/login/account?state=...         → 账号（Bearer）
```

刷新：

```
POST /v2/plugin/auth/token/refresh
Headers: X-Refresh-Token, X-Auth-Refresh-Source: plugin, X-Domain
```

鉴权头：

```
Authorization: Bearer <accessToken>
X-User-Id: <uid>
X-Enterprise-Id / X-Tenant-Id: <enterpriseId>   # 企业版
X-Domain: <domain>
```

## 使用示例

```bash
# 流式
curl -N http://127.0.0.1:3800/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"default","stream":true,"messages":[{"role":"user","content":"你好"}]}'

# 非流式（代理自动聚合）
curl http://127.0.0.1:3800/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"你好"}]}'
```

把其它工具的 base_url 指向 `http://127.0.0.1:3800/v1` 即可。

## 接 Codex CLI（Responses API）

Codex 用的是 `/v1/responses` 格式，代理已内置转换（请求 → `chat/completions`，响应 → Responses API 事件流）。在 `~/.codex/config.toml` 配置：

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

然后设一个假的 `OPENAI_API_KEY`（代理忽略它，真正鉴权用的是 CodeBuddy token）：

```bash
export OPENAI_API_KEY=dummy
codex exec "你的任务"
```

实测（Codex CLI 0.148）：文本回复、shell 工具调用、多轮 tool loop 均正常。

> ⚠️ 两个已知点：
> 1. Codex 会提示 `Model metadata for '...' not found`（自定义模型不在 Codex 内置目录里），属正常警告，不影响使用。
> 2. **CodeBuddy 后端会拦截含 "Codex"/"OpenAI" 品牌词的系统提示词**（返回 `11128 Illegal API invocation from an unapproved channel`）。代理会自动净化 `instructions` / `developer` 系统消息（`Codex`→`CodeBuddy`、`OpenAI`→`Tencent`），用户消息与工具参数不受影响。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `CODEBUDDY_PROXY_PORT` | `3800` | 监听端口 |
| `HOST` / `CODEBUDDY_PROXY_HOST` | `127.0.0.1` | 监听地址 |
| `CODEBUDDY_ENDPOINT` | `https://copilot.tencent.com` | 后端地址 |
| `CODEBUDDY_PREFIX_PATH` | `/plugin` | 认证接口前缀 |
| `CODEBUDDY_PLATFORM` | `VSCode` | 平台标识 |
| `CODEBUDDY_SESSION_FILE` | `~/.codebuddy-proxy/session.json` | 会话文件 |
| `CODEBUDDY_FORCE_MODEL` | 空 | 强制替换请求 model |
| `CODEBUDDY_DEFAULT_MODEL` | `default` | 缺省 model |
| `CODEBUDDY_NO_OPEN` | 空 | 设置则不自动打开管理页 |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` `/home` | 管理页 |
| GET | `/api/status` | 状态 JSON |
| GET | `/api/import-vscode` | 从 VSCode 重读登录态 |
| GET | `/health` | 健康检查 |
| GET | `/login` | OAuth 登录页 |
| GET | `/login/state` | 获取登录地址（JSON）|
| GET | `/login/status?state=` | 查询登录进度 |
| GET | `/logout` | 退出登录 |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/responses` | Responses API（Codex 等，流式/非流式）|
| POST | `/v1/chat/completions` | 对话（流式/非流式）|
| POST | `/v1/completions` | 补全 |
| POST | `/v1/embeddings` | 向量 |

## 安全提示

- 服务默认只监听 `127.0.0.1`，请勿直接暴露到公网。
- 会话文件与 `/api/status` 会暴露 token（打码）与账号信息；`/session` 返回明文 token，生产环境建议删掉或加鉴权。
- 解密 VSCode 密钥需要本机钥匙串访问权限（首次可能弹授权）。

## License

[MIT](LICENSE)

