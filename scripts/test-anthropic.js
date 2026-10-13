'use strict';

/**
 * /v1/messages（Anthropic Messages API）转换测试
 *
 * 不依赖网络与登录态：起一个 mock 上游 + 假的 client res，直接驱动 handleMessages。
 * 覆盖：请求转换、消息顺序（11148 回归）、品牌词净化、工具映射、
 *       流式事件序列、非流式响应、错误处理。
 *
 * 运行：node scripts/test-anthropic.js
 */

const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const anthropic = require(path.join(ROOT, 'core/anthropic.js'));
const auth = require(path.join(ROOT, 'core/auth.js'));
const sessionMod = require(path.join(ROOT, 'core/session.js'));
const util = require(path.join(ROOT, 'core/util.js'));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('断言返回 false');
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ': ' + e.message);
    console.log('  FAIL ' + name + ' -> ' + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || 'not equal') + `\n      actual:   ${a}\n      expected: ${b}`);
}

// ---------------------------------------------------------------------------
// 1. 请求转换
// ---------------------------------------------------------------------------
console.log('\n[请求转换]');

check('system 置顶且净化品牌词', () => {
  const chat = anthropic.anthropicToChat({
    model: 'm',
    system: 'You are Claude Code, Anthropic official CLI.',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assertEqual(chat.messages[0].role, 'system');
  assert(!/Claude Code/.test(chat.messages[0].content), 'Claude Code 未被净化');
  assert(!/Anthropic/.test(chat.messages[0].content), 'Anthropic 未被净化');
});

check('tool 消息必须紧跟 assistant(tool_calls) —— 11148 回归', () => {
  // Claude Code 的真实形态：user 消息里 text 在 tool_result 之前
  const chat = anthropic.anthropicToChat({
    model: 'm',
    messages: [
      { role: 'user', content: 'Create t.txt' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Creating it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'exec', input: { cmd: 'echo ok' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'done' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
        ],
      },
    ],
  });
  const msgs = chat.messages;
  const toolIdx = msgs.findIndex((m) => m.role === 'tool');
  assert(toolIdx > 0, '未产出 tool 消息');
  const prev = msgs[toolIdx - 1];
  assert(prev.role === 'assistant', `tool 前一条应为 assistant，实际 ${prev.role}`);
  assert(Array.isArray(prev.tool_calls), 'tool 前一条缺少 tool_calls');
  assertEqual(prev.tool_calls[0].id, 'toolu_1');
  // 文本不能插在中间
  const between = msgs.slice(msgs.indexOf(prev) + 1, toolIdx);
  assertEqual(between.length, 0, 'tool_calls 与 tool 之间不应有其它消息');
});

check('assistant 文本与 tool_calls 合并进同一条消息', () => {
  const chat = anthropic.anthropicToChat({
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 't1', name: 'f', input: {} },
        ],
      },
    ],
  });
  assertEqual(chat.messages.length, 1);
  assertEqual(chat.messages[0].content, 'Let me check.');
  assertEqual(chat.messages[0].tool_calls.length, 1);
});

check('多工具并行调用全部保留', () => {
  const chat = anthropic.anthropicToChat({
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'f', input: { x: 1 } },
          { type: 'tool_use', id: 'b', name: 'g', input: { y: 2 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'ra' },
          { type: 'tool_result', tool_use_id: 'b', content: 'rb' },
        ],
      },
    ],
  });
  const tools = chat.messages.filter((m) => m.role === 'tool');
  assertEqual(tools.length, 2);
  assertEqual(tools.map((t) => t.tool_call_id), ['a', 'b']);
  // 两条 tool 都必须紧邻带 tool_calls 的 assistant
  assertEqual(chat.messages[0].tool_calls.length, 2);
  assertEqual(chat.messages[1].role, 'tool');
  assertEqual(chat.messages[2].role, 'tool');
});

check('tools 转换（Anthropic → chat）', () => {
  const chat = anthropic.anthropicToChat({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'exec', description: 'run', input_schema: { type: 'object', properties: { c: { type: 'string' } } } }],
  });
  assertEqual(chat.tools[0].type, 'function');
  assertEqual(chat.tools[0].function.name, 'exec');
  assertEqual(chat.tools[0].function.parameters.properties.c.type, 'string');
});

check('tool_choice 对象形式降级为字符串（上游只收 string）', () => {
  assertEqual(anthropic.convertToolChoice({ type: 'tool', name: 'X' }), 'X');
  assertEqual(anthropic.convertToolChoice({ type: 'any' }), 'required');
  assertEqual(anthropic.convertToolChoice('auto'), 'auto');
  assertEqual(anthropic.convertToolChoice({ type: 'function', function: { name: 'Y' } }), 'Y');
});

