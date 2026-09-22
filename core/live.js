'use strict';

/**
 * 实时数据（Live Monitor）：内存 ring buffer + SSE 广播中心。
 *
 * 代理入口解析出客户端原始请求体后调用 publish()，事件同时进入 ring buffer
 * （供管理页刷新后回溯）并广播给所有已订阅的 SSE 连接。纯内存实现：
 * 不落盘、进程重启即清空，因此这里不做持久化与错误恢复。
 */

/** ring buffer 容量：超过后丢弃最旧的事件 */
const MAX_EVENTS = 200;
/** 单条事件 body 上限 1MB，超出则截断并标记 truncated */
const MAX_BODY_BYTES = 1024 * 1024;
/** 心跳间隔：防止中间代理按空闲超时掐断长连接 */
const HEARTBEAT_MS = 15000;

let seq = 0;
let events = [];                 // 旧 → 新
const subscribers = new Set();   // SSE 客户端 res 集合

/** 分片写入：订阅者已断开时 write 会抛错，直接让它退订，不能影响其它订阅者 */
function writeChunk(res, text) {
  try {
    res.write(text);
    return true;
  } catch {
    unsubscribe(res);
    return false;
  }
}

/** 序列化一条 SSE 消息（消息末尾的空行是 SSE 的分帧边界） */
function sseMessage(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 写入一条事件：补齐 id/ts，塞进 ring buffer 并广播给所有订阅者。
 * 事件已由调用方（openai.js / responses.js）填好 source/kind/model/... 等字段。
 * @returns {object} 最终写入的事件对象（含 id / ts）
 */
function publish(evt) {
  const input = evt && typeof evt === 'object' ? evt : {};
  const event = { id: ++seq, ts: Date.now(), ...input };
  events.push(event);
  // ring buffer：超出容量就从头丢，最多保留 MAX_EVENTS 条
  if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);

  // 广播放在缓冲之后：任何一个订阅者写失败都不能影响其它订阅者，也不能丢事件
  for (const res of [...subscribers]) writeChunk(res, sseMessage('live', event));
  return event;
}

/**
 * 取最近的事件快照。
 * @param {number} [limit] 最多返回条数，默认全部，上限 MAX_EVENTS
 * @returns {object[]} 按 ts 升序（旧 → 新）
 */
function snapshot(limit) {
  let n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) n = events.length;
  n = Math.min(Math.floor(n), MAX_EVENTS);
  return n >= events.length ? events.slice() : events.slice(events.length - n);
}

/**
 * 注册一个 SSE 订阅者：写好响应头，先发 ready，再回放历史事件。
 * 之后每次 publish 都会推给这个 res。
 * @param {import('http').ServerResponse} res
 * @param {{limit?: number}} [opts]
 */
function subscribe(res, opts) {
  const limit = Math.min(Math.max(parseInt((opts && opts.limit), 10) || 100, 1), MAX_EVENTS);
  subscribers.add(res);

  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...require('./util').corsHeaders(),
    });
  }
  // 立即回包，让前端尽快进入「已连接」状态；回放条数写进 ready 里方便前端展示
  const replay = snapshot(limit);
  res.write(sseMessage('ready', { connected: true, seq, replayed: replay.length }));
  for (const e of replay) res.write(sseMessage('live', e));

  // 注释心跳：SSE 注释不触发 message/自定义事件，仅用于保活
  const heartbeat = setInterval(() => { writeChunk(res, ':hb\n\n'); }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
  res.__liveHeartbeat = heartbeat;
}

/** 注销一个 SSE 订阅者，并清掉它的心跳定时器 */
function unsubscribe(res) {
  subscribers.delete(res);
  if (res && res.__liveHeartbeat) {
    clearInterval(res.__liveHeartbeat);
    res.__liveHeartbeat = null;
  }
}

/** 当前 SSE 订阅者数量 */
function subscriberCount() { return subscribers.size; }

/** 清空 ring buffer（不动 id 自增，避免前端看到 id 回退） */
function clear() { events = []; }

/** 运行时统计，供 REST 快照接口与前端展示 */
function stats() {
  return { seq, count: events.length, subscribers: subscribers.size, maxEvents: MAX_EVENTS };
}

module.exports = {
  publish, snapshot, subscribe, unsubscribe, subscriberCount, clear, stats, MAX_EVENTS,
};
