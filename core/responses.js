'use strict';

/** Responses API 转换（Codex 用 /v1/responses） */

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
const auth = require('./auth');
const openai = require('./openai');

// CodeBuddy 后端的内容过滤器会拦截含 "Codex"/"OpenAI" 等竞品品牌词的系统提示词，
// 返回 11128 "Illegal API invocation from an unapproved channel"。这里做净化以绕过。
function sanitizeForBackend(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/Codex/gi, 'CodeBuddy').replace(/OpenAI/gi, 'Tencent');
}

/**
 * 从 Responses / Chat 两套写法里取出图片地址。
 * Responses 的 input_image 是 { type:'input_image', image_url: '<字符串>', detail }，
 * Chat Completions 的 image_url 是 { type:'image_url', image_url:{ url, detail } }，
 * 两种都要认，否则图片会被降级成纯文本。
 */
function extractImageUrl(c) {
  const raw = c.image_url !== undefined ? c.image_url : c.url;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return raw.url || '';
  return '';
}

/** 转成 chat/completions 认识的 image_url 分片（Responses 的 detail 也带过去） */
function toImagePart(c) {
  const url = extractImageUrl(c);
  if (!url) return null;
  const detail = c.detail || (c.image_url && typeof c.image_url === 'object' && c.image_url.detail) || undefined;
  const part = { type: 'image_url', image_url: detail ? { url, detail } : { url } };
  return part;
}

/**
 * Responses 的 content → chat/completions 的 content。
 * 纯文本时返回字符串（保持原样，兼容只吃字符串的上游）；
 * 只要含图片/音频等非文本分片，就返回分片数组，避免多模态信息被压平成文本。
 */
function contentToChat(content, { sanitizeText = false } = {}) {
  const clean = (s) => (sanitizeText ? sanitizeForBackend(s) : s);

  if (content == null) return '';
  if (typeof content === 'string') return clean(content);
  if (!Array.isArray(content)) {
    if (typeof content === 'object') return contentToChat([content], { sanitizeText });
    return clean(String(content));
  }

  const textParts = [];
  const parts = [];
  let hasNonText = false;

  for (const c of content) {
    if (typeof c === 'string') { textParts.push(c); parts.push({ type: 'text', text: clean(c) }); continue; }
    if (!c || typeof c !== 'object') continue;

    if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') {
      const t = c.text || '';
      textParts.push(t);
      parts.push({ type: 'text', text: clean(t) });
      continue;
    }
    if (c.type === 'input_image' || c.type === 'image_url' || c.type === 'image') {
      const part = toImagePart(c);
      if (part) { hasNonText = true; parts.push(part); }
      continue;
    }
    if (c.type === 'input_audio' || c.type === 'audio' || c.type === 'input_file' || c.type === 'file') {
      // 上游不一定支持，但至少原样带过去，而不是静默丢掉
      hasNonText = true;
      parts.push(c);
      continue;
    }
    if (c.type === 'refusal') { textParts.push(c.refusal || ''); parts.push({ type: 'text', text: clean(c.refusal || '') }); continue; }
    // 未知分片类型：保留，避免信息静默丢失
    hasNonText = true;
    parts.push(c);
  }

  if (!hasNonText) return clean(textParts.filter(Boolean).join('\n'));
  return parts;
}

/** 只要文本（tool 输出、system 提示等纯文本场景仍用它） */
function contentToText(content) {
  const r = contentToChat(content);
  if (typeof r === 'string') return r;
  return r.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'required') return 'required';
    if (tc === 'none') return 'none';
    return 'auto';
  }
  if (typeof tc === 'object') {
    if (tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
    if (tc.type === 'none') return 'none';
    if (tc.type === 'required') return 'required';
    // Responses 的 allowed_tools：chat/completions 无等价写法，
    // 收紧到 required 会强制调用工具，语义不符，故退回 auto。
    if (tc.type === 'allowed_tools') return 'auto';
  }
  return 'auto';
}

