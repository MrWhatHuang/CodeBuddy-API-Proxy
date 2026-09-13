<script setup>
import { ref, computed, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import Icon from '@/components/Icon.vue';

const { t } = useI18n();
const router = useRouter();

const accounts = ref([]);
const pool = ref({ mode: 'pool', strategy: 'round-robin', pinnedId: null });
const quotaReady = ref(true);
const autoCheckin = ref(true);
const autoCheckinSaving = ref(false);
const loading = ref(false);
const notice = ref('');
const poolSaving = ref(false);
const freezingId = ref('');
const showSessions = ref(false);
const sessions = ref([]);
const sessionsUnhealthy = ref([]);
const sessionsLoading = ref(false);
const showAdd = ref(false);
const newName = ref('');
const showImport = ref(false);
const importRt = ref('');
const importName = ref('');
const importDomain = ref('');
const importing = ref(false);
const showVscode = ref(false);
const importingVscode = ref(false);

// 账号池策略设置：收起为一个设置按钮，点击后以气泡展示各项设置
const showPoolSettings = ref(false);
const poolSettingsRef = ref(null);

// 每日签到：每个账号的签到状态，key 为账号 id
const checkinMap = ref({});
const checkinLoading = ref(false);
const checkingId = ref('');

// 积分余额：每个账号的剩余/总积分，key 为账号 id
const creditsMap = ref({});
const creditsLoading = ref(false);

const mode = computed({
  get: () => pool.value.mode,
  set: (v) => {
    onModeChange(v);
    setMode(v);
  },
});

// 已存在从 VSCode 插件读取的账号时不重复展示「从插件读取」入口
const vscodeAccountExists = computed(() => accounts.value.some((a) => a.source === 'vscode'));

async function load() {
  loading.value = true;
  try {
    const r = await api.listAccounts();
    accounts.value = r.accounts || [];
    pool.value = r.pool || { mode: 'pool', strategy: 'round-robin', pinnedId: null };
    quotaReady.value = r.quotaReady !== false;
    autoCheckin.value = r.autoCheckin !== false;
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

function isCheckedIn(s) {
  if (!s) return false;
  return !!(s.today_checked_in || s.todayCheckedIn || s.already_checked_in || s.alreadyCheckedIn
    || s.checked_in || s.checkedIn || s.has_checked_in || s.hasCheckedIn);
}

function fmtTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function checkinState(acct) {
  const s = checkinMap.value[acct.id];
  if (!s) return null;
  if (s.__error) return { kind: 'error', text: s.__error };
  if (s.active === false) return { kind: 'off', text: t('accounts.checkinActivityOff') };
  if (isCheckedIn(s)) return { kind: 'done', text: t('accounts.checkinToday') };
  const nextAt = acct.checkinNextAt;
  if (autoCheckin.value && nextAt && nextAt > Date.now()) {
    return { kind: 'todo', text: t('accounts.checkinNotToday') + ' · ' + t('accounts.autoCheckinScheduled', { time: fmtTime(nextAt) }) };
  }
  return { kind: 'todo', text: t('accounts.checkinNotToday') };
}

function creditsText(acct) {
  const c = creditsMap.value[acct.id];
  if (!c) return '';
  if (c.__error) return '-';
  const left = typeof c.usageLeft === 'number' ? c.usageLeft : 0;
  return String(left);
}

// 今日消耗（积分）：当前 usageUsed - 今日 0 时快照 usageUsed；无快照时为 '-'。
function todayUsedText(acct) {
  const c = creditsMap.value[acct.id];
  if (!c) return '';
  if (c.__error) return '-';
  if (typeof c.todayUsed !== 'number') return '-';
  return String(c.todayUsed);
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

/** 更新账号池策略配置（策略 / 粘性 / 定时切换 / 失败转移） */
async function setPoolField(patch) {
  if (poolSaving.value) return;
  poolSaving.value = true;
  const prev = { ...pool.value };
  try {
    const r = await api.setPool(patch);
    pool.value = r;
    notice.value = '';
  } catch (e) {
    pool.value = prev;   // 失败回滚，避免 UI 与服务端不一致
    notice.value = t('common.error') + ': ' + e.message;
  } finally {
    poolSaving.value = false;
  }
}

/** 数字输入：失焦时提交（空值 / 非法值回退为服务端当前值） */
function setPoolNumber(field, ev) {
  const raw = ev.target.value;
  if (raw === '' || raw == null) { ev.target.value = pool.value[field]; return; }
  const n = Number(raw);
  if (!Number.isFinite(n) || n === pool.value[field]) { ev.target.value = pool.value[field]; return; }
  setPoolField({ [field]: n });
}

/** 策略依赖积分数据；拿不到数据时服务端会退回轮询，这里给出提示 */
const strategyDegraded = computed(() => {
  const s = pool.value.strategy;
  return (s === 'quota-weighted' || s === 'least-used') && quotaReady.value === false;
});

/** 打开活跃会话面板，查看「哪些任务被粘在哪个账号上」 */
async function openSessions() {
  showSessions.value = true;
  sessionsLoading.value = true;
  try {
    const r = await api.poolSessions();
    sessions.value = r.bindings || [];
    sessionsUnhealthy.value = r.unhealthy || [];
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
    sessions.value = [];
    sessionsUnhealthy.value = [];
  } finally {
    sessionsLoading.value = false;
  }
}

/** 账号池策略设置气泡：点击外部 / 按 Esc 关闭 */
function onPoolSettingsDocClick(ev) {
  const el = poolSettingsRef.value;
  if (el && !el.contains(ev.target)) showPoolSettings.value = false;
}
function onPoolSettingsKeydown(ev) {
  if (ev.key === 'Escape') showPoolSettings.value = false;
}
function togglePoolSettings() {
  showPoolSettings.value = !showPoolSettings.value;
  if (showPoolSettings.value) {
    document.addEventListener('click', onPoolSettingsDocClick, true);
    document.addEventListener('keydown', onPoolSettingsKeydown);
  } else {
    closePoolSettings();
  }
}
function closePoolSettings() {
  showPoolSettings.value = false;
  document.removeEventListener('click', onPoolSettingsDocClick, true);
  document.removeEventListener('keydown', onPoolSettingsKeydown);
}
// 指定账号模式下策略设置无意义，切换过去时自动收起
function onModeChange(v) {
  if (v === 'pinned') closePoolSettings();
}
onBeforeUnmount(closePoolSettings);

/** 账号是否被冻结（持久化状态：冻结后不参与池轮询与失败转移） */
function isFrozen(a) {
  return !!(a && a.frozen);
}

/** 账号是否处于冷却期（服务端返回的内存态，失败转移标记） */
function isUnhealthy(a) {
  return !!(a && !a.frozen && a.unhealthy && a.unhealthy.until > Date.now());
}

/** 冻结 / 解冻账号 */
async function toggleFreeze(acct) {
  if (freezingId.value) return;
  const next = !isFrozen(acct);
  freezingId.value = acct.id;
  try {
    await api.setAccountFrozen(acct.id, next);
    notice.value = next
      ? t('accounts.frozenOn', { name: acct.name })
      : t('accounts.frozenOff', { name: acct.name });
    await load();
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  } finally {
    freezingId.value = '';
  }
}

/** 冷却原因转成可读文案 */
function unhealthyText(a) {
  const u = a && a.unhealthy;
  if (!u) return '';
  const r = String(u.reason || '');
  let label = '';
  if (r.startsWith('quota')) label = t('accounts.unhealthyReasonQuota');
  else if (r.startsWith('auth')) label = t('accounts.unhealthyReasonAuth');
  else if (r.startsWith('rate')) label = t('accounts.unhealthyReasonRate');
  else label = r;
  const until = fmtTime(u.until);
  return label + ' · ' + t('accounts.unhealthyUntil', { time: until });
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

async function onAutoCheckinChange(ev) {
  const next = !!ev.target.checked;
  const prev = autoCheckin.value;
  autoCheckin.value = next;
  autoCheckinSaving.value = true;
  try {
    const r = await api.setAutoCheckin(next);
    autoCheckin.value = r.autoCheckin !== false;
    notice.value = autoCheckin.value ? t('accounts.autoCheckinOn') : t('accounts.autoCheckinOff');
  } catch (e) {
    autoCheckin.value = prev;
    notice.value = t('common.error') + ': ' + e.message;
  } finally {
    autoCheckinSaving.value = false;
  }
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

        <!-- 账号池策略设置：仅一个图标按钮，点击后在气泡中展示各项设置（池模式下才有意义） -->
        <span v-if="pool.mode !== 'pinned'" ref="poolSettingsRef" class="pool-settings">
          <button
            class="btn btn-ghost btn-icon"
            :class="{ active: showPoolSettings }"
            :title="t('accounts.poolSettings')"
            :aria-label="t('accounts.poolSettings')"
            :aria-expanded="showPoolSettings ? 'true' : 'false'"
            @click="togglePoolSettings"
          >
            <Icon name="settings" :size="15" />
          </button>

          <!-- 气泡：以按钮为锚点绝对定位，不参与 mode-row 的 flex 布局 -->
          <div v-if="showPoolSettings" class="settings-pop" role="dialog" :aria-label="t('accounts.poolSettings')">
            <div v-if="strategyDegraded" class="pop-degraded">{{ t('accounts.strategyQuotaDegraded') }}</div>

            <div class="pop-row">
              <span class="mode-label">
                {{ t('accounts.strategy') }}
                <span class="tip">
                  <span class="tip-icon">?</span>
                  <span class="tip-text">{{ t('accounts.strategyHint') }}</span>
                </span>
              </span>
              <span class="pop-control">
                <select class="input select-sm" :value="pool.strategy" :disabled="poolSaving" @change="setPoolField({ strategy: $event.target.value })">
                  <option value="round-robin">{{ t('accounts.strategyRoundRobin') }}</option>
                  <option value="quota-weighted">{{ t('accounts.strategyQuotaWeighted') }}</option>
                  <option value="least-used">{{ t('accounts.strategyLeastUsed') }}</option>
                </select>
              </span>
            </div>

            <div class="pop-row">
              <span class="mode-label">
                {{ t('accounts.sticky') }}
                <span class="tip">
                  <span class="tip-icon">?</span>
                  <span class="tip-text">{{ t('accounts.stickyHint') }}</span>
                </span>
              </span>
              <span class="pop-control">
                <label class="switch">
                  <input type="checkbox" :checked="pool.stickyEnabled" :disabled="poolSaving" @change="setPoolField({ stickyEnabled: $event.target.checked })" />
                  <span class="slider"></span>
                </label>
              </span>
            </div>

            <template v-if="pool.stickyEnabled">
              <div class="pop-row">
                <span class="mode-label">
                  {{ t('accounts.stickyTtl') }}
                  <span class="tip">
                    <span class="tip-icon">?</span>
                    <span class="tip-text">{{ t('accounts.stickyTtlHint') }}</span>
                  </span>
                </span>
                <span class="pop-control">
                  <input class="input input-num" type="number" min="1" max="1440" :value="pool.stickyTtlMin" :disabled="poolSaving" @change="setPoolNumber('stickyTtlMin', $event)" />
                  <span class="unit">{{ t('accounts.stickyTtlUnit') }}</span>
                </span>
              </div>

              <div class="pop-row">
                <span class="mode-label">
                  {{ t('accounts.stickyGranularity') }}
                  <span class="tip">
                    <span class="tip-icon">?</span>
                    <span class="tip-text">{{ t('accounts.granularityHint') }}</span>
                  </span>
                </span>
                <span class="pop-control">
                  <select class="input select-sm" :value="pool.stickyGranularity" :disabled="poolSaving" @change="setPoolField({ stickyGranularity: $event.target.value })">
                    <option value="auto">{{ t('accounts.granularityAuto') }}</option>
                    <option value="fingerprint">{{ t('accounts.granularityFingerprint') }}</option>
                    <option value="apikey">{{ t('accounts.granularityApikey') }}</option>
                  </select>
                </span>
              </div>
            </template>

            <div class="pop-row">
              <span class="mode-label">
                {{ t('accounts.switchEnabled') }}
                <span class="tip">
                  <span class="tip-icon">?</span>
                  <span class="tip-text">{{ t('accounts.switchHint') }}</span>
                </span>
              </span>
              <span class="pop-control">
                <label class="switch">
                  <input type="checkbox" :checked="pool.switchEnabled" :disabled="poolSaving" @change="setPoolField({ switchEnabled: $event.target.checked })" />
                  <span class="slider"></span>
                </label>
              </span>
            </div>

            <template v-if="pool.switchEnabled">
              <div class="pop-row">
                <span class="mode-label">
                  {{ t('accounts.switchInterval') }}
                  <span class="tip">
                    <span class="tip-icon">?</span>
                    <span class="tip-text">{{ t('accounts.switchIntervalHint') }}</span>
                  </span>
                </span>
                <span class="pop-control">
                  <input class="input input-num" type="number" min="1" max="1440" :value="pool.switchIntervalMin" :disabled="poolSaving" @change="setPoolNumber('switchIntervalMin', $event)" />
                  <span class="unit">{{ t('accounts.stickyTtlUnit') }}</span>
                </span>
              </div>

              <div class="pop-row">
                <span class="mode-label">
                  {{ t('accounts.switchJitter') }}
                  <span class="tip">
                    <span class="tip-icon">?</span>
                    <span class="tip-text">{{ t('accounts.switchIntervalHint') }}</span>
                  </span>
                </span>
                <span class="pop-control">
                  <input class="input input-num" type="number" min="0" max="720" :value="pool.switchJitterMin" :disabled="poolSaving" @change="setPoolNumber('switchJitterMin', $event)" />
                  <span class="unit">{{ t('accounts.switchJitterUnit') }}</span>
                </span>
              </div>
            </template>

            <div class="pop-row">
              <span class="mode-label">
                {{ t('accounts.failover') }}
                <span class="tip">
                  <span class="tip-icon">?</span>
                  <span class="tip-text">{{ t('accounts.failoverHint') }}</span>
                </span>
              </span>
              <span class="pop-control">
                <label class="switch">
                  <input type="checkbox" :checked="pool.failoverEnabled" :disabled="poolSaving" @change="setPoolField({ failoverEnabled: $event.target.checked })" />
                  <span class="slider"></span>
                </label>
              </span>
            </div>

            <div class="pop-row">
              <span class="mode-label">
                {{ t('accounts.activeSessions') }}
                <span class="tip">
                  <span class="tip-icon">?</span>
                  <span class="tip-text">{{ t('accounts.activeSessionsHint') }}</span>
                </span>
              </span>
              <span class="pop-control">
                <button class="btn btn-ghost btn-sm" @click="closePoolSettings(); openSessions()">{{ t('accounts.activeSessions') }}</button>
              </span>
            </div>
          </div>
        </span>

        <label class="radio">
          <input type="radio" value="pinned" v-model="mode" />
          <span>{{ t('accounts.modePinned') }}</span>
        </label>
        <span class="hint" v-if="pool.mode === 'pinned'">{{ t('accounts.pinnedHint') }}</span>
        <span class="mode-spacer"></span>
        <span class="mode-label">
          {{ t('accounts.autoCheckin') }}
          <span class="tip">
            <span class="tip-icon">?</span>
            <span class="tip-text">{{ t('accounts.autoCheckinHint') }}</span>
          </span>
        </span>
        <label class="switch">
          <input type="checkbox" :checked="autoCheckin" :disabled="autoCheckinSaving" @change="onAutoCheckinChange" />
          <span class="slider"></span>
        </label>
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
            <tr v-for="a in accounts" :key="a.id" :class="{ pinned: pool.mode === 'pinned' && pool.pinnedId === a.id, frozen: isFrozen(a) }">
              <td class="strong">
                <span v-if="pool.mode === 'pinned' && pool.pinnedId === a.id" class="badge badge-primary">{{ t('accounts.pinnedBadge') }}</span>
                <span v-if="isFrozen(a)" class="badge badge-frozen" :title="t('accounts.frozenHint')">{{ t('accounts.frozenBadge') }}</span>
                <span v-if="isUnhealthy(a)" class="badge badge-warn" :title="unhealthyText(a)">{{ t('accounts.unhealthyBadge') }}</span>
                {{ a.name || '-' }}
                <div v-if="isUnhealthy(a)" class="unhealthy-note">{{ unhealthyText(a) }}</div>
              </td>
              <td>{{ a.nickname || '-' }}</td>
              <td><code>{{ a.uid || '-' }}</code></td>
              <td>{{ sourceText(a.source) }}</td>
              <td class="muted">{{ fmt(a.expiresAt) }}</td>
              <td class="muted">{{ a.useCount }} / {{ fmt(a.lastUsedAt) }}</td>
              <td class="credits-cell">
                <template v-if="creditsText(a)">
                  <div class="credits-value">{{ creditsText(a) }}</div>
                  <div class="credits-today" v-if="todayUsedText(a) !== '-'">
                    {{ t('accounts.todayUsed') }}：<b>{{ todayUsedText(a) }}</b>
                  </div>
                  <div class="credits-today" v-else>{{ t('accounts.todayUsed') }}：-</div>
                </template>
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
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="freezingId === a.id"
                  :title="isFrozen(a) ? t('accounts.unfreezeHint') : t('accounts.freezeHint')"
                  @click="toggleFreeze(a)"
                >{{ isFrozen(a) ? t('accounts.unfreeze') : t('accounts.freeze') }}</button>
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

    <!-- 活跃会话：查看当前被粘性固定到各账号的任务 -->
    <div v-if="showSessions" class="card add-card">
      <h3 class="card-title">{{ t('accounts.activeSessions') }}</h3>
      <p class="hint">{{ t('accounts.activeSessionsHint') }}</p>
      <div v-if="sessionsLoading" class="muted">{{ t('common.loading') }}</div>
      <div v-else-if="!sessions.length" class="muted">{{ t('accounts.sessionsEmpty') }}</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('accounts.colSessionAccount') }}</th>
              <th>{{ t('accounts.colSessionReqCount') }}</th>
              <th>{{ t('accounts.colSessionLastSeen') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sessions" :key="s.sessionKey">
              <td class="strong">{{ s.accountName }}</td>
              <td class="muted">{{ s.reqCount }}</td>
              <td class="muted">{{ fmt(s.lastSeenAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" @click="showSessions = false">{{ t('accounts.sessionsClose') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.head-actions { display: flex; align-items: center; gap: 8px; }
.mode-row { display: flex; align-items: center; gap: 18px; margin: 8px 0 14px; flex-wrap: wrap; }
.mode-spacer { flex: 1; min-width: 12px; }
.mode-label { font-size: 13px; color: var(--text-2); font-weight: 600; }
.radio { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.radio input { margin: 0; }
.hint { font-size: 12px; }
.notice { margin-top: 10px; }
.warn-text { color: var(--warning, #d29922); }

/* 账号池策略：设置图标按钮 + 设置气泡 */
.pool-settings { position: relative; display: inline-flex; }
.btn-icon { display: inline-flex; align-items: center; justify-content: center; padding: 7px; }
.btn-icon.active { border-color: var(--primary); color: var(--primary-text); background: var(--primary-soft); }
.settings-pop {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 30;
  width: 380px;
  max-width: min(92vw, 380px);
  padding: 4px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
  text-align: left;
  font-weight: 400;
}
/* 每个设置独立一行 */
.pop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
}
.pop-row + .pop-row { border-top: 1px dashed var(--border); }
.pop-control { display: inline-flex; align-items: center; gap: 6px; flex: none; }
.pop-degraded {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--warning-soft, rgba(210, 153, 34, 0.16));
  color: var(--warning, #d29922);
  font-size: 12px;
  line-height: 1.5;
}
.select-sm { width: auto; min-width: 132px; padding: 4px 8px; font-size: 13px; }
.input-num { width: 72px; padding: 4px 8px; font-size: 13px; }
.unit { font-size: 12px; color: var(--text-2); }
/* 气泡内的说明气泡靠右展开，避免溢出屏幕 */
.settings-pop .tip-text { left: auto; right: 0; width: 260px; }
/* 冻结：整行置灰，明确「不参与池轮询」 */
tr.frozen td { opacity: 0.6; }
.badge-frozen { background: var(--info-soft, rgba(56, 139, 253, 0.16)); color: var(--info, #58a6ff); }
.badge-warn { background: var(--warning-soft, rgba(210, 153, 34, 0.16)); color: var(--warning, #d29922); }
.unhealthy-note { font-size: 11px; font-weight: 400; color: var(--warning, #d29922); margin-top: 2px; }

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
.credits-today { font-size: 12px; color: var(--text-2); margin-top: 2px; }
.credits-today b { color: var(--warning, #d29922); font-weight: 600; }
.btn-sm { padding: 4px 10px; font-size: 12px; }
.add-card { margin-top: 16px; }
.input { width: 100%; max-width: 420px; }
.textarea { min-height: 90px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; resize: vertical; }
.actions { display: flex; gap: 10px; margin-top: 14px; }
.badge { margin-right: 6px; }
</style>