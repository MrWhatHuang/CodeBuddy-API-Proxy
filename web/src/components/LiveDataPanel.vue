<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';

const props = defineProps({
  title: { type: String, default: '' },
  startLabel: { type: String, default: '' },
  stopLabel: { type: String, default: '' },
  labels: { type: Object, default: () => ({}) },
});

/** 文案兜底：缺键不报错，优先 props.labels，其次内置中文 */
const DEFAULTS = {
  waiting: '正在等待数据…',
  connected: '已连接',
  connecting: '连接中…',
  stopped: '已停止',
  disconnected: '已断开',
  body: '请求体',
  empty: '点击右上角「开始监测」后，这里会实时展示接口调用发送过来的完整请求 body',
  headers: '请求头',
  response: '响应',
  pretty: '美化',
  raw: '原始',
  truncated: '已截断',
  parseError: '解析失败',
  clear: '清空',
  count: '事件',
  bytes: '字节',
  events: '事件',
  copy: '复制',
  copied: '已复制',
  autoScroll: '自动滚动',
  pause: '暂停',
  resume: '继续',
  expand: '展开',
  collapse: '收起',
  hideHeaders: '隐藏请求头',
  showHeaders: '显示请求头',
  noSelection: '请选择左侧一条事件查看完整 body',
  noBody: '（空 body）',
  latest: '最新',
  error: '订阅出错',
};

function label(key) {
  const v = props.labels && props.labels[key];
  if (v !== undefined && v !== null && v !== '') return v;
  return DEFAULTS[key] !== undefined ? DEFAULTS[key] : key;
}

const MAX_EVENTS = 300;
const STREAM_URL = '/api/live/stream?limit=100';

const events = ref([]);
const selectedId = ref(null);
const subscribing = ref(false); // 用户点击开始后为 true（即使连接断开也保留）
const connected = ref(false);
const errorMsg = ref('');
const pretty = ref(true);
const showHeaders = ref(false);
const copied = ref(false);
const paused = ref(false);
/** 是否跟随最新事件：为 true 时新事件到达会更新预览区；用户手动点选后置 false */
const followLatest = ref(true);
let es = null;
let copyTimer = null;

const statusKey = computed(() => {
  if (!subscribing.value) return 'stopped';
  if (connected.value) return paused.value ? 'pause' : 'connected';
  return 'disconnected';
});

const statusText = computed(() => label(statusKey.value));

const selected = computed(() => events.value.find((e) => e.id === selectedId.value) || null);

/** 全部输出先经 HTML 转义，再插入着色 span —— 输入永不被解析为标签 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON 美化 + 语法着色（输出 HTML，供 v-html）。
 * 安全模型：先把整段文本 escapeHtml（< > & " ' 全部转成实体），再用正则插入自己的
 * <span> 着色标签。着色标签是本函数生成的常量字符串，用户内容只出现在标签之间，
 * 因此任何 body 内容都无法逃逸成标签或属性（无 XSS）。
 *
 * 说明：文本转义后，JSON 的引号是 `&quot;` / `&#39;` 这些实体，而不是字面引号，
 * 所以正则必须按实体来匹配（下文的 ENT 片段），否则字符串/键都不会着色。
 */
function highlightJson(text) {
  const safe = escapeHtml(text);
  const c = (name, fallback) => `var(--json-${name}, ${fallback})`;
  // 转义后的引号实体（" -> &quot;  ' -> &#39;）
  const quote = '(?:&quot;|&#39;)';
  // 字符串内部：转义序列 \\x，或任何不是引号实体开头的一个字符
  const inner = '(?:\\\\.|&(?!quot;|#39;)|[^&\\\\])*';
  const str = `${quote}${inner}${quote}`;
  const re = new RegExp(
    `(${str})(\\s*:)?`          // 1: 字符串  2: 紧跟的冒号 => 判定为 key
    + `|\\b(true|false|null)\\b` // 3: 布尔 / null
    + `|(-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)`, // 4: 数字
    'g',
  );
  return safe.replace(re, (m, keyStr, colon, bool, num) => {
    if (keyStr) {
      if (colon) return `<span style="color:${c('key', '#7dd3fc')}">${keyStr}</span>${colon}`;
      return `<span style="color:${c('string', '#86efac')}">${keyStr}</span>`;
    }
    if (bool) return `<span style="color:${c('bool', '#c4b5fd')}">${bool}</span>`;
    if (num) return `<span style="color:${c('number', '#fca5a5')}">${num}</span>`;
    return m;
  });
}