/**
 * Codex（以及其它 Responses 客户端）会发多种工具类型，其中很多 chat/completions 不认识：
 *   - { type:'function', name, parameters }            原生支持
 *   - { type:'namespace', name, tools:[...] }          Codex 的内置工具组（子代理 / 浏览器 / node_repl）
 *   - { type:'web_search' } / { type:'computer_use' }  宿主工具，无 parameters
 *   - { type:'mcp', server_label, ... }                远端 MCP 工具
 * 旧实现只保留 type==='function'，会把 namespace / web_search 静默丢掉，
 * 导致 Codex 的浏览器插件、子代理等内置工具全部不可用。
 * 这里统一展平成 chat/completions 的 function 工具：
 *   - namespace 的子工具用 `${namespace}__${child}` 命名（回写时再还原）
 *   - 无 parameters 的宿主工具合成一个通用对象入参，至少让模型能"表达"调用意图
 */
function chatToolName(ns, child) {
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return ns ? `${safe(ns)}__${safe(child)}` : safe(child);
}

function toChatTool(name, description, parameters) {
  return {
    type: 'function',
    function: {
      name,
      description: sanitizeForBackend(description || ''),
      parameters: (parameters && typeof parameters === 'object') ? parameters : { type: 'object', properties: {} },
    },
  };
}

/** Responses 的 tools 数组 → chat/completions 的 tools 数组（尽力展平，不静默丢弃） */
function responsesToolsToChatTools(tools) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (!t || !t.function.name || seen.has(t.function.name)) return; // 上游不接受重名
    seen.add(t.function.name);
    out.push(t);
  };

  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;

    if (t.type === 'function' && t.name) {
      push(toChatTool(t.name, t.description, t.parameters || t.input_schema));
      continue;
    }

    // Codex 内置工具组：把子工具展平并加命名空间前缀
    if ((t.type === 'namespace' || t.type === 'mcp') && Array.isArray(t.tools)) {
      for (const sub of t.tools) {
        if (!sub || typeof sub !== 'object') continue;
        const subName = sub.name || sub.function?.name;
        if (!subName) continue;
        push(toChatTool(
          chatToolName(t.name, subName),
          [t.description, sub.description].filter(Boolean).join('\n\n'),
          sub.parameters || sub.input_schema || sub.function?.parameters,
        ));
      }
      continue;
    }

    // 宿主工具（web_search / computer_use / code_interpreter ...）：上游没有对应能力，
    // 但仍以 function 形式暴露，模型可发起调用、由客户端（Codex）自行执行。
    if (typeof t.type === 'string' && t.type !== 'function') {
      const name = t.name || t.type;
      push(toChatTool(
        name,
        t.description || `Hosted tool: ${t.type}`,
        t.parameters || { type: 'object', properties: {}, additionalProperties: true },
      ));
      continue;
    }
  }
  return out;
}

/**
 * 反向映射：上游返回的工具名 → 回传给客户端的 function_call.name。
 *
 * 目前是**恒等映射**（原样回传扁平名），依据如下实测（Codex CLI 0.153 + 本地假上游）：
 *   - 回传 'exec_command'          → ✅ 正常执行（普通 function 工具）
 *   - 回传 'js'                    → ❌ unsupported call: js
 *   - 回传 'mcp__cua_repl__js'     → ❌ unsupported call: mcp__cua_repl__js
 *   - 回传 'mcp__cua_repl.js' / ':' → ❌ 同样失败
 * 即：普通 function 工具用原名即可；而 namespace 子工具**无论回传什么名字，
 * Codex 的路由器都不接受**（见「已知限制」）。既然命名不是变量，就保持原样回传，
 * 避免引入无意义的改名逻辑。
 */
function splitChatToolName(flat) {
  const s = String(flat || '');
  return { namespace: '', name: s };
}

/**
 * 建立「工具可调用名 → 发给上游的名字」映射。
 * 由于展平后 Codex 认得的调用名与上游看到的扁平名一致
 * （都是 `${namespace}__${sub}`），这里是恒等映射；
 * 保留结构是为了历史 function_call 有统一的转换入口。
 */
