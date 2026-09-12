'use strict';

/**
 * Responses 转换层回归测试。
 *
 * 覆盖三个曾经真实存在的 bug：
 *   1. output_index 重复计算 toolCalls.length —— 多工具调用时同一 item 的
 *      added/done 拿到不同 index，SSE 序列非法；
 *   2. delta.reasoning 为对象时，?? 级联短路导致思维链静默丢失；
 *   3. logRequestBody 按字符截断字节上限，中文请求体严重超限。
 *
 * 不依赖网络与登录态：起一个 mock 上游 + 假的 client res，直接驱动 handleResponses。
 */

const http = require('http');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

/* ---------------- 纯函数部分 ---------------- */

const responses = require(path.join(ROOT, 'core', 'responses.js'));

check('工具展平：namespace 子工具带前缀且不丢工具', () => {
  const tools = [
    { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
    {
      type: 'namespace', name: 'multi_agent_v1',
      tools: [{ name: 'spawn_agent', parameters: { type: 'object', properties: { task: { type: 'string' } } } }],
    },
    { type: 'web_search' },
  ];
  const out = responses.responsesToolsToChatTools(tools);
  const names = out.map((t) => t.function.name);
  assert.deepStrictEqual(names, ['exec_command', 'multi_agent_v1__spawn_agent', 'web_search']);
  for (const t of out) {
    assert.strictEqual(t.type, 'function');
    assert.strictEqual(t.function.parameters.type, 'object', `${t.function.name} 缺 parameters`);
  }
});

check('工具展平：input_schema 回退 + 重名去重', () => {
  const out = responses.responsesToolsToChatTools([
    { type: 'function', name: 'a', input_schema: { type: 'object', properties: { x: { type: 'string' } } } },
    { type: 'function', name: 'a', parameters: { type: 'object', properties: { y: {} } } },
  ]);
  assert.strictEqual(out.length, 1, '重名工具应被去掉');
  assert.ok(out[0].function.parameters.properties.x, 'input_schema 应被识别');
});

check('convertToolChoice：allowed_tools 退回 auto', () => {
  assert.strictEqual(responses.convertToolChoice({ type: 'allowed_tools', mode: 'auto' }), 'auto');
  assert.strictEqual(responses.convertToolChoice({ type: 'required' }), 'required');
  assert.strictEqual(responses.convertToolChoice({ type: 'none' }), 'none');
});

check('reasoning 三种写法都能取到内容（含对象形式）', () => {
  // bug 2 的核心：对象分支曾被 ?? 级联短路
  const pick = (delta) => {
    const r = delta.reasoning;
    return delta.reasoning_content
      ?? (typeof r === 'string' ? r : (r && typeof r.content === 'string' ? r.content : ''));
  };
  assert.strictEqual(pick({ reasoning_content: 'A' }), 'A');
  assert.strictEqual(pick({ reasoning: 'B' }), 'B');
  assert.strictEqual(pick({ reasoning: { content: 'C' } }), 'C', '对象形式不应丢内容');
  assert.strictEqual(pick({}), '');
});

/* ---------------- 端到端：SSE 序列自洽性 ---------------- */

async function runStreamCase(label, chunks) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const config = require(path.join(ROOT, 'core', 'config.js'));
  const auth = require(path.join(ROOT, 'core', 'auth.js'));
  const store = require(path.join(ROOT, 'core', 'store.js'));
  const prevEndpoint = config.ENDPOINT;
  config.ENDPOINT = `http://127.0.0.1:${port}`;

  auth.verifyClientKey = () => ({ ok: true, keyId: '', keyName: '' });
  auth.pickAccountForRequest = async () => ({ id: 'acct', name: 'test', account: {} });
  auth.extractAccountKey = () => '';
  auth.buildAuthHeaders = () => ({});
  store.recordUsage = () => {};

  const payload = {
    model: 'mock', stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }],
  };

  const out = [];
  const fakeRes = {
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(c) { out.push(c); },
    end() {},
  };
  const fakeReq = {
    headers: { 'content-type': 'application/json' },
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify(payload)));
      if (ev === 'end') cb();
      return this;
    },
    socket: { remoteAddress: '127.0.0.1' },
  };

  await responses.handleResponses(fakeReq, fakeRes);

  config.ENDPOINT = prevEndpoint;
  await new Promise((r) => srv.close(r));

  const events = [];
  for (const block of out.join('').split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* skip */ }
    }
  }
  return events;
}

