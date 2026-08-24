<script setup>
import { ref, reactive, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRequest } from 'alova/client';
import { api } from '@/api';

const { t } = useI18n();

const { data: keyData, loading, send: reload } = useRequest(() => api.listKeys());
const { data: cfg, send: reloadConfig } = useRequest(() => api.config());

const keys = computed(() => keyData.value?.keys || []);
const enabled = computed(() => {
  // 以 API 密钥页返回的 enabled 为准；未加载时回退到 config
  if (keyData.value && keyData.value.enabled !== undefined) return !!keyData.value.enabled;
  if (cfg.value) return !!cfg.value.values?.apiKeyEnabled;
  return true;
});
const updatingEnabled = ref(false);

async function toggleEnabled(newVal) {
  updatingEnabled.value = true;
  try {
    await api.saveConfig({ apiKeyEnabled: newVal });
    await reload();
    await reloadConfig();
  } catch (e) {
    alert(`${t('settings.saveError')}: ${e.message}`);
  } finally {
    updatingEnabled.value = false;
  }
}

/* ---- 新增密钥弹窗 ---- */
const showForm = ref(false);
const saving = ref(false);
const formError = ref('');
const form = reactive({ name: '', key: '', auto: true });

function openAdd() {
  formError.value = '';
  form.name = '';
  form.key = '';
  form.auto = true;
  showForm.value = true;
}

async function submitForm() {
  saving.value = true;
  formError.value = '';
  try {
    const payload = { name: form.name.trim() };
    if (!form.auto && form.key.trim()) payload.key = form.key.trim();
    await api.addKey(payload);
    showForm.value = false;
    await reload();
  } catch (e) {
    formError.value = e.message || String(e);
  } finally {
    saving.value = false;
  }
}

/* ---- 列表操作 ---- */
const revealed = ref(new Set());

function isRevealed(k) {
  return revealed.value.has(k.id);
}

function toggleReveal(k) {
  const s = new Set(revealed.value);
  if (s.has(k.id)) s.delete(k.id);
  else s.add(k.id);
  revealed.value = s;
}