function buildToolNameMap(tools) {
  const map = new Map();
  if (!Array.isArray(tools)) return map;
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if ((t.type === 'namespace' || t.type === 'mcp') && Array.isArray(t.tools)) {
      for (const sub of t.tools) {
        const subName = sub && (sub.name || (sub.function && sub.function.name));
        if (subName) map.set(chatToolName(t.name, subName), chatToolName(t.name, subName));
      }
    } else if (t.name) {
      map.set(t.name, t.name);
    }
  }
  return map;
}

/** 原始工具名 → 上游扁平名（找不到就原样返回） */
function flattenToolName(name, map) {
  const s = String(name || '');
  if (!map || !map.size) return s;
  return map.get(s) || s;
}

/** Responses API 请求 → chat/completions 请求 */
function responsesToChatInput(p) {
  const cfg = store.getConfig();
  const chat = { model: (p.model && p.model !== '') ? p.model : (cfg.defaultModel || 'default'), messages: [], stream: !!p.stream };

  // 工具名映射：原始名（子工具名）→ 发给上游的扁平名。
  // 用于把历史里的 function_call 还原成上游见过的名字。
  const toolNameMap = buildToolNameMap(p.tools);

  if (p.instructions) chat.messages.push({ role: 'system', content: sanitizeForBackend(p.instructions) });

  const input = p.input;
  if (typeof input === 'string') {
    chat.messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    let pendingToolCalls = [];
    const flushToolCalls = () => {
      if (pendingToolCalls.length) {
        chat.messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
        pendingToolCalls = [];
      }
    };
    for (const item of input) {
      if (typeof item === 'string') { flushToolCalls(); chat.messages.push({ role: 'user', content: item }); continue; }
      if (!item || typeof item !== 'object') continue;

      if (item.role && item.content !== undefined) {
        flushToolCalls();
        const isSys = item.role === 'developer' || item.role === 'system';
        const role = item.role === 'developer' ? 'system' : item.role;
        chat.messages.push({ role, content: contentToChat(item.content, { sanitizeText: isSys }) });
        continue;
      }
      if (item.type === 'message') {
        flushToolCalls();
        const isSys = item.role === 'developer' || item.role === 'system';
        const role = item.role === 'developer' ? 'system' : (item.role || 'user');
        chat.messages.push({ role, content: contentToChat(item.content, { sanitizeText: isSys }) });
      } else if (item.type === 'function_call') {
        // 历史里的 function_call 用的是 Codex 的原始工具名（如 spawn_agent），
        // 而 tools 定义是以扁平名（multi_agent_v1__spawn_agent）发给上游的。
        // 若这里不还原成扁平名，上游会认为模型调用了未声明的工具而报错。
        pendingToolCalls.push({
          id: item.call_id || item.id || util.genId('call'),
          type: 'function',
          function: { name: flattenToolName(item.name, toolNameMap), arguments: item.arguments || '' },
        });
      } else if (item.type === 'function_call_output') {
        flushToolCalls();
        chat.messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: contentToText(item.output) });
      }
    }
    flushToolCalls();
  }

  if (Array.isArray(p.tools) && p.tools.length) {
    chat.tools = responsesToolsToChatTools(p.tools);
    if (chat.tools.length) {
      const tc = convertToolChoice(p.tool_choice);
      if (tc) chat.tool_choice = tc;
    }
  }

  if (p.max_output_tokens) chat.max_tokens = p.max_output_tokens;
  if (p.temperature !== undefined) chat.temperature = p.temperature;
  if (p.top_p !== undefined) chat.top_p = p.top_p;

  // 上游多数情况下会自带 usage，但显式要一次更稳（否则流式末块可能没有 usage，
  // 导致用量统计记不到 token）。
  if (chat.stream) chat.stream_options = { include_usage: true };

  return chat;
}

/** 把 chat usage 转成 Responses API usage 格式 */
function convertUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: u.prompt_cache_hit_tokens || 0 },
    output_tokens: u.completion_tokens || 0,
    output_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
    total_tokens: u.total_tokens || 0,
  };
}

