<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettings } from '@/stores/settings';
import { api } from '@/api';
import Icon from './Icon.vue';

defineProps({
  title: { type: String, default: '' },
  version: { type: String, default: '' },
});

const { t, locale } = useI18n();
const { theme, setTheme, setLocale } = useSettings();

/* ---------------- 主题 / 语言 ---------------- */

const themeCycle = ['system', 'light', 'dark'];
const themeIcon = computed(() => ({ system: 'monitor', light: 'sun', dark: 'moon' }[theme.value] || 'monitor'));
const themeLabel = computed(() => t(`theme.${theme.value}`));

function toggleTheme() {
  const i = themeCycle.indexOf(theme.value);
  setTheme(themeCycle[(i + 1) % themeCycle.length]);
}

function toggleLocale() {
  const next = locale.value === 'zh-CN' ? 'en-US' : 'zh-CN';
  locale.value = next;
  setLocale(next);
}

/* ---------------- 版本检查 / 自更新 ---------------- */

// idle 表示尚未查到或静默查询失败：徽标保持原样，不打扰用户
const checkState = ref('idle'); // idle | checking | uptodate | available | error
const checkInfo = ref(null);
const checkError = ref('');
const panelOpen = ref(false);

const applying = ref(false);
const applySteps = ref([]);
const applyError = ref('');
const applyDone = ref(false);

const hasUpdate = computed(() => checkState.value === 'available');
const latest = computed(() => (checkInfo.value && checkInfo.value.latest) || '');
const git = computed(() => (checkInfo.value && checkInfo.value.git) || {});
// 非 git 部署 / 无远端 / 工作区有改动时不能自动更新，需提示用户手动处理
const canAutoUpdate = computed(() => !!git.value.isGit && !!git.value.hasOrigin && !git.value.dirty);

const badgeTitle = computed(() => {
  if (checkState.value === 'checking') return t('nav.versionChecking');
  if (hasUpdate.value) return t('nav.updateAvailableTitle', { latest: latest.value });
  if (checkState.value === 'uptodate') return t('nav.versionUpToDate');
  if (checkState.value === 'error') return t('nav.versionCheckFailed');
  return t('nav.versionTitle');
});

async function runCheck(silent = true) {
  checkState.value = 'checking';
  checkError.value = '';
  try {
    const r = await api.checkUpdate();
    checkInfo.value = r;
    if (r && r.ok) {
      checkState.value = r.hasUpdate ? 'available' : 'uptodate';
    } else {
      // 检查失败（如离线）不升级为错误态，除非用户主动打开面板
      checkState.value = silent ? 'idle' : 'error';
      checkError.value = (r && r.error) || '';
    }
  } catch (e) {
    checkState.value = silent ? 'idle' : 'error';
    checkError.value = e.message || String(e);
  }
}

// 检查是顺带的，失败不打扰：挂载时静默查询
onMounted(() => { runCheck(true); });

function openPanel() {
  panelOpen.value = true;
  if (!applying.value) runCheck(false);
}

function closePanel() {
  if (applying.value) return; // 更新中不允许关闭，避免用户以为可以中断
  panelOpen.value = false;
}

async function doUpdate() {
  if (applying.value) return;
  applying.value = true;
  applyError.value = '';
  applySteps.value = [];
  applyDone.value = false;
  try {
    const r = await api.applyUpdate();
    applySteps.value = (r && r.steps) || [];
    applyDone.value = true;
    checkState.value = 'uptodate';
  } catch (e) {
    applyError.value = (e && e.message) || String(e);
  } finally {
    applying.value = false;
  }
}

function reloadPage() {
  window.location.reload();
}

