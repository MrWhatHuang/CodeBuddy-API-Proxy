<script setup>
import { ref, reactive, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRequest } from 'alova/client';
import { api } from '@/api';
import StatCard from '@/components/StatCard.vue';

const { t } = useI18n();

const { data: accountsData } = useRequest(() => api.listAccounts());
const { data: keysData } = useRequest(() => api.listKeys());
const { data: status } = useRequest(() => api.status());

const accounts = computed(() => accountsData.value?.accounts || []);
const keys = computed(() => keysData.value?.keys || []);
const models = computed(() => status.value?.models || []);

const filters = reactive({
  range: 'today',
  accountId: '',
  apiKeyId: '',
  model: '',
  status: '',
});

const from = ref(null);

function rangeToFrom(r) {
  const now = new Date();
  const d = new Date(now);
  switch (r) {
    case 'today': d.setHours(0, 0, 0, 0); return d.getTime();
    case '7d': d.setDate(d.getDate() - 6); d.setHours(0, 0, 0, 0); return d.getTime();
    case '14d': d.setDate(d.getDate() - 13); d.setHours(0, 0, 0, 0); return d.getTime();
    case '30d': d.setDate(d.getDate() - 29); d.setHours(0, 0, 0, 0); return d.getTime();
    default: return null;
  }
}

const query = computed(() => ({
  from: from.value,
  accountId: filters.accountId,
  apiKeyId: filters.apiKeyId,
  model: filters.model,
  status: filters.status,
}));

const { data: usage, loading, send: reload } = useRequest((p) => api.usage(p), {
  immediate: false,
});
const { data: usageTotals, send: reloadTotals } = useRequest((p) => api.usageStats(p), {
  immediate: false,
});

const { data: statsData, loading: statsLoading, send: reloadStats } = useRequest(
  (p) => api.usage({ from: p.from, limit: 1, offset: 0 }),
  { immediate: false }
);

const pageSize = 50;
const offset = ref(0);

async function loadStats() {
  await reloadStats({ from: rangeToFrom(filters.range) });
}

async function loadList(reset = true) {
  if (reset) offset.value = 0;
  from.value = rangeToFrom(filters.range);
  const p = {
    ...query.value,
    limit: pageSize,
    offset: offset.value,
  };
  await reload(p);
}

async function load(reset = true) {
  await Promise.all([loadList(reset), loadStats(), reloadTotals({ dimension: 'account', from: from.value })]);
  return usage.value;
}

watch(filters, () => { loadList(true); loadStats(); }, { deep: true, immediate: true });

const items = computed(() => usage.value?.items || []);