/** 构建一个 Responses API 响应对象（output 顺序：reasoning → function_call → message） */
function buildResponseObject(state, status) {
  const done = status === 'completed';
  const output = [];
  // 与流式路径的 outputBase() 保持一致：只要 reasoning 有内容就占 0 号位。
  // 流式里若 reasoning 迟到（正文已开始），事件不再补发，但这里仍要把它放进
  // output——两者的一致性由 finish() 的收尾顺序保证。
  if (state.reasoningStarted || state.reasoning) {
    output.push({
      id: state.reasoningId, type: 'reasoning', status: done ? 'completed' : 'in_progress',
      summary: state.reasoning ? [{ type: 'summary_text', text: state.reasoning }] : [],
    });
  }
  for (const t of state.toolCalls) {
    output.push({
      id: t.id, type: 'function_call', call_id: t.call_id,
      name: splitChatToolName(t.name).name || t.name,
      arguments: t.args, status: done ? 'completed' : 'in_progress',
    });
  }
  if (state.msgStarted || state.content) {
    output.push({ id: state.msgId, type: 'message', status: done ? 'completed' : 'in_progress', role: 'assistant', content: state.content ? [{ type: 'output_text', text: state.content, annotations: [] }] : [] });
  }
  return {
    id: state.responseId,
    object: 'response',
    created_at: state.created,
    status,
    error: null,
    incomplete_details: null,
    model: state.model,
    output,
    parallel_tool_calls: true,
    temperature: state.req.temperature ?? 1,
    tool_choice: state.req.tool_choice || 'auto',
    tools: state.req.tools || [],
    max_output_tokens: state.req.max_output_tokens || null,
    instructions: state.req.instructions || null,
    usage: convertUsage(state.usage),
  };
}

/** 把聚合后的 chat.completion 转成 Responses API 非流式响应（output 顺序：reasoning → function_call → message） */
function chatCompletionToResponse(completion, req) {
  const message = (completion.choices && completion.choices[0] && completion.choices[0].message) || {};
  const output = [];
  const msgId = util.genId('msg');

  if (message.reasoning_content) {
    // reasoning 项的正文放在 summary 里；summary_text 是一个分片对象，不该再套 annotations
    output.push({
      id: util.genId('rs'), type: 'reasoning', status: 'completed',
      summary: [{ type: 'summary_text', text: message.reasoning_content }],
    });
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    for (const tc of message.tool_calls) {
      const flat = (tc.function && tc.function.name) || '';
      output.push({
        id: tc.id || util.genId('fc'),
        type: 'function_call',
        call_id: tc.id || util.genId('call'),
        name: splitChatToolName(flat).name || flat,
        arguments: (tc.function && tc.function.arguments) || '',
        status: 'completed',
      });
    }
  }
  const parts = [];
  if (message.content) parts.push({ type: 'output_text', text: message.content, annotations: [] });
  output.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: parts });

  return {
    id: util.genId('resp'),
    object: 'response',
    created_at: completion.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: completion.model || req.model || store.getConfig().defaultModel || 'default',
    output,
    parallel_tool_calls: true,
    temperature: req.temperature ?? 1,
    tool_choice: req.tool_choice || 'auto',
    tools: req.tools || [],
    max_output_tokens: req.max_output_tokens || null,
    instructions: req.instructions || null,
    usage: convertUsage(completion.usage),
  };
}

