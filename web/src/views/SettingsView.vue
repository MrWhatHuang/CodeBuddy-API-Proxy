<script setup>
import { ref, reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRequest } from 'alova/client';
import { api } from '@/api';
import { useSettings } from '@/stores/settings';

const { t, locale } = useI18n();
const { theme, setTheme, setLocale } = useSettings();

const { data: cfg, loading, send: reload } = useRequest(() => api.config());

const form = reactive({
  loggingEnabled: true,
  loggingDetails: true,
  logLevel: 'info',
  retentionDays: 7,
  maxRows: 10000,
  autoOpen: true,
  defaultModel: 'default',
  forceModel: '',
  requestTimeoutSec: 300,
  corsOrigin: '*',
});

watch(cfg, (c) => {
  if (!c) return;
  form.loggingEnabled = c.values.logging.enabled;
  form.loggingDetails = c.values.logging.details;
  form.logLevel = c.values.logging.level;
  form.retentionDays = c.values.logging.retentionDays;
  form.maxRows = c.values.logging.maxRows;
  form.autoOpen = c.values.autoOpen;
  form.defaultModel = c.values.defaultModel;
  form.forceModel = c.values.forceModel || '';
  form.requestTimeoutSec = Math.round((c.values.requestTimeoutMs || 300000) / 1000);
  form.corsOrigin = c.values.corsOrigin || '*';
}, { immediate: true });

const saving = ref(false);
const saved = ref(false);

async function save() {
  saving.value = true;
  saved.value = false;
  try {
    await api.saveConfig({
      logging: {
        enabled: form.loggingEnabled,
        details: form.loggingDetails,
        level: form.logLevel,
        retentionDays: Number(form.retentionDays),
        maxRows: Number(form.maxRows),
      },
      autoOpen: form.autoOpen,
      defaultModel: form.defaultModel,
      forceModel: form.forceModel.trim(),
      requestTimeoutMs: Number(form.requestTimeoutSec) * 1000,
      corsOrigin: form.corsOrigin.trim() || '*',
    });
    await reload();
    saved.value = true;
    setTimeout(() => { saved.value = false; }, 2000);
  } catch (e) {
    alert(`${t('settings.saveError')}: ${e.message}`);
  } finally {
    saving.value = false;
  }
}

function resetForm() {
  form.loggingEnabled = true;
  form.loggingDetails = true;
  form.logLevel = 'info';
  form.retentionDays = 7;
  form.maxRows = 10000;
  form.autoOpen = true;
  form.defaultModel = 'default';
  form.forceModel = '';
  form.requestTimeoutSec = 300;
  form.corsOrigin = '*';
}

function onLocaleChange(v) {
  locale.value = v;
  setLocale(v);
}

const levels = ['debug', 'info', 'warn', 'error'];
</script>

