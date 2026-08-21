<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettings } from '@/stores/settings';
import Icon from './Icon.vue';

defineProps({ title: { type: String, default: '' } });

const { t, locale } = useI18n();
const { theme, setTheme, setLocale } = useSettings();

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
</script>

<template>
  <header class="topbar">
    <h1 class="title">{{ title }}</h1>
    <div class="actions">
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
@media (max-width: 820px) {
  .topbar { padding: 12px 16px; }
  .title { font-size: 16px; }
  .hide-sm { display: none; }
}
</style>