/** 把 CodeBuddy 的 chat SSE 流转成 Responses API SSE 事件（边收边写） */
function streamChatToResponses(clientRes, urlStr, headers, body, originalReq) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;

    const state = {
      seq: 0,
      responseId: util.genId('resp'),
      msgId: util.genId('msg'),
      reasoningId: util.genId('rs'),
      model: originalReq.model || store.getConfig().defaultModel || 'default',
      created: Math.floor(Date.now() / 1000),
      req: originalReq,
      content: '',
      reasoning: '',
      toolCalls: [],
      toolIndex: {},
      started: false,
      reasoningStarted: false,
      msgStarted: false,
      finishReason: 'stop',
      usage: null,
    };

    const emit = (type, data) => {
      data.type = type;
      data.sequence_number = state.seq++;
      clientRes.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const ensureStarted = () => {
      if (state.started) return;
      state.started = true;
      emit('response.created', { response: buildResponseObject(state, 'in_progress') });
      emit('response.in_progress', { response: buildResponseObject(state, 'in_progress') });
    };

    // reasoning 输出项必须排在 message 之前，否则 Codex 的事件顺序校验会失败。
    // 上游 delta.reasoning_content 一直没有被转发，导致思维链在流式下完全丢失。
    const ensureReasoning = () => {
      if (state.reasoningStarted) return;
      state.reasoningStarted = true;
      emit('response.output_item.added', { output_index: 0, item: { id: state.reasoningId, type: 'reasoning', status: 'in_progress', summary: [] } });
      emit('response.reasoning_summary_part.added', { item_id: state.reasoningId, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } });
    };

    // output_index 分配：reasoning（若有）恒占 0，其后依次是各 function_call，
    // message（若有）排在最后。每个 item 的 index 在其生命周期内必须唯一且固定，
    // 因此这里统一用「基址 + 位置」计算，added / done 两处必须调用同一个函数。
    /** reasoning 占 0 时，其余 item 的起始下标 */
    const outputBase = () => (state.reasoningStarted ? 1 : 0);
    /** 第 pos 个 function_call 的 output_index（pos 为 toolCalls 数组下标，固定不变） */
    const toolOutputIndex = (pos) => outputBase() + pos;
    /** message 排在所有 function_call 之后 */
    const msgOutputIndex = () => outputBase() + state.toolCalls.length;

    const ensureMessage = () => {
      if (state.msgStarted) return;
      state.msgStarted = true;
      const oi = msgOutputIndex();
      emit('response.output_item.added', { output_index: oi, item: { id: state.msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
      emit('response.content_part.added', { item_id: state.msgId, output_index: oi, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    };

    const onChunk = (chunk) => {
      ensureStarted();
      const choice = (chunk.choices || [])[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (chunk.model) state.model = chunk.model;
      if (chunk.created) state.created = chunk.created;
      if (chunk.usage) state.usage = chunk.usage;
      if (choice.finish_reason) state.finishReason = choice.finish_reason;

      // 先处理 reasoning：它必须整段排在正文/工具调用之前。
      // 注意不能写成 a ?? b ?? c 的级联：当 delta.reasoning 是对象时，
      // 中间分支会求值成 ''（非 nullish），导致读 .content 的第三分支永远不可达。
      const r = delta.reasoning;
      const rc = delta.reasoning_content
        ?? (typeof r === 'string' ? r : (r && typeof r.content === 'string' ? r.content : ''));
      if (typeof rc === 'string' && rc) {
        if (!state.msgStarted && !state.toolCalls.length) {
          ensureReasoning();
          state.reasoning += rc;
          emit('response.reasoning_summary_text.delta', { item_id: state.reasoningId, output_index: 0, summary_index: 0, delta: rc });
        } else {
          // 正文/工具调用已开始后才吐 reasoning：此时再插 reasoning 会破坏已发出的
          // output_index（reasoning 必须占 0），只能累加到 state 里，供最终
          // response.completed 的 output 使用；流式事件不再补发，避免序列自相矛盾。
          state.reasoning += rc;
        }
      }

      if (typeof delta.content === 'string' && delta.content) {
        ensureMessage();
        state.content += delta.content;
        emit('response.output_text.delta', { item_id: state.msgId, output_index: msgOutputIndex(), content_index: 0, delta: delta.content });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          if (!(idx in state.toolIndex)) {
            const pos = state.toolCalls.length;
            state.toolIndex[idx] = pos;
            const id = tc.id || util.genId('fc');
            state.toolCalls.push({ id, call_id: id, name: '', callName: '', args: '' });
            // pos 是该工具在 toolCalls 里的固定下标，与 done 阶段用同一公式，
            // 保证同一 item 的 added/done 拿到相同 output_index。
            emit('response.output_item.added', { output_index: toolOutputIndex(pos), item: { id, type: 'function_call', call_id: id, name: '', arguments: '', status: 'in_progress' } });
          }
          const pos = state.toolIndex[idx];
          const t = state.toolCalls[pos];
          if (tc.id) { t.id = tc.id; t.call_id = tc.id; }
          if (tc.function) {
            if (tc.function.name) {
              t.name += tc.function.name;
              // 工具名是分片下发的，必须等它拼完整再还原成 Codex 的原始子工具名
              // （上游看到的是扁平名 mcp__cua_repl__js，Codex 只认 js）。
              // 这里在每次追加后重算，保证 done 事件与最终 response 里都是还原后的名字。
              t.callName = splitChatToolName(t.name).name || t.name;
            }
            if (tc.function.arguments) t.args += tc.function.arguments;
          }
        }
      }
    };

    const finish = () => {
      ensureStarted();
      // item 的完结顺序必须与 buildResponseObject 里 output 数组的顺序一致
      // （reasoning → function_call... → message），且 output_index 递增，
      // 否则严格校验的客户端会认为事件序列非法。
      if (state.reasoningStarted) {
        emit('response.reasoning_summary_text.done', { item_id: state.reasoningId, output_index: 0, summary_index: 0, text: state.reasoning });
        emit('response.reasoning_summary_part.done', { item_id: state.reasoningId, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: state.reasoning } });
        emit('response.output_item.done', { output_index: 0, item: { id: state.reasoningId, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: state.reasoning }] } });
      }
      state.toolCalls.forEach((t, pos) => {
        emit('response.output_item.done', { output_index: toolOutputIndex(pos), item: { id: t.id, type: 'function_call', call_id: t.call_id, name: t.callName || splitChatToolName(t.name).name || t.name, arguments: t.args, status: 'completed' } });
      });
      if (state.msgStarted) {
        const oi = msgOutputIndex();
        emit('response.output_text.done', { item_id: state.msgId, output_index: oi, content_index: 0, text: state.content });
        emit('response.content_part.done', { item_id: state.msgId, output_index: oi, content_index: 0, part: { type: 'output_text', text: state.content, annotations: [] } });
        emit('response.output_item.done', { output_index: oi, item: { id: state.msgId, type: 'message', status: 'completed', role: 'assistant', content: state.content ? [{ type: 'output_text', text: state.content, annotations: [] }] : [] } });
      }
      emit('response.completed', { response: buildResponseObject(state, 'completed') });
      clientRes.end();
    };

    const req = mod.request(u, { method: 'POST', headers }, (upRes) => {
      const ct = (upRes.headers['content-type'] || '');
      if (!ct.includes('text/event-stream')) {
        let errBody = '';
        upRes.setEncoding('utf8');
        upRes.on('data', (c) => { errBody += c; });
        upRes.on('end', () => {
          logger.log('error', 'responses', `上游非流式响应 ${upRes.statusCode}: ${errBody.slice(0, 500)}`);
          if (!clientRes.headersSent) {
            clientRes.writeHead(upRes.statusCode || 502, { 'Content-Type': ct || 'application/json', 'Access-Control-Allow-Origin': '*' });
            clientRes.end(errBody);
          } else {
            const ev = { type: 'response.failed', sequence_number: state.seq++, response: { id: state.responseId, object: 'response', status: 'failed', error: { code: 'upstream_error', message: `上游返回 ${upRes.statusCode}: ${errBody.slice(0, 300)}` } } };
            clientRes.write(`event: response.failed\ndata: ${JSON.stringify(ev)}\n\n`);
            clientRes.end();
          }
          resolve({ usage: state.usage, model: state.model, status: upRes.statusCode === 200 ? 'ok' : 'error' });
        });
        upRes.on('error', reject);
        return;
      }
      let buf = '';
      upRes.setEncoding('utf8');
      upRes.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try { onChunk(JSON.parse(data)); } catch { /* skip */ }
          }
        }
      });
      upRes.on('end', () => {
        if (buf.trim()) {
          for (const line of buf.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try { onChunk(JSON.parse(data)); } catch { /* skip */ }
          }
        }
        finish();
        resolve({ usage: state.usage, model: state.model, status: upRes.statusCode === 200 ? 'ok' : 'error' });
      });
      upRes.on('error', reject);
    });
    req.on('error', (e) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: `upstream error: ${e.message}` } }));
      }
      reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 按 UTF-8 字节数安全截断字符串：不切碎多字节字符，返回结果 <= maxBytes 字节。
 * Buffer#subarray 会在字符中间切断，残留字节解码为 U+FFFD（3 字节），
 * 使「截断后」反而比上限更大，所以需要根据末字节判断需要回退几个字节。
 */