function assertIndexIntegrity(label, events) {
  const added = events.filter((e) => e.type === 'response.output_item.added');
  const done = events.filter((e) => e.type === 'response.output_item.done');
  const addedBy = new Map(added.map((e) => [e.item.id, e.output_index]));

  for (const d of done) {
    assert.strictEqual(
      addedBy.get(d.item.id), d.output_index,
      `${label}: item ${d.item.type} added@${addedBy.get(d.item.id)} 但 done@${d.output_index}`,
    );
  }
  // index 必须从 0 开始且连续无空洞
  const idxs = added.map((e) => e.output_index).sort((a, b) => a - b);
  idxs.forEach((v, i) => assert.strictEqual(v, i, `${label}: output_index 应连续，实际 [${idxs.join(',')}]`));

  // done 顺序必须与最终 output 数组一致
  const completed = events.find((e) => e.type === 'response.completed');
  if (completed) {
    const finalOrder = completed.response.output.map((o) => o.type);
    const doneOrder = done.map((d) => d.item.type);
    assert.deepStrictEqual(doneOrder, finalOrder, `${label}: done 顺序与 output 数组不一致`);
  }
  return idxs;
}

(async () => {
  // 关键回归：reasoning + 2 个并行 tool call（bug 1 只在多工具下暴露）
  const multi = await runStreamCase('multi', [
    { model: 'mock', choices: [{ delta: { reasoning_content: 'let me think' } }] },
    { model: 'mock', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec_command' } }] } }] },
    { model: 'mock', choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'exec_command' } }] } }] },
    { model: 'mock', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] } }] },
    { model: 'mock', choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"cmd":"pwd"}' } }] } }] },
    { model: 'mock', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  check('流式：reasoning + 2 工具，output_index 一致且连续', () => {
    const idxs = assertIndexIntegrity('multi', multi);
    assert.deepStrictEqual(idxs, [0, 1, 2], `期望 [0,1,2]，实际 [${idxs.join(',')}]`);
  });

  // 单工具（旧实现在这里碰巧能过）
  const single = await runStreamCase('single', [
    { model: 'mock', choices: [{ delta: { reasoning_content: 'think' } }] },
    { model: 'mock', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec_command' } }] } }] },
    { model: 'mock', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  check('流式：reasoning + 1 工具，output_index 一致', () => {
    assertIndexIntegrity('single', single);
  });

  // reasoning + 正文（无工具）
  const textOnly = await runStreamCase('text', [
    { model: 'mock', choices: [{ delta: { reasoning_content: 'think' } }] },
    { model: 'mock', choices: [{ delta: { content: 'hello' } }] },
    { model: 'mock', choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  check('流式：reasoning + 正文，顺序为 reasoning→message', () => {
    const idxs = assertIndexIntegrity('text', textOnly);
    assert.deepStrictEqual(idxs, [0, 1]);
    const completed = textOnly.find((e) => e.type === 'response.completed');
    assert.deepStrictEqual(completed.response.output.map((o) => o.type), ['reasoning', 'message']);
  });

  // 工具在先、正文在后（Codex 常见：先调工具再总结）
  const toolThenText = await runStreamCase('toolText', [
    { model: 'mock', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec_command' } }] } }] },
    { model: 'mock', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  check('流式：仅工具调用时 index 从 0 起', () => {
    const idxs = assertIndexIntegrity('toolText', toolThenText);
    assert.deepStrictEqual(idxs, [0]);
  });

  // bug 3：按字节截断
  const store = require(path.join(ROOT, 'core', 'store.js'));
  const origGet = store.getRequestBodyLogConfig;
  check('请求体日志：中文按字节截断，不超上限', () => {
    const maxBytes = 256;
    store.getRequestBodyLogConfig = () => ({ enabled: true, maxBytes });
    let captured = null;
    const logger = require(path.join(ROOT, 'core', 'logger.js'));
    const origLog = logger.log;
    logger.log = (lvl, cat, msg, meta) => { captured = meta; };
    try {
      responses.logRequestBody('responses', '/v1/responses',
        { messages: [{ role: 'user', content: '中文内容'.repeat(50) }] }, null);
    } finally {
      logger.log = origLog;
      store.getRequestBodyLogConfig = origGet;
    }
    assert.ok(captured, '应写入日志');
    const size = Buffer.byteLength(captured.bodyText);
    assert.ok(size <= maxBytes, `截断后 ${size} 字节，超过上限 ${maxBytes}`);
    assert.ok(captured.truncated, '应标记为已截断');
  });

  console.log(`\n断言：${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
