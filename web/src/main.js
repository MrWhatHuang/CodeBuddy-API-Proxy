import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import i18n from './i18n';
import { useSettings } from './stores/settings';
import './styles/main.css';

const { applyTheme } = useSettings();
applyTheme(); // 初始主题

const app = createApp(App);
app.use(router);
app.use(i18n);
app.mount('#app');
