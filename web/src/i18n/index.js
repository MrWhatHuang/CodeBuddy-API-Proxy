import { createI18n } from 'vue-i18n';
import zhCN from './locales/zh-CN';
import enUS from './locales/en-US';

const locale = localStorage.getItem('cbp.locale') || (navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US');

const i18n = createI18n({
  legacy: false,
  locale,
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
});

export default i18n;