function loadMore() {
  offset.value += pageSize;
  loadList(false);
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function fmtDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function fmtRate(n) {
  if (!n && n !== 0) return '—';
  return n.toFixed(1) + '%';
}

function accountLabel(r) {
  return r.accountName || t('usage.noAccount');
}
function keyLabel(r) {
  return r.apiKeyName || t('usage.noKey');
}

function exportCsv() {
  const headers = ['time', 'endpoint', 'model', 'account', 'key', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'cache_hit_rate', 'total_tokens', 'duration_ms', 'status'];
  const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  for (const r of items.value) {
    lines.push([
      new Date(r.ts).toISOString(), r.source, r.model,
      r.accountName, r.apiKeyName,
      r.promptTokens, r.completionTokens, r.cachedTokens,
      (r.cacheHitRate == null ? '' : r.cacheHitRate.toFixed(1)),
      r.totalTokens, r.durationMs, r.status,
    ].map(esc).join(','));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `usage-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div>
    <div class="stats-row" v-if="statsData">
      <StatCard :label="t('usage.totalCalls')" :value="statsData.calls" tone="primary" />
      <StatCard :label="t('usage.totalTokens')" :value="fmtTokens(statsData.totalTokens)" tone="info" />
      <StatCard :label="t('usage.promptTokens')" :value="fmtTokens(statsData.promptTokens)" tone="info" />
      <StatCard :label="t('usage.completionTokens')" :value="fmtTokens(statsData.completionTokens)" tone="success" />
      <StatCard :label="t('usage.cachedTokens')" :value="fmtTokens(statsData.cachedTokens)" tone="warning" />
      <StatCard :label="t('usage.cacheHitRate')" :value="fmtRate(statsData.cacheHitRate)" tone="warning" />
      <StatCard :label="t('usage.calls24h')" :value="usageTotals?.totals?.calls24h || 0" tone="warning" />
      <StatCard :label="t('usage.tokens24h')" :value="fmtTokens(usageTotals?.totals?.tokens24h)" tone="warning" />
    </div>

    <div class="card">
      <div class="filter-bar">
        <select v-model="filters.range" class="select filter-item">
          <option value="today">{{ t('usage.rangeToday') }}</option>
          <option value="7d">{{ t('usage.range7d') }}</option>
          <option value="14d">{{ t('usage.range14d') }}</option>
          <option value="30d">{{ t('usage.range30d') }}</option>
          <option value="all">{{ t('usage.rangeAll') }}</option>
        </select>

        <select v-model="filters.accountId" class="select filter-item">
          <option value="">{{ t('usage.filterAccount') }} — {{ t('usage.filterAll') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name || a.nickname || a.uid }}</option>
        </select>

        <select v-model="filters.apiKeyId" class="select filter-item">
          <option value="">{{ t('usage.filterKey') }} — {{ t('usage.filterAll') }}</option>
          <option v-for="k in keys" :key="k.id" :value="k.id">{{ k.name }}</option>
        </select>

        <select v-model="filters.model" class="select filter-item">
          <option value="">{{ t('usage.filterModel') }} — {{ t('usage.filterAll') }}</option>
          <option v-for="m in models" :key="m.id" :value="m.id">{{ m.id }}</option>
        </select>

        <select v-model="filters.status" class="select filter-item">
          <option value="">{{ t('usage.filterAll') }}</option>
          <option value="ok">{{ t('usage.statusOk') }}</option>
          <option value="error">{{ t('usage.statusError') }}</option>
        </select>

        <button class="btn btn-ghost" @click="exportCsv">{{ t('usage.export') }}</button>
        <button class="btn btn-ghost" @click="load(true)" :disabled="loading">{{ t('usage.refresh') }}</button>
      </div>

      <div v-if="loading" class="muted" style="padding: 20px 0">{{ t('common.loading') }}</div>
      <div v-else-if="!items.length" class="empty"><span class="icon">▦</span>{{ t('usage.empty') }}</div>

      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('usage.colTime') }}</th>
              <th>{{ t('usage.colSource') }}</th>
              <th>{{ t('usage.colModel') }}</th>
              <th>{{ t('usage.colAccount') }}</th>
              <th>{{ t('usage.colKey') }}</th>
              <th>{{ t('usage.colTokens') }}</th>
              <th>{{ t('usage.colCached') }}</th>
              <th>{{ t('usage.colDuration') }}</th>
              <th>{{ t('usage.colStatus') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in items" :key="r.id">
              <td class="muted nowrap">{{ fmtTime(r.ts) }}</td>
              <td><code class="src">{{ r.source }}</code></td>
              <td class="mono">{{ r.model }}</td>
              <td>{{ accountLabel(r) }}</td>
              <td><span v-if="r.apiKeyName" class="badge badge-neutral">{{ r.apiKeyName }}</span><span v-else class="muted">{{ t('usage.noKey') }}</span></td>
              <td class="mono nowrap">
                <span class="tokens-in">{{ fmtTokens(r.promptTokens) }}</span> /
                <span class="tokens-out">{{ fmtTokens(r.completionTokens) }}</span> /
                <b>{{ fmtTokens(r.totalTokens) }}</b>
              </td>
              <td class="mono nowrap">
                <span class="tokens-cached" :class="{ 'muted': !r.cachedTokens }">{{ fmtTokens(r.cachedTokens) }}</span>
                <span v-if="r.cacheHitRate" class="muted cache-rate">({{ fmtRate(r.cacheHitRate) }})</span>
              </td>
              <td class="mono muted nowrap">{{ fmtDuration(r.durationMs) }}</td>
              <td class="nowrap">
                <span class="badge" :class="r.status === 'ok' ? 'badge-success' : 'badge-danger'">
                  {{ r.status === 'ok' ? t('usage.statusOk') : t('usage.statusError') }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="footer-row" v-if="items.length">
        <button class="btn btn-ghost btn-sm" @click="loadMore" v-if="usage && offset + items.length < usage.total">
          {{ t('usage.loadMore') }} ({{ usage.total }})
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
  margin: 0 0 16px;
}
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.filter-item { flex: 1 1 150px; max-width: 210px; }
.table-wrap { overflow-x: auto; }
.nowrap { white-space: nowrap; }
.src { font-size: 12px; }
.tokens-in { color: var(--info); }
.tokens-out { color: var(--success); }
.tokens-cached { color: var(--warning); }
.cache-rate { font-size: 12px; margin-left: 2px; }
.footer-row { margin-top: 14px; display: flex; align-items: center; gap: 10px; }
</style>
