<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '@/api';

const { t } = useI18n();
const router = useRouter();

const accounts = ref([]);
const pool = ref({ mode: 'pool', strategy: 'round-robin', pinnedId: null });
const loading = ref(false);
const notice = ref('');
const showAdd = ref(false);
const newName = ref('');
const showImport = ref(false);
const importRt = ref('');
const importName = ref('');
const importDomain = ref('');
const importing = ref(false);
const showVscode = ref(false);
const importingVscode = ref(false);

// 每日签到：每个账号的签到状态，key 为账号 id
const checkinMap = ref({});
const checkinLoading = ref(false);
const checkingId = ref('');

// 积分余额：每个账号的剩余/总积分，key 为账号 id
const creditsMap = ref({});
const creditsLoading = ref(false);

const mode = computed({
  get: () => pool.value.mode,
  set: (v) => setMode(v),
});

// 已存在从 VSCode 插件读取的账号时不重复展示「从插件读取」入口
const vscodeAccountExists = computed(() => accounts.value.some((a) => a.source === 'vscode'));

async function load() {
  loading.value = true;
  try {
    const r = await api.listAccounts();
    accounts.value = r.accounts || [];
    pool.value = r.pool || { mode: 'pool', strategy: 'round-robin', pinnedId: null };
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  } finally {
    loading.value = false;
  }
  loadCheckinAll();
  loadCreditsAll();
}

// 查询单个账号的积分余额
async function loadCredits(acct) {
  try {
    const r = await api.credits(acct.id);
    if (r?.usageLeft !== undefined) {
      creditsMap.value = { ...creditsMap.value, [acct.id]: r };
    }
  } catch (e) {
    creditsMap.value = { ...creditsMap.value, [acct.id]: { __error: e?.message || t('accounts.creditsFail') } };
  }
}

// 并行查询所有账号的积分余额（不阻塞，静默失败）
async function loadCreditsAll() {
  creditsLoading.value = true;
  try {
    await Promise.allSettled(accounts.value.map((a) => loadCredits(a)));
  } finally {
    creditsLoading.value = false;
  }
}

// 查询单个账号的签到状态
async function loadCheckin(acct) {
  try {
    const r = await api.checkinStatus(acct.id);
    if (r?.data) {
      checkinMap.value = { ...checkinMap.value, [acct.id]: r.data };
    }
  } catch (e) {
    checkinMap.value = { ...checkinMap.value, [acct.id]: { __error: e?.message || t('accounts.checkinFail') } };
  }
}

// 并行查询所有账号的签到状态（不阻塞，静默失败）
async function loadCheckinAll() {
  checkinLoading.value = true;
  try {
    await Promise.allSettled(accounts.value.map((a) => loadCheckin(a)));
  } finally {
    checkinLoading.value = false;
  }
}

// 执行单个账号签到
async function doCheckin(acct) {
  if (checkingId.value) return;
  checkingId.value = acct.id;
  try {
    const r = await api.dailyCheckin(acct.id);
    if (r?.alreadyCheckedIn) notice.value = t('accounts.checkinAlready') + '：' + (acct.name || acct.nickname || acct.uid);
    else notice.value = t('accounts.checkinSuccess') + '：' + (acct.name || acct.nickname || acct.uid);
  } catch (e) {
    notice.value = t('accounts.checkinFail') + '：' + (acct.name || acct.nickname || acct.uid) + ' — ' + e.message;
  } finally {
    checkingId.value = '';
    await loadCheckin(acct);
  }
}

function checkinState(acct) {
  const s = checkinMap.value[acct.id];
  if (!s) return null;
  if (s.__error) return { kind: 'error', text: s.__error };
  if (s.active === false) return { kind: 'off', text: t('accounts.checkinActivityOff') };
  if (s.today_checked_in) return { kind: 'done', text: t('accounts.checkinToday') };
  return { kind: 'todo', text: t('accounts.checkinNotToday') };
}

function creditsText(acct) {
  const c = creditsMap.value[acct.id];
  if (!c) return '';
  if (c.__error) return '-';
  const left = typeof c.usageLeft === 'number' ? c.usageLeft : 0;
  return String(left);
}

async function setMode(v) {
  try {
    const r = await api.setPool({ mode: v });
    pool.value = r;
    notice.value = '';
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  }
}

async function pin(id) {
  try {
    const r = await api.setPool({ mode: 'pinned', pinnedId: id });
    pool.value = r;
    notice.value = '';
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  }
}

async function openAdd() {
  showAdd.value = true;
  showImport.value = false;
  showVscode.value = false;
  newName.value = '';
}

async function doAdd() {
  const name = newName.value.trim();
  try {
    const d = await api.accountLogin(name);
    window.open(d.authUrl, '_blank');
    notice.value = t('accounts.loginStarted');
    pollLogin(d.state);
    showAdd.value = false;
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  }
}

async function openImport() {
  showImport.value = true;
  showAdd.value = false;
  showVscode.value = false;
  importRt.value = '';
  importName.value = '';
  importDomain.value = '';
}

async function openVscode() {
  showVscode.value = true;
  showAdd.value = false;
  showImport.value = false;
}