<template>
  <div>
    <div v-if="loading" class="card muted">{{ t('common.loading') }}</div>

    <template v-else-if="cfg">
      <div class="card">
        <h2 class="card-title">{{ t('settings.appearance') }}</h2>
        <p class="hint" style="margin-top: -8px">{{ t('settings.appearanceDesc') }}</p>
        <div class="grid">
          <div class="field">
            <label>{{ t('settings.theme') }}</label>
            <select :value="theme" class="select" @change="setTheme($event.target.value)">
              <option value="system">{{ t('theme.system') }}</option>
              <option value="light">{{ t('theme.light') }}</option>
              <option value="dark">{{ t('theme.dark') }}</option>
            </select>
          </div>
          <div class="field">
            <label>{{ t('settings.language') }}</label>
            <select :value="locale" class="select" @change="onLocaleChange($event.target.value)">
              <option value="zh-CN">中文</option>
              <option value="en-US">English</option>
            </select>
          </div>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">{{ t('settings.logging') }}</h2>
        <p class="hint" style="margin-top: -8px">{{ t('settings.loggingDesc') }}</p>

        <div class="setting-row">
          <div>
            <div class="setting-label">{{ t('settings.loggingEnabled') }}</div>
            <div class="hint">{{ t('settings.loggingEnabledDesc') }}</div>
          </div>
          <label class="switch">
            <input type="checkbox" v-model="form.loggingEnabled" />
            <span class="slider"></span>
          </label>
        </div>

        <div class="divider"></div>

        <div class="setting-row">
          <div>
            <div class="setting-label">{{ t('settings.loggingDetails') }}</div>
            <div class="hint">{{ t('settings.loggingDetailsDesc') }}</div>
          </div>
          <label class="switch">
            <input type="checkbox" v-model="form.loggingDetails" />
            <span class="slider"></span>
          </label>
        </div>

        <div class="divider"></div>

        <div class="grid">
          <div class="field">
            <label>{{ t('settings.logLevel') }}</label>
            <select v-model="form.logLevel" class="select">
              <option v-for="lv in levels" :key="lv" :value="lv">{{ t(`logs.level${lv[0].toUpperCase() + lv.slice(1)}`) }}</option>
            </select>
            <p class="hint">{{ t('settings.logLevelDesc') }}</p>
          </div>
          <div class="field">
            <label>{{ t('settings.retention') }}</label>
            <input v-model.number="form.retentionDays" type="number" min="0" class="input" />
            <p class="hint">{{ t('settings.retentionDesc') }}</p>
          </div>
          <div class="field">
            <label>{{ t('settings.maxRows') }}</label>
            <input v-model.number="form.maxRows" type="number" min="0" class="input" />
            <p class="hint">{{ t('settings.maxRowsDesc') }}</p>
          </div>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">{{ t('settings.behavior') }}</h2>
        <p class="hint" style="margin-top: -8px">{{ t('settings.behaviorDesc') }}</p>
        <div class="setting-row">
          <div>
            <div class="setting-label">{{ t('settings.autoOpen') }}</div>
            <div class="hint">{{ t('settings.autoOpenDesc') }}</div>
          </div>
          <label class="switch">
            <input type="checkbox" v-model="form.autoOpen" />
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">{{ t('settings.proxy') }}</h2>
        <p class="hint" style="margin-top: -8px">{{ t('settings.proxyDesc') }}</p>
        <div class="grid">
          <div class="field">
            <label>{{ t('settings.requestTimeout') }}</label>
            <input v-model.number="form.requestTimeoutSec" type="number" min="1" max="1800" class="input" />
            <p class="hint">{{ t('settings.requestTimeoutDesc') }}</p>
          </div>
          <div class="field">
            <label>{{ t('settings.corsOrigin') }}</label>
            <input v-model="form.corsOrigin" type="text" class="input" :placeholder="t('settings.corsOriginPlaceholder')" />
            <p class="hint">{{ t('settings.corsOriginDesc') }}</p>
          </div>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">{{ t('settings.model') }}</h2>
        <p class="hint" style="margin-top: -8px">{{ t('settings.modelDesc') }}</p>
        <div class="grid">
          <div class="field">
            <label>{{ t('settings.defaultModel') }}</label>
            <select v-model="form.defaultModel" class="select">
              <option v-for="m in cfg.options.models" :key="m.id" :value="m.id">{{ m.id }} — {{ m.name }}</option>
            </select>
            <p class="hint">{{ t('settings.defaultModelDesc') }}</p>
          </div>
          <div class="field">
            <label>{{ t('settings.forceModel') }}</label>
            <input v-model="form.forceModel" type="text" class="input" :placeholder="t('settings.forceModelPlaceholder')" />
            <p class="hint">{{ t('settings.forceModelDesc') }}</p>
          </div>
        </div>
      </div>

      <div class="card save-bar">
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? t('common.saving') : t('common.save') }}
        </button>
        <button class="btn btn-ghost" @click="resetForm">{{ t('settings.restoreDefault') }}</button>
        <span v-if="saved" class="saved-hint">✓ {{ t('settings.saveSuccess') }}</span>
      </div>

      <div class="card">
        <h2 class="card-title">{{ t('settings.runtime') }}</h2>
        <p class="hint" style="margin-top: -8px">{{ t('settings.runtimeDesc') }}</p>
        <div class="kv">
          <div class="kv-item"><span class="k">{{ t('settings.version') }}</span><span class="v mono">{{ cfg.runtime.version }}</span></div>
          <div class="kv-item"><span class="k">{{ t('settings.host') }}</span><span class="v mono">{{ cfg.runtime.host }}</span></div>
          <div class="kv-item"><span class="k">{{ t('settings.port') }}</span><span class="v mono">{{ cfg.runtime.port }}</span></div>
          <div class="kv-item"><span class="k">{{ t('settings.platform') }}</span><span class="v mono">{{ cfg.runtime.platform }}</span></div>
          <div class="kv-item"><span class="k">{{ t('settings.endpoint') }}</span><span class="v mono">{{ cfg.runtime.endpoint }}</span></div>
          <div class="kv-item"><span class="k">{{ t('settings.sessionFile') }}</span><span class="v mono">{{ cfg.runtime.sessionFile }}</span></div>
          <div class="kv-item"><span class="k">{{ t('settings.dbFile') }}</span><span class="v mono">{{ cfg.runtime.dbFile }}</span></div>
          <div class="kv-item"><span class="k">{{ t('settings.dataDir') }}</span><span class="v mono">{{ cfg.runtime.dataDir }}</span></div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.setting-label { font-weight: 600; font-size: 14px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}
.save-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  position: sticky;
  bottom: 16px;
}
.saved-hint { color: var(--success); font-weight: 600; font-size: 13px; }
.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px 24px;
  margin-top: 12px;
}
.kv-item .k { display: block; font-size: 12px; color: var(--text-2); }
.kv-item .v { font-size: 13px; font-weight: 600; word-break: break-all; }
</style>