function onKeydown(e) {
  if (e.key === 'Escape' && panelOpen.value) closePanel();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <header class="topbar">
    <h1 class="title">{{ title }}</h1>
    <div class="actions">
      <!-- 版本徽标：检测到新版本时高亮且可点击 -->
      <button
        v-if="version"
        class="version"
        :class="{ 'version--update': hasUpdate, 'version--busy': checkState === 'checking' }"
        :title="badgeTitle"
        @click="openPanel"
      >
        <span>v{{ version }}</span>
        <template v-if="hasUpdate">
          <span class="version-dot" aria-hidden="true"></span>
          <span class="version-new">→ v{{ latest }}</span>
        </template>
      </button>

      <a
        class="icon-btn"
        href="https://github.com/MrWhatHuang/CodeBuddy-API-Proxy"
        target="_blank"
        rel="noopener noreferrer"
        :title="t('nav.github')"
      >
        <Icon name="github" :size="16" />
        <span class="hide-sm">{{ t('nav.github') }}</span>
      </a>
      <button class="icon-btn" :title="themeLabel" @click="toggleTheme">
        <Icon :name="themeIcon" :size="16" />
        <span class="hide-sm">{{ themeLabel }}</span>
      </button>
      <button
        class="icon-btn"
        :title="locale === 'zh-CN' ? 'Switch to English' : '切换到中文'"
        @click="toggleLocale"
      >
        {{ locale === 'zh-CN' ? 'EN' : '中文' }}
      </button>
    </div>
  </header>

  <!-- 更新面板 -->
  <div v-if="panelOpen" class="update-mask" @click.self="closePanel">
    <div class="update-panel" role="dialog" aria-modal="true">
      <div class="update-head">
        <div class="update-head-title">
          <Icon :name="hasUpdate ? 'spark' : 'refresh'" :size="16" />
          <span>{{ t('update.title') }}</span>
        </div>
        <button class="update-close" :disabled="applying" :title="t('common.close')" @click="closePanel">×</button>
      </div>

      <div class="update-body">
        <div class="update-versions">
          <div class="ver-box">
            <div class="ver-label">{{ t('update.current') }}</div>
            <div class="ver-value">v{{ version }}</div>
          </div>
          <div class="ver-arrow">→</div>
          <div class="ver-box" :class="{ 'ver-box--new': hasUpdate }">
            <div class="ver-label">{{ t('update.latest') }}</div>
            <div class="ver-value">{{ latest ? 'v' + latest : '—' }}</div>
          </div>
        </div>

        <div v-if="checkState === 'checking'" class="update-note">{{ t('update.checking') }}</div>
        <div v-else-if="checkState === 'uptodate' && !applyDone" class="update-note update-note--ok">
          <Icon name="check" :size="14" /> {{ t('update.upToDate') }}
        </div>
        <div v-else-if="checkState === 'error'" class="update-note update-note--err">
          {{ t('update.checkFailed') }}{{ checkError ? '：' + checkError : '' }}
        </div>
        <div v-else-if="hasUpdate" class="update-note">
          {{ t('update.availableNote', { latest }) }}
        </div>

        <!-- 不能自动更新时说明原因 -->
        <div v-if="hasUpdate && !canAutoUpdate" class="update-warn">
          <div v-if="!git.isGit">{{ t('update.notGit') }}</div>
          <div v-else-if="!git.hasOrigin">{{ t('update.noRemote') }}</div>
          <div v-else-if="git.dirty">{{ t('update.dirty') }}</div>
          <div class="update-warn-cmd">git stash &amp;&amp; npm install &amp;&amp; npm run build</div>
        </div>

        <div v-if="applySteps.length" class="update-steps">
          <div v-for="(s, i) in applySteps" :key="i" class="update-step" :class="{ 'is-bad': !s.ok }">
            <span class="step-icon">{{ s.ok ? '✓' : '✕' }}</span>
            <div class="step-main">
              <div class="step-name">{{ s.name }}</div>
              <pre v-if="s.detail" class="step-detail">{{ s.detail }}</pre>
            </div>
          </div>
        </div>

        <div v-if="applyError" class="update-note update-note--err">{{ applyError }}</div>

        <div v-if="applyDone" class="update-restart">
          <div class="update-restart-title">
            <Icon name="check" :size="14" /> {{ t('update.doneTitle') }}
          </div>
          <div class="update-restart-body">{{ t('update.restartRequired') }}</div>
        </div>
      </div>

      <div class="update-foot">
        <template v-if="applyDone">
          <button class="btn btn-primary" @click="reloadPage">{{ t('update.reloadPage') }}</button>
        </template>
        <template v-else>
          <button class="btn" :disabled="applying" @click="closePanel">{{ t('common.cancel') }}</button>
          <button
            class="btn btn-primary"
            :disabled="applying || !hasUpdate || !canAutoUpdate"
            @click="doUpdate"
          >
            {{ applying ? t('update.updating') : t('update.updateNow') }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 28px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 78%, transparent);
  backdrop-filter: blur(10px);
  position: sticky;
  top: 0;
  z-index: 10;
}
.title {
  font-size: 18px;
  font-weight: 720;
  margin: 0;
  letter-spacing: -0.02em;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.icon-btn {
  height: 34px;
  min-width: 34px;
  padding: 0 11px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.15s ease;
}
.icon-btn:hover { background: var(--surface-2); border-color: var(--border-strong); }

.version {
  height: 34px;
  padding: 0 11px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  letter-spacing: 0.01em;
  user-select: none;
  cursor: pointer;
  transition: all 0.15s ease;
}
.version:hover { border-color: var(--border-strong); background: var(--surface); }
.version--busy { opacity: 0.7; }
.version--update {
  border-color: var(--success, #2ea043);
  background: color-mix(in srgb, var(--success, #2ea043) 14%, transparent);
  color: var(--text);
}
.version--update:hover { background: color-mix(in srgb, var(--success, #2ea043) 22%, transparent); }
.version-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success, #2ea043);
  flex: none;
}
.version-new { color: var(--success, #2ea043); font-weight: 700; }

/* ---------------- 更新面板 ---------------- */

.update-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 20px;
}
.update-panel {
  width: 100%;
  max-width: 520px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}
.update-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.update-head-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 680;
  font-size: 14px;
}
.update-close {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  border-radius: 6px;
}
.update-close:hover:not(:disabled) { color: var(--text); background: var(--surface-2); }
.update-close:disabled { opacity: 0.4; cursor: not-allowed; }

.update-body { padding: 16px 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }

.update-versions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
}
.ver-box {
  flex: 1;
  text-align: center;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface-2);
}
.ver-box--new { border-color: var(--success, #2ea043); }
.ver-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.ver-value {
  font-size: 15px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.ver-arrow { color: var(--muted); font-size: 16px; }

.update-note { font-size: 13px; color: var(--muted); line-height: 1.6; display: flex; align-items: center; gap: 6px; }
.update-note--ok { color: var(--success, #2ea043); }
.update-note--err { color: var(--danger, #e5534b); }

.update-warn {
  font-size: 12.5px;
  line-height: 1.6;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--warning, #d29922) 50%, transparent);
  background: color-mix(in srgb, var(--warning, #d29922) 12%, transparent);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.update-warn-cmd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  align-self: flex-start;
}

.update-steps { display: flex; flex-direction: column; gap: 8px; }
.update-step { display: flex; gap: 8px; font-size: 12.5px; align-items: flex-start; }
.step-icon { color: var(--success, #2ea043); font-weight: 700; flex: none; }
.update-step.is-bad .step-icon { color: var(--danger, #e5534b); }
.step-name { font-weight: 620; }
.step-detail {
  margin: 3px 0 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 130px;
  overflow: auto;
  background: var(--surface-2);
  border-radius: 6px;
  padding: 6px 8px;
}

.update-restart {
  border-radius: 9px;
  border: 1px solid var(--success, #2ea043);
  background: color-mix(in srgb, var(--success, #2ea043) 12%, transparent);
  padding: 11px 13px;
  font-size: 13px;
  line-height: 1.6;
}
.update-restart-title { font-weight: 700; display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }

.update-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}

@media (max-width: 820px) {
  .topbar { padding: 12px 16px; }
  .title { font-size: 16px; }
  .hide-sm { display: none; }
  .version-new { display: none; }
}
@media (max-width: 520px) {
  .version { display: none; }
}
</style>