check('参数透传（max_tokens/temperature/top_p/stop_sequences）', () => {
  const chat = anthropic.anthropicToChat({
    model: 'm',
    max_tokens: 512,
    temperature: 0.3,
    top_p: 0.9,
    stop_sequences: ['END'],
    messages: [{ role: 'user', content: 'x' }],
  });
  assertEqual(chat.max_tokens, 512);
  assertEqual(chat.temperature, 0.3);
  assertEqual(chat.top_p, 0.9);
  assertEqual(chat.stop, ['END']);
});

check('图片分片转为 image_url', () => {
  const chat = anthropic.anthropicToChat({
    model: 'm',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    }],
  });
  const c = chat.messages[0].content;
  assert(Array.isArray(c), '含图片时应为分片数组');
  assertEqual(c[1].type, 'image_url');
  assert(c[1].image_url.url.startsWith('data:image/png;base64,'), 'base64 未正确拼接');
});

check('空/畸形输入不抛异常', () => {
  anthropic.anthropicToChat({ messages: [] });
  anthropic.anthropicToChat({ messages: [{ role: 'user', content: null }] });
  anthropic.anthropicToChat({ messages: [{ role: 'user', content: [{ type: 'unknown' }] }] });
  anthropic.anthropicToChat({});
});

// ---------------------------------------------------------------------------
// 2. 非流式响应转换
// ---------------------------------------------------------------------------
console.log('\n[非流式响应]');

check('文本 + 工具调用 → content 分片', () => {
  const msg = anthropic.chatCompletionToMessage({
    model: 'glm-5.2',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: 'I will do it.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{"cmd":"ls"}' } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, { model: 'glm-5.2' });

  assertEqual(msg.type, 'message');
  assertEqual(msg.role, 'assistant');
  assertEqual(msg.stop_reason, 'tool_use');
  assertEqual(msg.content[0].type, 'text');
  assertEqual(msg.content[1].type, 'tool_use');
  assertEqual(msg.content[1].name, 'exec');
  assertEqual(msg.content[1].input.cmd, 'ls');
  assertEqual(msg.usage.input_tokens, 10);
  assertEqual(msg.usage.output_tokens, 5);
});

check('thinking 排在 content 最前', () => {
  const msg = anthropic.chatCompletionToMessage({
    choices: [{ finish_reason: 'stop', message: { content: 'hi', reasoning_content: 'thinking...' } }],
    usage: {},
  }, { model: 'm' });
  assertEqual(msg.content[0].type, 'thinking');
  assertEqual(msg.content[0].thinking, 'thinking...');
  assertEqual(msg.content[1].type, 'text');
});

check('stop_reason 映射', () => {
  assertEqual(anthropic.mapStopReason('stop'), 'end_turn');
  assertEqual(anthropic.mapStopReason('tool_calls'), 'tool_use');
  assertEqual(anthropic.mapStopReason('length'), 'max_tokens');
  assertEqual(anthropic.mapStopReason(null), 'end_turn');
});

check('非法 JSON 工具参数降级为 _raw', () => {
  const msg = anthropic.chatCompletionToMessage({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{bad json' } }] } }],
    usage: {},
  }, { model: 'm' });
  assertEqual(msg.content[0].input._raw, '{bad json');
});

// ---------------------------------------------------------------------------
// 3. 流式转换（mock 上游 + 假 res）
// ---------------------------------------------------------------------------
console.log('\n[流式转换]');

function makeFakeRes() {
  const written = [];
  return {
    headersSent: false,
    statusCode: 200,
    writeHead(status) { this.headersSent = true; if (typeof status === 'number') this.statusCode = status; },
    write(s) { written.push(s); },
    // res.end() 可能带 body（util.sendJson 就是这么用的），必须一并收集
    end(s) { if (s != null) written.push(Buffer.isBuffer(s) ? s.toString('utf8') : String(s)); this.ended = true; },
    _written: written,
    /** 解析成 [{event, data}] */
    events() {
      const out = [];
      for (const block of written.join('').split('\n\n')) {
        if (!block.trim()) continue;
        let ev = null;
        let data = null;
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            try { data = JSON.parse(raw); } catch { data = raw; }
          }
        }
        if (ev) out.push({ event: ev, data });
      }
      return out;
    },
  };
}

/**
 * util.readBody() 需要一个可读流。这里用 Readable 模拟带 JSON body 的请求。
 */
const { Readable } = require('stream');
function makeFakeReq(bodyObj, extraHeaders) {
  const payload = Buffer.from(JSON.stringify(bodyObj || {}), 'utf8');
  const stream = Readable.from([payload]);
  stream.headers = Object.assign({ 'content-type': 'application/json' }, extraHeaders || {});
  stream.method = 'POST';
  stream.url = '/v1/messages';
  return stream;
}

