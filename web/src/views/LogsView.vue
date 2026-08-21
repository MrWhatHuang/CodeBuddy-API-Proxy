<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api';
import LogLevelBadge from '@/components/LogLevelBadge.vue';

const { t } = useI18n();

const filters = reactive({ level: '', category: '', q: '' });
const items = ref([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const offset = ref(0);
const PAGE = 50;
const expandedId = ref(null);

const levels = ['debug', 'info', 'warn', 'error'];
const categories = ['system', 'auth', 'proxy', 'responses', 'config'];

const autoRefresh = ref(false);
let timer = null;

async function load(reset = true) {
  if (reset) { offset.value = 0; items.value = []; }
  loading.value = true;
  error.value = '';
  try {
    const r = await api.logs({
      level: filters.level,
      category: filters.category,
      q: filters.q,
      limit: PAGE,
      offset: offset.value,
    });
    total.value = r.total;
    items.value = reset ? r.items : [...items.value, ...r.items];
    offset.value += r.items.length;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function onFilterChange() { load(true); }
function loadMore() { load(false); }

const hasMore = computed(() => items.value.length < total.value);

async function clearLogs() {
  if (!window.confirm(t('logs.clearConfirm'))) return;
  try {
    await api.clearLogs();
    await load(true);
  } catch (e) {
    error.value = e.message;
  }
}

function toggleAuto() {
  if (autoRefresh.value) {
    timer = setInterval(() => load(true), 5000);
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toggleExpand(id) { expandedId.value = expandedId.value === id ? null : id; }

onMounted(() => load(true));
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div>
    <div class="card">
      <div class="toolbar">
        <div class="filters">
          <select v-model="filters.level" class="select" @change="onFilterChange">
            <option value="">{{ t('logs.level') }}: {{ t('common.all') }}</option>
            <option v-for="lv in levels" :key="lv" :value="lv">{{ t(`logs.level${lv[0].toUpperCase() + lv.slice(1)}`) }}</option>
          </select>
          <select v-model="filters.category" class="select" @change="onFilterChange">
            <option value="">{{ t('logs.category') }}: {{ t('common.all') }}</option>
            <option v-for="c in categories" :key="c" :value="c">{{ t(`logs.cat${c[0].toUpperCase() + c.slice(1)}`) }}</option>
          </select>
          <input
            v-model="filters.q"
            class="input search"
            :placeholder="t('logs.searchPlaceholder')"
            @keyup.enter="onFilterChange"
          />
          <button class="btn btn-ghost" @click="onFilterChange">{{ t('common.search') }}</button>
        </div>
        <div class="toolbar-actions">
          <label class="auto">
            <span>{{ t('logs.autoRefresh') }}</span>
            <span class="switch">
              <input type="checkbox" v-model="autoRefresh" @change="toggleAuto" />
              <span class="slider"></span>
            </span>
          </label>
          <button class="btn btn-danger btn-sm" @click="clearLogs">{{ t('common.clear') }}</button>
        </div>
      </div>
      <div class="meta-line">
        <span class="muted">{{ t('logs.total', { count: total }) }}</span>
        <span v-if="autoRefresh" class="muted"> · {{ t('logs.refreshHint', { seconds: 5 }) }}</span>
      </div>
    </div>

    <div class="card list-card">
      <div v-if="loading && !items.length" class="muted" style="padding: 12px 0">{{ t('common.loading') }}</div>
      <div v-else-if="error" class="muted" style="padding: 12px 0">{{ t('common.error') }}: {{ error }}</div>
      <div v-else-if="!items.length" class="empty"><span class="icon">≡</span>{{ t('common.empty') }}</div>

      <div v-else class="log-list">
        <div
          v-for="log in items"
          :key="log.id"
          class="log-row"
          :class="{ expanded: expandedId === log.id }"
          @click="toggleExpand(log.id)"
        >
          <div class="log-main">
            <span class="log-time mono">{{ fmt(log.ts) }}</span>
            <LogLevelBadge :level="log.level" :category="log.category" />
            <span class="log-msg">{{ log.message }}</span>
          </div>
          <div v-if="expandedId === log.id" class="log-detail">
            <div v-if="log.meta" class="mono meta-json">{{ JSON.stringify(log.meta, null, 2) }}</div>
            <div v-else class="muted">{{ t('logs.noMeta') }}</div>
          </div>
        </div>
      </div>

      <div v-if="hasMore" class="load-more">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadMore">{{ t('logs.loadMore') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.filters .select { width: auto; min-width: 130px; }
.search { width: 240px; }
.toolbar-actions { display: flex; align-items: center; gap: 12px; }
.auto { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.meta-line { margin-top: 12px; font-size: 12px; }
.list-card { padding: 8px; }
.log-list { display: flex; flex-direction: column; }
.log-row {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  border-radius: 8px;
  transition: background 0.12s ease;
}
.log-row:last-child { border-bottom: none; }
.log-row:hover { background: var(--surface-2); }
.log-row.expanded { background: var(--surface-2); }
.log-main { display: flex; align-items: center; gap: 10px; }
.log-time { font-size: 12px; color: var(--text-3); flex: none; }
.log-msg { font-size: 13px; flex: 1; word-break: break-word; min-width: 0; }
.log-detail { margin: 10px 0 2px; }
.meta-json {
  background: var(--code-bg);
  color: var(--code-text);
  padding: 12px 14px;
  border-radius: 8px;
  font-size: 12px;
  overflow: auto;
  max-height: 260px;
  white-space: pre-wrap;
}
.load-more { text-align: center; padding: 14px 0 8px; }
@media (max-width: 720px) {
  .log-main { flex-wrap: wrap; }
  .search { width: 100%; }
}
</style>
