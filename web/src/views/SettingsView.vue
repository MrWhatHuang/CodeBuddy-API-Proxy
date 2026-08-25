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
  apiKeyEnabled: true,
  adminAuthEnabled: false,
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
  form.apiKeyEnabled = c.values.apiKeyEnabled !== false;
  form.adminAuthEnabled = c.values.adminAuthEnabled === true;
}, { immediate: true });

const saving = ref(false);
const saved = ref(false);

async function save() {
  saving.value = true;
  saved.value = false;
  try {
    const patch = {
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
      apiKeyEnabled: form.apiKeyEnabled,
      adminAuthEnabled: form.adminAuthEnabled,
    };
    await api.saveConfig(patch);
    if (patch.adminAuthEnabled) {
      window.location.href = '/admin-login';
      return;
    }
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
  form.apiKeyEnabled = true;
  form.adminAuthEnabled = false;
}

function onLocaleChange(v) {
  locale.value = v;
  setLocale(v);
}

/* ---- 管理页鉴权：改密 / 退出 ---- */
const showPwd = ref(false);
const pwdLoading = ref(false);
const pwdError = ref('');
const pwdForm = reactive({ current: '', next: '', confirm: '' });

function openPwd() {
  pwdError.value = '';
  pwdForm.current = '';
  pwdForm.next = '';
  pwdForm.confirm = '';
  showPwd.value = true;
}

async function submitPwd() {
  if (!pwdForm.next || pwdForm.next.length < 8) { pwdError.value = t('admin.login.pwTooShort'); return; }
  if (!/[A-Za-z]/.test(pwdForm.next) || !/[0-9]/.test(pwdForm.next)) { pwdError.value = t('admin.login.pwComplexity'); return; }
  if (pwdForm.next !== pwdForm.confirm) { pwdError.value = t('admin.login.pwMismatch'); return; }
  pwdLoading.value = true;
  pwdError.value = '';
  try {
    await api.adminChangePassword({ currentPassword: pwdForm.current, newPassword: pwdForm.next });
    showPwd.value = false;
    alert(t('admin.login.changed'));
  } catch (e) {
    pwdError.value = e.message || String(e);
  } finally {
    pwdLoading.value = false;
  }
}

async function doAdminLogout() {
  try { await api.adminLogout(); } catch { /* ignore */ }
  window.location.href = '/admin-login';
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
        <h2 class="card-title">{{ t('settings.apiKey') }}</h2>
        <p class="hint" style="margin-top: -8px">{{ t('settings.apiKeyDesc') }}</p>
        <div class="setting-row">
          <div>
            <div class="setting-label">{{ t('settings.apiKeyVerify') }}</div>
            <div class="hint">{{ t('settings.apiKeyVerifyDesc') }}</div>
          </div>
          <label class="switch">
            <input type="checkbox" v-model="form.apiKeyEnabled" />
            <span class="slider"></span>
          </label>
        </div>
        <div class="divider"></div>
        <div class="hint">
          {{ t('settings.apiKeyManage') }}
          <router-link to="/apikeys">{{ t('nav.apikeys') }}</router-link>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">{{ t('admin.title') }}</h2>
        <p class="hint" style="margin-top: -8px">{{ t('admin.desc') }}</p>
        <div class="setting-row">
          <div>
            <div class="setting-label">{{ t('admin.enable') }}</div>
            <div class="hint">{{ t('admin.enableDesc') }}</div>
          </div>
          <label class="switch">
            <input type="checkbox" v-model="form.adminAuthEnabled" />
            <span class="slider"></span>
          </label>
        </div>
        <div class="divider"></div>
        <div class="hint" style="margin-bottom: 12px">
          {{ t('admin.usernameLabel') }} <code>{{ cfg.values.adminUsername }}</code>
        </div>
        <div class="actions-row">
          <button class="btn btn-ghost" @click="openPwd">{{ t('admin.changePassword') }}</button>
          <button class="btn btn-danger" @click="doAdminLogout">{{ t('admin.logout') }}</button>
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

    <!-- 修改管理员密码弹窗 -->
    <div v-if="showPwd" class="modal-mask" @click.self="showPwd = false">
      <div class="modal">
        <h3 class="modal-title">{{ t('admin.changePassword') }}</h3>
        <div class="field">
          <label>{{ t('admin.currentPassword') }}</label>
          <input v-model="pwdForm.current" type="password" class="input" autocomplete="current-password" />
        </div>
        <div class="field">
          <label>{{ t('admin.newPassword') }}</label>
          <input v-model="pwdForm.next" type="password" class="input" autocomplete="new-password" />
        </div>
        <div class="field">
          <label>{{ t('admin.confirmPassword') }}</label>
          <input v-model="pwdForm.confirm" type="password" class="input" autocomplete="new-password" />
        </div>
        <div v-if="pwdError" class="form-error">{{ pwdError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="showPwd = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="pwdLoading" @click="submitPwd">
            {{ pwdLoading ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>
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
.actions-row { display: flex; gap: 10px; }
.btn-danger { color: var(--danger); border-color: var(--danger-soft); }
.btn-danger:hover:not(:disabled) { background: var(--danger-soft); }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { width: 400px; max-width: 92vw; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }
.modal-title { margin: 0 0 16px; font-size: 17px; }
.modal .field { margin-bottom: 14px; }
.modal .field label { display: block; font-size: 13px; color: var(--text-2); margin-bottom: 6px; }
.form-error { color: var(--danger); font-size: 13px; margin: 8px 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
</style>