function startMock(chunks) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        srv.lastRequest = (() => { try { return JSON.parse(body); } catch { return {}; } })();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function runStreamCase(label, chunks, reqBody) {
  const srv = await startMock(chunks);
  const port = srv.address().port;
  const fake = makeFakeRes();

  // stub 认证
  const origVerify = auth.verifyClientKey;
  const origPick = auth.pickAccountForRequest;
  const origEnd = auth.isSessionEnd;
  const origBuild = auth.buildAuthHeaders;
  const origOk = auth.recordUpstreamSuccess;
  const origBad = auth.recordUpstreamFailure;
  auth.verifyClientKey = () => ({ ok: true, keyId: '', keyName: '' });
  auth.pickAccountForRequest = async () => ({ id: 'acct', name: 'test', account: {} });
  auth.isSessionEnd = () => false;
  auth.buildAuthHeaders = () => ({});
  auth.recordUpstreamSuccess = () => {};
  auth.recordUpstreamFailure = () => false;

  // 指向 mock 上游
  const cfgMod = require(path.join(ROOT, 'core/config.js'));
  const origEndpoint = cfgMod.ENDPOINT;
  cfgMod.ENDPOINT = `http://127.0.0.1:${port}`;

  try {
    await anthropic.handleMessages(makeFakeReq(reqBody), fake);
  } finally {
    auth.verifyClientKey = origVerify;
    auth.pickAccountForRequest = origPick;
    auth.isSessionEnd = origEnd;
    auth.buildAuthHeaders = origBuild;
    auth.recordUpstreamSuccess = origOk;
    auth.recordUpstreamFailure = origBad;
    cfgMod.ENDPOINT = origEndpoint;
    srv.close();
  }
  return { events: fake.events(), upstream: srv.lastRequest, res: fake };
}

