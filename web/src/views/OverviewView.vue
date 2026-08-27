<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRequest } from 'alova/client';
import { api } from '@/api';
import CopyField from '@/components/CopyField.vue';
import StatCard from '@/components/StatCard.vue';
import TokenChart from '@/components/TokenChart.vue';

const { t } = useI18n();

const { data: status } = useRequest(() => api.status());

const { data: stats } = useRequest(() => api.stats());

const { data: usageStats, send: reloadUsageStats } = useRequest((dim) => api.usageStats({ dimension: dim }), { immediate: false });
const chartDimension = ref('account');
const chartLoading = ref(false);

async function loadChart(dim) {
  chartDimension.value = dim;
  chartLoading.value = true;
  try {
    await reloadUsageStats(dim);
  } finally {
    chartLoading.value = false;
  }
}
loadChart('account');

const chartSeries = computed(() => usageStats.value?.series || []);
const chartDays = computed(() => usageStats.value?.days || []);

const origin = computed(() => (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3800'));
const baseUrl = computed(() => origin.value);
const openaiBaseUrl = computed(() => `${origin.value}/v1`);
const curlTest = computed(() => `curl -N ${openaiBaseUrl.value}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"default","stream":true,"messages":[{"role":"user","content":"你好"}]}'`);

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

const apiRows = computed(() => ([
  ['GET', '/api/status', t('overview.loginStatus')],
  ['GET', '/api/config', t('nav.settings')],
  ['GET', '/api/logs', t('nav.logs')],
  ['GET', '/api/stats', t('overview.statsTitle')],
  ['GET', '/v1/models', t('models.title')],
  ['POST', '/v1/chat/completions', 'Chat'],
  ['POST', '/v1/completions', 'Completions'],
  ['POST', '/v1/embeddings', 'Embeddings'],
  ['POST', '/v1/responses', 'Responses API'],
  ['GET', '/api/import-vscode', t('overview.reimport')],
]));
</script>

<template>
  <div>
    <div v-if="status && status.accounts && status.accounts.length === 0" class="empty-banner">
      <div class="empty-banner-text">
        <span class="empty-banner-icon">!</span>
        <span>{{ t('overview.noAccount') }}</span>
      </div>
      <router-link class="btn btn-primary btn-sm" to="/accounts">{{ t('overview.goAddAccount') }}</router-link>
    </div>

    <div class="stats-row" v-if="stats">
      <StatCard :label="t('overview.logsTotal')" :value="stats.total" tone="primary" />
      <StatCard :label="t('overview.logs24h')" :value="stats.last24h" tone="info" />
      <StatCard :label="t('overview.errors24h')" :value="stats.errors24h || 0" tone="danger" />
      <StatCard :label="t('usage.totalTokens')" :value="fmtTokens(stats.usage?.totalTokens)" tone="info" />
      <StatCard :label="t('usage.cachedTokens')" :value="fmtTokens(stats.usage?.cachedTokens)" tone="warning" />
      <StatCard :label="t('usage.calls24h')" :value="stats.usage?.calls24h || 0" tone="warning" />
    </div>

    <div class="card chart-card">
      <div class="head-row">
        <h2 class="card-title">
          {{ t('overview.tokenConsumption') }}
          <span class="sub">{{ t('overview.tokenConsumptionDesc') }}</span>
        </h2>
        <div class="dim-toggle">
          <button class="btn btn-ghost btn-sm" :class="{ active: chartDimension === 'account' }" @click="loadChart('account')">
            {{ t('overview.chartByAccount') }}
          </button>
          <button class="btn btn-ghost btn-sm" :class="{ active: chartDimension === 'apiKey' }" @click="loadChart('apiKey')">
            {{ t('overview.chartByKey') }}
          </button>
        </div>
      </div>
      <div v-if="chartLoading" class="muted" style="padding: 24px 0">{{ t('common.loading') }}</div>
      <TokenChart v-else :days="chartDays" :series="chartSeries" />
    </div>

    <div class="grid2">
      <div class="card">
        <h2 class="card-title">{{ t('overview.proxyAddress') }}</h2>
        <div class="field-label">{{ t('overview.openaiBase') }}</div>
        <CopyField :value="openaiBaseUrl" />
        <div class="field-label">{{ t('overview.localBase') }}</div>
        <CopyField :value="baseUrl" />
        <p class="hint">{{ t('overview.proxyHint') }}</p>
      </div>
      <div class="card">
        <h2 class="card-title">{{ t('overview.quickTest') }}</h2>
        <pre class="codeblock">{{ curlTest }}</pre>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">{{ t('overview.apiList') }}</h2>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('common.method') }}</th>
              <th>{{ t('common.path') }}</th>
              <th>{{ t('common.desc') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in apiRows" :key="r[0] + r[1]">
              <td><span class="badge" :class="r[0] === 'GET' ? 'badge-info' : 'badge-primary'">{{ r[0] }}</span></td>
              <td><code>{{ r[1] }}</code></td>
              <td class="muted">{{ r[2] }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  margin-top: 16px;
  border: 1px solid var(--warning);
  border-radius: 10px;
  background: color-mix(in srgb, var(--warning) 12%, transparent);
}
.empty-banner-text {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
}
.empty-banner-icon {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--warning);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  flex: none;
}
.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
  margin-top: 16px;
}
.chart-card { margin-top: 16px; }
.head-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.dim-toggle { display: flex; gap: 6px; }
.dim-toggle .btn.active { background: var(--primary-soft); color: var(--primary-text); border-color: var(--primary); }
.btn-sm { padding: 5px 11px; font-size: 12px; }
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 16px 0;
  align-items: stretch;
}
.grid2 .card {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.grid2 .card + .card {
  margin-top: 0;
}
.field-label { font-size: 12px; color: var(--text-2); margin-top: 8px; }
.table-wrap { overflow-x: auto; }
@media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } }
</style>