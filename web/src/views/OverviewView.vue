<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRequest } from 'alova/client';
import { api } from '@/api';
import CopyField from '@/components/CopyField.vue';
import StatCard from '@/components/StatCard.vue';

const { t } = useI18n();

const { data: status, loading: loadingStatus, error: statusError, send: reloadStatus } =
  useRequest(() => api.status());

const { data: stats, send: reloadStats } = useRequest(() => api.stats());

function refreshAll() {
  reloadStatus();
  reloadStats();
}

const reimporting = ref(false);
const loggingOut = ref(false);
const notice = ref('');

async function reimport() {
  reimporting.value = true;
  notice.value = '';
  try {
    const r = await api.importVscode();
    notice.value = r.ok ? t('overview.reimportOk') : (r.error || t('overview.reimportFail'));
  } catch (e) {
    notice.value = `${t('common.error')}: ${e.message}`;
  } finally {
    reimporting.value = false;
    refreshAll();
  }
}

async function logout() {
  loggingOut.value = true;
  try {
    await api.logout();
  } catch (e) {
    notice.value = `${t('common.error')}: ${e.message}`;
  } finally {
    loggingOut.value = false;
    refreshAll();
  }
}

const host = computed(() => (typeof window !== 'undefined' ? window.location.host : '127.0.0.1:3800'));
const baseUrl = computed(() => status.value?.baseUrl || `http://${host.value}`);
const openaiBaseUrl = computed(() => status.value?.openaiBaseUrl || `http://${host.value}/v1`);
const curlTest = computed(() => `curl -N ${openaiBaseUrl.value}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"default","stream":true,"messages":[{"role":"user","content":"你好"}]}'`);

const sourceText = computed(() => {
  const s = status.value?.source;
  if (s === 'vscode') return t('overview.sourceVscode');
  if (s === 'oauth') return t('overview.sourceOauth');
  if (s === 'file') return t('overview.sourceFile');
  return t('common.unknown');
});

function fmt(ms) {
  if (!ms) return '-';
  return new Date(ms).toLocaleString();
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
    <div class="card hero">
      <h2 class="card-title">
        <span class="status-dot" :class="{ off: !status?.loggedIn }"></span>
        {{ t('overview.loginStatus') }}
        <span class="sub" v-if="status?.endpoint">{{ status.endpoint }}</span>
      </h2>

      <div v-if="loadingStatus" class="muted">{{ t('common.loading') }}</div>
      <div v-else-if="statusError" class="muted">{{ t('common.error') }}: {{ statusError.message }}</div>

      <template v-else-if="status?.loggedIn">
        <div class="kv">
          <div class="kv-item"><span class="k">{{ t('overview.user') }}</span><span class="v">{{ status.account?.nickname || '-' }}</span></div>
          <div class="kv-item"><span class="k">{{ t('overview.uid') }}</span><span class="v mono">{{ status.account?.uid || '-' }}</span></div>
          <div class="kv-item"><span class="k">{{ t('overview.domain') }}</span><span class="v mono">{{ status.auth?.domain || '-' }}</span></div>
          <div class="kv-item"><span class="k">{{ t('overview.source') }}</span><span class="v">{{ sourceText }}</span></div>
          <div class="kv-item"><span class="k">{{ t('overview.tokenExpire') }}</span><span class="v">{{ fmt(status.auth?.expiresAt) }}</span></div>
        </div>
        <div class="actions">
          <button class="btn btn-ghost" :disabled="reimporting" @click="reimport">
            {{ reimporting ? t('overview.reimporting') : t('overview.reimport') }}
          </button>
          <button class="btn btn-danger" :disabled="loggingOut" @click="logout">
            {{ loggingOut ? t('overview.loggingOut') : t('overview.logout') }}
          </button>
        </div>
      </template>

      <template v-else>
        <p class="muted">{{ t('overview.notLoggedInHint') }}</p>
        <div class="actions">
          <router-link class="btn btn-primary" to="/login">{{ t('overview.login') }}</router-link>
          <button class="btn btn-ghost" :disabled="reimporting" @click="reimport">
            {{ reimporting ? t('overview.reimporting') : t('overview.reimport') }}
          </button>
        </div>
      </template>
      <p v-if="notice" class="hint notice">{{ notice }}</p>
    </div>

    <div class="stats-row" v-if="stats">
      <StatCard :label="t('overview.logsTotal')" :value="stats.total" tone="primary" />
      <StatCard :label="t('overview.logs24h')" :value="stats.last24h" tone="info" />
      <StatCard :label="t('overview.errors24h')" :value="stats.errors24h || 0" tone="danger" />
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
.hero { overflow: hidden; }
.status-dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--success); display: inline-block;
  box-shadow: 0 0 0 3px var(--success-soft);
}
.status-dot.off { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px 20px;
  margin: 16px 0;
}
.kv-item .k { display: block; font-size: 12px; color: var(--text-2); margin-bottom: 2px; }
.kv-item .v { font-size: 13px; font-weight: 600; word-break: break-all; }
.actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
  margin-top: 16px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 16px;
}
.field-label { font-size: 12px; color: var(--text-2); margin-top: 8px; }
.notice { margin-top: 12px; }
.table-wrap { overflow-x: auto; }
@media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } }
</style>