(async () => {
  // 3.1 文本流
  {
    const { events, upstream } = await runStreamCase('text', [
      { model: 'mock', choices: [{ delta: { content: 'Hello' } }] },
      { model: 'mock', choices: [{ delta: { content: ' world' } }] },
      { model: 'mock', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ], { model: 'mock', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] });

    check('流式：事件类型与顺序', () => {
      const types = events.map((e) => e.event);
      assertEqual(types[0], 'message_start');
      assert(types.includes('content_block_start'), '缺少 content_block_start');
      assert(types.includes('content_block_delta'), '缺少 content_block_delta');
      assert(types.includes('content_block_stop'), '缺少 content_block_stop');
      assertEqual(types[types.length - 2], 'message_delta');
      assertEqual(types[types.length - 1], 'message_stop');
    });

    check('流式：文本增量拼接正确', () => {
      const deltas = events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta');
      assertEqual(deltas.map((d) => d.data.delta.text).join(''), 'Hello world');
    });

    check('流式：stop_reason 正确', () => {
      const md = events.find((e) => e.event === 'message_delta');
      assertEqual(md.data.delta.stop_reason, 'end_turn');
    });
  }

  // 3.2 reasoning + 文本 + 工具
  {
    const { events } = await runStreamCase('mixed', [
      { model: 'mock', choices: [{ delta: { reasoning_content: 'think' } }] },
      { model: 'mock', choices: [{ delta: { content: 'doing' } }] },
      { model: 'mock', choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'exec' } }] } }] },
      { model: 'mock', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] },
      { model: 'mock', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ], { model: 'mock', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'x' }] });

    check('流式：thinking 块 index 为 0 且最先', () => {
      const starts = events.filter((e) => e.event === 'content_block_start');
      assertEqual(starts[0].data.content_block.type, 'thinking');
      assertEqual(starts[0].data.index, 0);
    });

    check('流式：tool_use 块带 id/name', () => {
      const starts = events.filter((e) => e.event === 'content_block_start');
      const tu = starts.find((s) => s.data.content_block.type === 'tool_use');
      assert(tu, '缺少 tool_use 块');
      assertEqual(tu.data.content_block.name, 'exec');
      assertEqual(tu.data.content_block.id, 'c1');
    });

    check('流式：input_json_delta 拼接正确', () => {
      const deltas = events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta');
      assertEqual(deltas.map((d) => d.data.delta.partial_json).join(''), '{"a":1}');
    });

    check('流式：tool_calls → stop_reason=tool_use', () => {
      const md = events.find((e) => e.event === 'message_delta');
      assertEqual(md.data.delta.stop_reason, 'tool_use');
    });

    check('流式：所有 content_block_start 都有对应 stop', () => {
      const starts = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.index);
      const stops = events.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);
      assertEqual(stops.slice().sort((a, b) => a - b), starts.slice().sort((a, b) => a - b));
    });

    check('流式：content_block index 唯一', () => {
      const starts = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.index);
      assertEqual(new Set(starts).size, starts.length, 'index 有重复');
    });
  }

  // 3.3 上游收到的请求（消息顺序）
  {
    const { upstream } = await runStreamCase('order', [
      { model: 'mock', choices: [{ delta: { content: 'ok' } }] },
      { model: 'mock', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ], {
      model: 'mock',
      max_tokens: 100,
      stream: true,
      system: 'You are Claude Code.',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'text', text: 'res' }, { type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    });

    check('上游请求：tool 紧跟 assistant(tool_calls)', () => {
      const msgs = upstream.messages;
      const ti = msgs.findIndex((m) => m.role === 'tool');
      assert(ti > 0, '未发送 tool 消息');
      assertEqual(msgs[ti - 1].role, 'assistant');
      assert(Array.isArray(msgs[ti - 1].tool_calls), 'tool 前一条缺 tool_calls');
    });

    check('上游请求：system 品牌词已净化', () => {
      const sys = upstream.messages.find((m) => m.role === 'system');
      assert(sys, '缺少 system 消息');
      assert(!/Claude Code/.test(sys.content), 'system 仍含 Claude Code');
    });

    check('上游请求：强制 stream + include_usage', () => {
      assertEqual(upstream.stream, true);
      assertEqual(upstream.stream_options.include_usage, true);
    });
  }

  // 3.4 非流式请求（客户端 stream:false）
  {
    const { events, res } = await runStreamCase('nonstream', [
      { model: 'mock', choices: [{ delta: { content: 'Hi there' } }] },
      { model: 'mock', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ], { model: 'mock', max_tokens: 100, stream: false, messages: [{ role: 'user', content: 'hi' }] });

    check('非流式：返回 JSON message 而非 SSE', () => {
      assertEqual(events.length, 0, '不应有 SSE 事件');
      const raw = res._written.join('');
      const obj = JSON.parse(raw);
      assertEqual(obj.type, 'message');
      assertEqual(obj.role, 'assistant');
      assertEqual(obj.content[0].type, 'text');
      assertEqual(obj.content[0].text, 'Hi there');
      assertEqual(obj.stop_reason, 'end_turn');
    });
  }

  // 3.5 上游错误
  {
    const srv = http.createServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 11148, msg: 'tool calls and tool results do not match' }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const fake = makeFakeRes();
    const origVerify = auth.verifyClientKey;
    const origPick = auth.pickAccountForRequest;
    const origEnd = auth.isSessionEnd;
    const origBuild = auth.buildAuthHeaders;
    const origBad = auth.recordUpstreamFailure;
    const cfgMod = require(path.join(ROOT, 'core/config.js'));
    const origEndpoint = cfgMod.ENDPOINT;
    auth.verifyClientKey = () => ({ ok: true, keyId: '', keyName: '' });
    auth.pickAccountForRequest = async () => ({ id: 'a', name: 't', account: {} });
    auth.isSessionEnd = () => false;
    auth.buildAuthHeaders = () => ({});
    auth.recordUpstreamFailure = () => false;
    cfgMod.ENDPOINT = `http://127.0.0.1:${srv.address().port}`;
    try {
      await anthropic.handleMessages(
        makeFakeReq({ model: 'mock', max_tokens: 10, stream: false, messages: [{ role: 'user', content: 'x' }] }), fake);
    } finally {
      auth.verifyClientKey = origVerify;
      auth.pickAccountForRequest = origPick;
      auth.isSessionEnd = origEnd;
      auth.buildAuthHeaders = origBuild;
      auth.recordUpstreamFailure = origBad;
      cfgMod.ENDPOINT = origEndpoint;
      srv.close();
    }

    check('上游 400 时透传状态码与错误体', () => {
      const raw = fake._written.join('');
      assert(raw.includes('11148'), '未透传上游错误码');
    });
  }

  // 3.6 缺失 messages 字段
  {
    const fake = makeFakeRes();
    const origVerify = auth.verifyClientKey;
    auth.verifyClientKey = () => ({ ok: true, keyId: '', keyName: '' });
    try {
      await anthropic.handleMessages(makeFakeReq({ model: 'm' }), fake);
    } finally {
      auth.verifyClientKey = origVerify;
    }
    check('缺少 messages 字段返回 invalid_request_error', () => {
      const raw = fake._written.join('');
      assert(raw.includes('invalid_request_error'), '未返回 invalid_request_error');
    });
  }

  console.log(`\n断言：${pass} 通过, ${fail} 失败`);
  if (fail) {
    console.log('\n失败项:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
})();
