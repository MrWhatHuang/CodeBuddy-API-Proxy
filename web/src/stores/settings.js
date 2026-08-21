import { ref, watch } from 'vue';
import i18n from '@/i18n';

const THEME_KEY = 'cbp.theme';
const LOCALE_KEY = 'cbp.locale';

const theme = ref(localStorage.getItem(THEME_KEY) || 'system');
const locale = ref(localStorage.getItem(LOCALE_KEY) || detectLocale());

function detectLocale() {
  const nav = (navigator.language || 'zh-CN').toLowerCase();
  return nav.startsWith('zh') ? 'zh-CN' : 'en-US';
}

function resolveTheme(t) {
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  const resolved = resolveTheme(theme.value);
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved;
}

function applyLocale(v) {
  i18n.global.locale.value = v;
  document.documentElement.setAttribute('lang', v);
}

watch(theme, (v) => {
  localStorage.setItem(THEME_KEY, v);
  applyTheme();
});

watch(locale, (v) => {
  localStorage.setItem(LOCALE_KEY, v);
  applyLocale(v);
});

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme.value === 'system') applyTheme();
  });
}

applyLocale(locale.value);

export function useSettings() {
  return {
    theme,
    locale,
    applyTheme,
    setTheme: (t) => { theme.value = t; },
    setLocale: (l) => { locale.value = l; },
    isDark: () => resolveTheme(theme.value) === 'dark',
  };
}