const prettyText = computed(() => {
  const ev = selected.value;
  if (!ev) return '';
  if (ev.body === null || ev.body === undefined) {
    return typeof ev.bodyText === 'string' && ev.bodyText ? ev.bodyText : label('noBody');
  }
  try {
    return JSON.stringify(ev.body, null, 2);
  } catch {
    return String(ev.bodyText || label('noBody'));
  }
});

const rawBodyText = computed(() => {
  const ev = selected.value;
  if (!ev) return '';
  if (typeof ev.bodyText === 'string' && ev.bodyText) return ev.bodyText;
  if (ev.body === null || ev.body === undefined) return '';
  try {
    return JSON.stringify(ev.body);
  } catch {
    return '';
  }
});

const displayHtml = computed(() => (
  pretty.value ? highlightJson(prettyText.value) : escapeHtml(rawBodyText.value || label('noBody'))
));

const headerEntries = computed(() => {
  const ev = selected.value;
  if (!ev || !ev.headers || typeof ev.headers !== 'object') return [];
  return Object.keys(ev.headers).map((k) => [k, ev.headers[k]]);
});

/** 自动滚动：开启时新事件到达后把列表滚回顶部（列表最新在最上面） */
const listEl = ref(null);
watch(events, () => {
  if (paused.value) return;
  const el = listEl.value;
  if (el && el.scrollTop > 0) el.scrollTop = 0;
}, { flush: 'post' });

function fmtTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

function fmtModel(ev) {
  const m = ev && ev.model ? String(ev.model) : '';
  if (!m) return '-';
  return m.length > 28 ? m.slice(0, 27) + '…' : m;
}

function eventLabel(ev) {
  const path = ev.source || ev.kind || '';
  return path || '/v1';
}