async function doVscodeImport() {
  importingVscode.value = true;
  notice.value = '';
  try {
    const r = await api.importVscode();
    if (r.ok) {
      notice.value = t('accounts.vscodeOk');
      showVscode.value = false;
      load();
    } else {
      notice.value = r.alreadyAdded ? t('accounts.vscodeAlreadyAdded') : (r.error || t('accounts.vscodeFail'));
      showVscode.value = false;
      load();
    }
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  } finally {
    importingVscode.value = false;
  }
}

async function doImport() {
  if (!importRt.value.trim()) { notice.value = t('accounts.importRtRequired'); return; }
  importing.value = true;
  notice.value = '';
  try {
    await api.importAccount({ refreshToken: importRt.value.trim(), name: importName.value.trim(), domain: importDomain.value.trim() });
    notice.value = t('accounts.importOk');
    showImport.value = false;
    load();
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  } finally {
    importing.value = false;
  }
}

function pollLogin(state) {
  const timer = setInterval(async () => {
    try {
      const sd = await api.accountLoginStatus(state);
      if (sd.status === 'success') {
        clearInterval(timer);
        notice.value = t('accounts.loginOk');
        load();
      } else if (sd.status === 'error' || sd.status === 'timeout') {
        clearInterval(timer);
        notice.value = t('common.error') + ': ' + (sd.error || t('login.timeout'));
      }
    } catch (e) {
      clearInterval(timer);
      notice.value = t('common.error') + ': ' + e.message;
    }
  }, 2000);
}

async function rename(acct) {
  const name = prompt(t('accounts.renamePrompt'), acct.name);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    await api.renameAccount(acct.id, trimmed);
    notice.value = '';
    load();
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  }
}

async function remove(acct) {
  if (!confirm(t('accounts.confirmDelete', { name: acct.name }))) return;
  try {
    await api.deleteAccount(acct.id);
    notice.value = '';
    load();
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  }
}

function fmt(ms) {
  if (!ms) return '-';
  return new Date(ms).toLocaleString();
}

function sourceText(s) {
  if (s === 'vscode') return t('overview.sourceVscode');
  if (s === 'oauth') return t('overview.sourceOauth');
  if (s === 'file') return t('overview.sourceFile');
  return t('common.unknown');
}

load();
</script>