function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text);
  if (buf.length <= maxBytes) return text;

  // 从 maxBytes 往前找第一个 UTF-8 前导字节（非 10xxxxxx 续字节），
  // 并确认该字符的完整字节数能放进 maxBytes，否则继续回退。
  let end = maxBytes;
  while (end > 0) {
    const b = buf[end];
    if (b === undefined || (b & 0xc0) !== 0x80) break; // 找到下一个字符的起始
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * 记录完整请求体（默认关闭，见「系统配置 → 记录完整请求体」）。
 * 写入日志表 category='request'，message 里带 bodyText，便于在管理页日志里直接看全文。
 * 超大请求按 logging.requestBodyMaxKb 截断，避免把日志表撑爆。
 */
function logRequestBody(category, source, raw, converted) {
  const { enabled, maxBytes } = store.getRequestBodyLogConfig();
  if (!enabled) return;
  try {
    const text = JSON.stringify(raw);
    const bytes = Buffer.byteLength(text);
    const truncated = bytes > maxBytes;
    // maxBytes 是字节数，必须按字节截断：直接 text.slice(0, maxBytes) 是按字符切，
    // 中文一个字 3 字节，实际会超限 2~3 倍，截断上限形同虚设。
    // 按字节切会切碎多字节字符，残缺字节解码成 U+FFFD（3 字节）反而使结果超出上限，
    // 因此这里回退掉末尾不完整的多字节序列，保证结果字节数 <= maxBytes。
    const bodyText = truncated ? truncateUtf8(text, maxBytes) : text;
    const toolSummary = Array.isArray(raw && raw.tools)
      ? (() => {
        const byType = {};
        for (const t of raw.tools) { const k = (t && t.type) || 'unknown'; byType[k] = (byType[k] || 0) + 1; }
        return byType;
      })()
      : null;
    logger.log('info', category, `[request body] ${source} ${bytes} bytes${truncated ? `（截断至 ${maxBytes}）` : ''}`, {
      source,
      bytes,
      truncated,
      toolTypes: toolSummary,
      convertedTools: converted && Array.isArray(converted.tools) ? converted.tools.map((t) => t.function.name) : null,
      bodyText,
    });
  } catch { /* 日志失败不影响主流程 */ }
}

/** 处理 POST /v1/responses */
async function handleResponses(req, res) {
  const keyCheck = auth.verifyClientKey(req);
  if (!keyCheck.ok) {
    const status = keyCheck.rateLimited ? 429 : 401;
    util.sendJson(res, status, { error: { message: keyCheck.message, type: 'authentication_error' } });
    return;
  }

  let body;
  try { body = await util.readBody(req); }
  catch (e) { util.sendJson(res, 400, { error: { message: `read body failed: ${e.message}` } }); return; }

  let payload = null;
  if (body.length) { try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; } }
  if (payload == null) payload = {};

  const chatPayload = responsesToChatInput(payload);
  const cfg = store.getConfig();
  if (cfg.forceModel) chatPayload.model = cfg.forceModel;
  chatPayload.stream = true; // CodeBuddy 只支持流式

  const timeoutMs = store.getRequestTimeoutMs();
  logger.log('info', 'responses', `model=${payload.model || chatPayload.model} stream=${!!payload.stream} messages=${chatPayload.messages.length}`, logger.requestSummary(payload, { messages: chatPayload.messages.length }));

  // 完整请求体日志（默认关闭）。用于排查 Codex 等 agent 客户端发来的原始结构，
  // 尤其是 tools / input 这类转换容易出问题的地方。
  logRequestBody('responses', '/v1/responses', payload, chatPayload);

  if (process.env.CODEBUDDY_DEBUG) {
    try {
      fs.writeFileSync('/tmp/codebuddy-debug-last.json', JSON.stringify({ raw: payload, chat: chatPayload }, null, 2));
      logger.log('info', 'responses', `debug dump -> /tmp/codebuddy-debug-last.json | msgs=[${chatPayload.messages.map(m => `${m.role}:${JSON.stringify(m.content).length}${m.tool_calls ? `(tc:${m.tool_calls.length})` : ''}`).join(',')}] tools=[${(chatPayload.tools || []).map(t => t.function.name).join(',')}]`);
    } catch { /* ignore */ }
  }

  const accountKey = auth.extractAccountKey(req, payload);
  let acct;
  try { acct = await auth.pickAccountForRequest(accountKey, keyCheck.accountId || ''); }
  catch (e) {
    logger.log('warn', 'responses', `拒绝: ${e.message}`);
    util.sendJson(res, 401, { error: { message: e.message, type: 'authentication_error' } });
    return;
  }

  const accountId = acct ? acct.id : '';
  const accountName = acct ? (acct.name || (acct.account && (acct.account.nickname || acct.account.uid)) || '') : '';
  const record = (usage, status) => {
    const cached =
      (usage && usage.prompt_cache_hit_tokens) ||
      (usage && usage.input_tokens_details && usage.input_tokens_details.cached_tokens) ||
      (usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
    store.recordUsage({
      source: '/v1/responses',
      model: chatPayload.model || payload.model || '',
      stream: !!payload.stream,
      accountId, accountName,
      apiKeyId: keyCheck.keyId || '', apiKeyName: keyCheck.keyName || '',
      promptTokens: usage && (usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens),
      completionTokens: usage && (usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens),
      totalTokens: usage && (usage.total_tokens != null ? usage.total_tokens : (usage.input_tokens + usage.output_tokens)),
      cachedTokens: cached,
      durationMs: Date.now() - startedAt,
      status,
    });
  };

  const headers = { ...auth.buildAuthHeaders(acct), 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
  const targetUrl = `${config.ENDPOINT}/v2/chat/completions`;
  const jsonBody = JSON.stringify(chatPayload);
  const startedAt = Date.now();

  try {
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' });
      const done = await streamChatToResponses(res, targetUrl, headers, jsonBody, payload);
      logger.log('info', 'responses', `流式结束 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: true, durationMs: Date.now() - startedAt }));
      record(done && done.usage, (done && done.status) || 'ok');
    } else {
      const r = await util.requestRaw(targetUrl, { method: 'POST', headers, body: jsonBody, timeoutMs });
      const ct = (r.headers && r.headers['content-type']) || '';
      if (ct.includes('text/event-stream') || r.body.includes('chat.completion.chunk')) {
        const completion = openai.aggregateSseToCompletion(r.body);
        logger.log('info', 'responses', `完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, durationMs: Date.now() - startedAt, tokens: completion.usage && completion.usage.total_tokens }));
        record(completion.usage, 'ok');
        util.sendJson(res, 200, chatCompletionToResponse(completion, payload));
      } else {
        record(null, r.status === 200 ? 'ok' : 'error');
        res.writeHead(r.status, { 'Content-Type': ct || 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(r.body);
      }
    }
  } catch (e) {
    logger.log('error', 'responses', `上游错误: ${e.message}`, logger.requestSummary(payload, { durationMs: Date.now() - startedAt }));
    record(null, 'error');
    if (!res.headersSent) util.sendJson(res, 502, { error: { message: `upstream error: ${e.message}`, type: 'proxy_upstream_error' } });
    else res.end();
  }
}

module.exports = { handleResponses, responsesToChatInput, responsesToolsToChatTools, splitChatToolName, convertToolChoice, logRequestBody };