/** 收到一条 SSE 事件：解析后 prepend 到列表头部（上限 300 条） */
function accept(raw) {
  if (paused.value) return; // 暂停时不更新列表（连接保持，恢复后继续接收）
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    errorMsg.value = label('parseError');
    return;
  }
  if (!ev || typeof ev !== 'object') return;
  if (ev.id === undefined || ev.id === null) ev.id = `t${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!Array.isArray(events.value)) events.value = [];
  events.value = [ev, ...events.value].slice(0, MAX_EVENTS);
  // 跟随最新：预览区默认展示刚到达的这条，用户手动点选某条后不再抢焦点
  if (selectedId.value === null || followLatest.value) {
    selectedId.value = ev.id;
    followLatest.value = true;
  }
  errorMsg.value = '';
}

function start() {
  if (es) return;
  subscribing.value = true;
  errorMsg.value = '';
  try {
    es = new EventSource(STREAM_URL);
  } catch (e) {
    es = null;
    subscribing.value = false;
    errorMsg.value = (e && e.message) || label('error');
    return;
  }
  es.onopen = () => { connected.value = true; errorMsg.value = ''; };
  es.addEventListener('live', (e) => { connected.value = true; accept(e.data); });
  es.addEventListener('ready', () => { connected.value = true; });
  es.onerror = () => { connected.value = false; }; // EventSource 自动重连，不手动重建
}

function stop() {
  if (es) {
    es.onerror = null;
    es.close();
    es = null;
  }
  subscribing.value = false;
  connected.value = false;
}

function toggle() {
  if (subscribing.value) stop();
  else start();
}

function selectEvent(id) {
  selectedId.value = id;
  // 手动选看历史事件后停止跟随，避免下一条到达时把视图抢走
  followLatest.value = false;
  showHeaders.value = false;
}

function togglePause() {
  paused.value = !paused.value;
}

function toggleHeaders() {
  showHeaders.value = !showHeaders.value;
}

function togglePretty() {
  pretty.value = !pretty.value;
}

function clearEvents() {
  const msg = props.labels && props.labels.clearConfirm
    ? props.labels.clearConfirm
    : '确定要清空当前实时数据列表吗？';
  if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(msg)) return;
  events.value = [];
  selectedId.value = null;
  followLatest.value = true;
  showHeaders.value = false;
}

/** 当前展示内容的纯文本（复制用，不含高亮标签） */
function currentText() {
  return pretty.value ? prettyText.value : rawBodyText.value;
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

async function copyBody() {
  const text = currentText();
  if (!text) return;
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) ok = fallbackCopy(text);
  if (!ok) return;
  copied.value = true;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copied.value = false; }, 1600);
}

onUnmounted(() => {
  if (copyTimer) clearTimeout(copyTimer);
  if (es) {
    es.onerror = null;
    es.close();
    es = null;
  }
  subscribing.value = false;
  connected.value = false;
});
</script>

<template>
  <div class="card live-root">
    <div class="live-head">
      <h3 class="card-title live-title">
        {{ title || '实时数据' }}
        <span class="live-status" :class="`live-status-${statusKey}`">
          <span class="live-dot"></span>{{ statusText }}
        </span>
      </h3>
      <div class="live-head-actions">
        <span v-if="errorMsg" class="live-error">{{ errorMsg }}</span>
        <button
          class="btn btn-sm"
          :class="subscribing ? 'btn-danger' : 'btn-primary'"
          @click="toggle"
        >
          {{ subscribing ? (stopLabel || '停止监测') : (startLabel || '开始监测') }}
        </button>
      </div>
    </div>

    <div class="live-grid">
      <div class="live-list">
        <div class="live-list-head">
          <span class="muted live-count">
            {{ label('events') }} · {{ events.length }}
          </span>
          <button class="btn btn-ghost btn-sm" :disabled="!events.length" @click="clearEvents">
            {{ label('clear') }}
          </button>
        </div>

        <div v-if="!events.length" class="live-list-empty">
          <div class="empty live-empty">
            <span class="icon">≋</span>
            <template v-if="!subscribing">{{ label('empty') }}</template>
            <template v-else>{{ label('waiting') }}</template>
          </div>
        </div>

        <div v-else ref="listEl" class="live-rows">
          <div
            v-for="ev in events"
            :key="ev.id"
            class="live-row"
            :class="{ 'live-row-active': ev.id === selectedId }"
            @click="selectEvent(ev.id)"
          >
            <div class="live-row-top">
              <span class="live-time mono">{{ fmtTime(ev.ts) }}</span>
              <span class="badge badge-neutral live-kind">{{ ev.kind || 'openai' }}</span>
              <span v-if="ev.stream" class="badge badge-info live-stream">{{ label('response') }}</span>
              <span class="live-bytes mono">{{ fmtBytes(ev.bodyBytes) }}</span>
            </div>
            <div class="live-row-bottom">
              <span class="mono live-path" :title="ev.source">{{ eventLabel(ev) }}</span>
              <span class="mono live-model" :title="ev.model || ''">{{ fmtModel(ev) }}</span>
              <span v-if="ev.truncated" class="badge badge-warning">{{ label('truncated') }}</span>
              <span v-if="ev.parseError" class="badge badge-danger">{{ label('parseError') }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="live-detail">
        <div class="live-detail-bar">
          <span class="live-detail-label">
            {{ label('body') }}
            <span v-if="selected" class="muted">· {{ fmtBytes(selected.bodyBytes) }}</span>
          </span>
          <div class="live-detail-actions">
            <button
              class="btn btn-ghost btn-sm"
              :disabled="!selected"
              @click="togglePretty"
            >
              {{ pretty ? label('raw') : label('pretty') }}
            </button>
            <button
              class="btn btn-ghost btn-sm"
              :disabled="!selected || !headerEntries.length"
              @click="toggleHeaders"
            >
              {{ showHeaders ? label('hideHeaders') : label('showHeaders') }}
            </button>
            <button
              class="btn btn-ghost btn-sm"
              :disabled="!selected"
              @click="copyBody"
            >
              {{ copied ? label('copied') : label('copy') }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="togglePause">
              {{ paused ? label('resume') : label('pause') }}
            </button>
          </div>
        </div>

        <div v-if="selected && selected.truncated" class="live-notice live-notice-warn">
          {{ label('truncated') }} · {{ fmtBytes(selected.bodyBytes) }}
        </div>
        <div v-if="selected && selected.parseError" class="live-notice live-notice-danger">
          {{ label('parseError') }}: {{ selected.parseError }}
        </div>

        <div v-if="selected" class="live-meta-line">
          <span class="muted">{{ selected.accountName || selected.accountId || '-' }}</span>
          <span v-if="selected.apiKeyName" class="muted"> · {{ selected.apiKeyName }}</span>
          <span v-if="selected.requestId" class="muted mono"> · {{ selected.requestId }}</span>
        </div>

        <div v-if="showHeaders && headerEntries.length" class="live-headers">
          <div class="live-headers-title">{{ label('headers') }}</div>
          <div v-for="[k, v] in headerEntries" :key="k" class="live-header-row">
            <span class="mono live-header-key">{{ k }}</span>
            <span class="mono live-header-val" :title="String(v)">{{ v }}</span>
          </div>
        </div>

        <div v-if="!selected" class="live-detail-empty">
          <div class="empty live-empty">
            <span class="icon">{ }</span>
            {{ events.length ? label('noSelection') : label('empty') }}
          </div>
        </div>
        <div v-show="selected" class="live-code codeblock" v-html="displayHtml"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.live-root { padding: 18px 20px 20px; }
.live-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.live-title {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  font-weight: 600;
}
.live-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
}
.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
  flex: none;
}
.live-status-connected { color: var(--success, #16a34a); }
.live-status-connected .live-dot { background: var(--success, #16a34a); }
.live-status-pause { color: var(--warning, #d97706); }
.live-status-pause .live-dot { background: var(--warning, #d97706); }
.live-status-disconnected { color: var(--danger, #dc2626); }
.live-status-disconnected .live-dot { background: var(--danger, #dc2626); }
.live-head-actions { display: inline-flex; align-items: center; gap: 10px; }
.live-error { font-size: 12px; color: var(--danger, #dc2626); }

.live-grid {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: 14px;
  margin-top: 14px;
}

.live-list {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  height: 420px;
  min-width: 0;
  overflow: hidden;
}
.live-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.live-count { font-size: 12px; }
.live-list-empty { flex: 1; display: flex; align-items: center; justify-content: center; }
.live-empty { padding: 24px 16px; font-size: 12px; line-height: 1.6; }
.live-empty .icon { font-size: 26px; }
.live-rows { flex: 1; overflow: auto; padding: 4px; }
.live-row {
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.live-row:hover { background: var(--surface); }
.live-row-active {
  background: var(--surface);
  border-color: var(--primary);
}
.live-row-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.live-time { font-size: 11px; color: var(--text-3); flex: none; }
.live-kind { flex: none; }
.live-stream { flex: none; }
.live-bytes { font-size: 11px; color: var(--text-3); margin-left: auto; flex: none; }
.live-row-bottom {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  min-width: 0;
}
.live-path {
  font-size: 11px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.live-model {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: none;
  max-width: 45%;
  margin-left: auto;
}

.live-detail {
  border: 1px solid var(--border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  height: 420px;
  min-width: 0;
  overflow: hidden;
}
.live-detail-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
  flex-wrap: wrap;
}
.live-detail-label { font-size: 12px; font-weight: 600; color: var(--text-2); }
.live-detail-actions { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.live-notice {
  font-size: 12px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.live-notice-warn { color: var(--warning, #d97706); background: var(--warning-soft, rgba(217, 119, 6, 0.1)); }
.live-notice-danger { color: var(--danger, #dc2626); background: var(--danger-soft, rgba(220, 38, 38, 0.1)); }
.live-meta-line {
  font-size: 11px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-headers {
  flex: none;
  max-height: 150px;
  overflow: auto;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.live-headers-title { font-size: 11px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.live-header-row { display: flex; gap: 8px; font-size: 11px; line-height: 1.7; }
.live-header-key { color: var(--text-3); flex: none; min-width: 96px; }
.live-header-val { word-break: break-all; min-width: 0; }
.live-detail-empty { flex: 1; display: flex; align-items: center; justify-content: center; }
.live-code {
  flex: 1;
  margin: 0;
  border-radius: 0;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  tab-size: 2;
}

@media (max-width: 720px) {
  .live-grid { grid-template-columns: minmax(0, 1fr); }
  .live-list { height: 220px; }
  .live-detail { height: 380px; }
  .live-detail-actions { width: 100%; }
}
</style>