<template>
  <div>
    <div class="card">
      <div class="head">
        <h2 class="card-title">
          {{ t('accounts.title') }}
          <span class="tip">
            <span class="tip-icon">?</span>
            <span class="tip-text">{{ t('accounts.addHint') }}</span>
          </span>
        </h2>
        <div class="head-actions">
          <button v-if="!vscodeAccountExists" class="btn btn-ghost" @click="openVscode">{{ t('accounts.vscode') }}</button>
          <button class="btn btn-ghost" @click="openImport">{{ t('accounts.import') }}</button>
          <button class="btn btn-primary" @click="openAdd">{{ t('accounts.add') }}</button>
        </div>
      </div>

      <div class="mode-row">
        <span class="mode-label">
          {{ t('accounts.mode') }}
          <span class="tip">
            <span class="tip-icon">?</span>
            <span class="tip-text">{{ t('accounts.modeHint') }}</span>
          </span>
        </span>
        <label class="radio">
          <input type="radio" value="pool" v-model="mode" />
          <span>{{ t('accounts.modePool') }}</span>
        </label>
        <label class="radio">
          <input type="radio" value="pinned" v-model="mode" />
          <span>{{ t('accounts.modePinned') }}</span>
        </label>
        <span class="hint" v-if="pool.mode === 'pinned'">{{ t('accounts.pinnedHint') }}</span>
      </div>

      <p v-if="notice" class="hint notice">{{ notice }}</p>

      <div v-if="loading" class="muted">{{ t('common.loading') }}</div>
      <div v-else-if="!accounts.length" class="muted">{{ t('accounts.empty') }}</div>

      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('accounts.colName') }}</th>
              <th>{{ t('accounts.colNickname') }}</th>
              <th>{{ t('overview.uid') }}</th>
              <th>{{ t('overview.source') }}</th>
              <th>{{ t('overview.tokenExpire') }}</th>
              <th>{{ t('accounts.colUsed') }}</th>
              <th>{{ t('accounts.credits') }}</th>
              <th>{{ t('accounts.checkin') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in accounts" :key="a.id" :class="{ pinned: pool.mode === 'pinned' && pool.pinnedId === a.id }">
              <td class="strong">
                <span v-if="pool.mode === 'pinned' && pool.pinnedId === a.id" class="badge badge-primary">{{ t('accounts.pinnedBadge') }}</span>
                {{ a.name || '-' }}
              </td>
              <td>{{ a.nickname || '-' }}</td>
              <td><code>{{ a.uid || '-' }}</code></td>
              <td>{{ sourceText(a.source) }}</td>
              <td class="muted">{{ fmt(a.expiresAt) }}</td>
              <td class="muted">{{ a.useCount }} / {{ fmt(a.lastUsedAt) }}</td>
              <td class="credits-cell">
                <span v-if="creditsText(a)" class="credits-value">{{ creditsText(a) }}</span>
                <span v-else class="muted">{{ creditsLoading ? t('common.loading') : '-' }}</span>
              </td>
              <td>
                <template v-if="checkinState(a)">
                  <span class="checkin-state" :class="checkinState(a).kind">{{ checkinState(a).text }}</span>
                </template>
                <span v-else class="muted">{{ checkinLoading ? t('common.loading') : '-' }}</span>
              </td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" :disabled="!!checkingId" @click="doCheckin(a)">{{ checkingId === a.id ? t('accounts.checkinDoing') : t('accounts.checkin') }}</button>
                <button class="btn btn-ghost btn-sm" @click="pin(a.id)">{{ t('accounts.pin') }}</button>
                <button class="btn btn-ghost btn-sm" @click="rename(a)">{{ t('common.edit') }}</button>
                <button class="btn btn-danger btn-sm" @click="remove(a)">{{ t('common.delete') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="showAdd" class="card add-card">
      <h3 class="card-title">{{ t('accounts.addTitle') }}</h3>
      <div class="field-label">{{ t('accounts.nameLabel') }}</div>
      <input class="input" v-model="newName" :placeholder="t('accounts.namePlaceholder')" />
      <div class="actions">
        <button class="btn btn-primary" @click="doAdd">{{ t('accounts.startLogin') }}</button>
        <button class="btn btn-ghost" @click="showAdd = false">{{ t('common.cancel') }}</button>
      </div>
    </div>

    <div v-if="showImport" class="card add-card">
      <h3 class="card-title">{{ t('accounts.importTitle') }}</h3>
      <div class="field-label">{{ t('accounts.nameLabel') }}</div>
      <input class="input" v-model="importName" :placeholder="t('accounts.namePlaceholder')" />
      <div class="field-label">{{ t('accounts.importRt') }}</div>
      <textarea class="input textarea" v-model="importRt" :placeholder="t('accounts.importRtPlaceholder')"></textarea>
      <div class="field-label">{{ t('accounts.importDomain') }}</div>
      <input class="input" v-model="importDomain" :placeholder="t('accounts.importDomainPlaceholder')" />
      <p class="hint">{{ t('accounts.importHint') }}</p>
      <div class="actions">
        <button class="btn btn-primary" :disabled="importing" @click="doImport">{{ importing ? t('common.saving') : t('accounts.importConfirm') }}</button>
        <button class="btn btn-ghost" @click="showImport = false">{{ t('common.cancel') }}</button>
      </div>
    </div>

    <div v-if="showVscode" class="card add-card">
      <h3 class="card-title">{{ t('accounts.vscodeTitle') }}</h3>
      <p class="hint">{{ t('accounts.vscodeHint') }}</p>
      <div class="actions">
        <button class="btn btn-primary" :disabled="importingVscode" @click="doVscodeImport">{{ importingVscode ? t('accounts.vscodeReading') : t('accounts.vscodeConfirm') }}</button>
        <button class="btn btn-ghost" @click="showVscode = false">{{ t('common.cancel') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.head-actions { display: flex; align-items: center; gap: 8px; }
.mode-row { display: flex; align-items: center; gap: 18px; margin: 8px 0 14px; flex-wrap: wrap; }
.mode-label { font-size: 13px; color: var(--text-2); font-weight: 600; }
.radio { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.radio input { margin: 0; }
.hint { font-size: 12px; }
.notice { margin-top: 10px; }

.tip { position: relative; display: inline-flex; margin-left: 4px; vertical-align: middle; }
.tip-icon {
  width: 15px; height: 15px; border-radius: 50%;
  background: var(--text-2); color: #fff;
  font-size: 10px; font-weight: 700; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: help;
}
.tip-text {
  position: absolute; top: calc(100% + 8px); left: 0;
  width: 280px; max-width: 70vw;
  padding: 9px 11px;
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
  font-size: 12px; font-weight: 400; line-height: 1.5;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  z-index: 40; text-align: left; white-space: normal;
  visibility: hidden; opacity: 0; pointer-events: none;
  transition: opacity 0.15s ease;
}
.tip:hover .tip-text { visibility: visible; opacity: 1; }
.table-wrap { overflow-x: auto; }
tr.pinned td { background: var(--primary-soft); }
.strong { font-weight: 600; }
.ops { display: flex; gap: 6px; justify-content: flex-end; white-space: nowrap; }
.checkin-state { font-size: 12px; font-weight: 600; white-space: nowrap; }
.checkin-state.done { color: var(--success, #3fb950); }
.checkin-state.todo { color: var(--warning, #d29922); }
.checkin-state.off { color: var(--text-2); }
.checkin-state.error { color: var(--danger, #f85149); }
.credits-cell { white-space: nowrap; }
.credits-value { font-weight: 600; color: var(--text); }
.btn-sm { padding: 4px 10px; font-size: 12px; }
.add-card { margin-top: 16px; }
.input { width: 100%; max-width: 420px; }
.textarea { min-height: 90px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; resize: vertical; }
.actions { display: flex; gap: 10px; margin-top: 14px; }
.badge { margin-right: 6px; }
</style>