async function copyKey(k) {
  try {
    await navigator.clipboard.writeText(k.key);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = k.key;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

async function regenerate(k) {
  if (!confirm(t('apikeys.regenerateConfirm'))) return;
  try {
    const r = await api.regenerateKey(k.id);
    const fullKey = r.key?.fullKey || k.key;
    await reload();
    // 重新加载后，把刚生成的密钥展开显示
    revealed.value = new Set([k.id]);
    const arr = keyData.value?.keys || [];
    const idx = arr.findIndex((x) => x.id === k.id);
    if (idx >= 0) arr[idx] = { ...arr[idx], key: fullKey };
    alert(t('apikeys.generated'));
  } catch (e) {
    alert(`${t('apikeys.deleteError')}: ${e.message}`);
  }
}

async function remove(k) {
  if (!confirm(t('apikeys.deleteConfirm'))) return;
  try {
    await api.deleteKey(k.id);
    await reload();
  } catch (e) {
    alert(`${t('apikeys.deleteError')}: ${e.message}`);
  }
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <div>
    <div class="card">
      <h2 class="card-title">{{ t('apikeys.title') }}</h2>
      <p class="hint">{{ t('apikeys.desc') }}</p>

      <div class="setting-row" style="margin-top: 14px">
        <div>
          <div class="setting-label">{{ t('apikeys.enable') }}</div>
          <div class="hint">{{ t('apikeys.enableDesc') }}</div>
        </div>
        <label class="switch">
          <input type="checkbox" :checked="enabled" :disabled="updatingEnabled" @change="toggleEnabled($event.target.checked)" />
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <div class="card">
      <div class="head-row">
        <h2 class="card-title">
          {{ t('apikeys.current') }}
          <span class="sub">{{ t('apikeys.count', { count: keys.length }) }}</span>
        </h2>
        <button class="btn btn-primary" @click="openAdd">+ {{ t('apikeys.add') }}</button>
      </div>

      <div v-if="loading" class="muted">{{ t('common.loading') }}</div>
      <div v-else-if="!keys.length" class="empty"><span class="icon">🔑</span>{{ t('apikeys.empty') }}</div>

      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('apikeys.colName') }}</th>
              <th>{{ t('apikeys.colKey') }}</th>
              <th>{{ t('apikeys.colCreated') }}</th>
              <th>{{ t('apikeys.colUsed') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="k in keys" :key="k.id">
              <td>
                <span v-if="k.name === 'default' || k.name === 'legacy'" class="badge badge-primary" style="margin-right: 6px">
                  {{ k.name }}
                </span>
                <span v-else>{{ k.name || t('apikeys.autoName') }}</span>
              </td>
              <td>
                <code class="key-cell">{{ isRevealed(k) ? k.key : '••••••••••••' }}</code>
                <button class="btn btn-ghost btn-sm" @click="toggleReveal(k)">
                  {{ isRevealed(k) ? t('apikeys.hide') : t('apikeys.reveal') }}
                </button>
                <button class="btn btn-ghost btn-sm" @click="copyKey(k)">{{ t('apikeys.copy') }}</button>
                <div v-if="isRevealed(k)" class="hint" style="margin-top: 4px">{{ t('apikeys.copiedHint') }}</div>
              </td>
              <td class="muted">{{ fmtTime(k.createdAt) }}</td>
              <td>
                <div class="mono">{{ k.useCount || 0 }} <span class="muted">{{ t('apikeys.useCount') }}</span></div>
                <div class="hint">{{ k.lastUsedAt ? fmtTime(k.lastUsedAt) : t('apikeys.neverUsed') }}</div>
              </td>
              <td class="actions">
                <button class="btn btn-ghost btn-sm" @click="regenerate(k)">{{ t('apikeys.regenerate') }}</button>
                <button class="btn btn-danger btn-sm" @click="remove(k)">{{ t('apikeys.delete') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新增密钥弹窗 -->
    <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <div class="modal">
        <h3 class="modal-title">{{ t('apikeys.addTitle') }}</h3>

        <div class="field">
          <label>{{ t('apikeys.nameLabel') }}</label>
          <input v-model="form.name" type="text" class="input" :placeholder="t('apikeys.namePlaceholder')" />
        </div>

        <div class="field">
          <div class="mode-row">
            <label class="check">
              <input v-model="form.auto" type="radio" :value="true" />
              {{ t('apikeys.generateBtn') }}
            </label>
            <label class="check">
              <input v-model="form.auto" type="radio" :value="false" />
              {{ t('apikeys.manual') }}
            </label>
          </div>
        </div>

        <div v-if="!form.auto" class="field">
          <label>{{ t('apikeys.colKey') }}</label>
          <input v-model="form.key" type="text" class="input" :placeholder="t('apikeys.manualPlaceholder')" />
        </div>

        <div v-if="formError" class="form-error">{{ formError }}</div>

        <div class="modal-actions">
          <button class="btn btn-ghost" @click="showForm = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="saving" @click="submitForm">
            {{ saving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.setting-label { font-weight: 600; font-size: 14px; }
.table-wrap { overflow-x: auto; }
.key-cell { font-size: 12px; }
.actions { white-space: nowrap; }
.btn-sm { padding: 4px 10px; font-size: 12px; margin-left: 6px; }
.btn-danger { color: var(--danger); border-color: var(--danger-soft); }
.btn-danger:hover:not(:disabled) { background: var(--danger-soft); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }

.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { width: 440px; max-width: 92vw; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }
.modal-title { margin: 0 0 16px; font-size: 17px; }
.form-error { color: var(--danger); font-size: 13px; margin: 8px 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
.mode-row { display: flex; gap: 18px; }
.check { font-size: 13px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
</style>
