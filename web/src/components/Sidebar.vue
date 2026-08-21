<script setup>
import { useI18n } from 'vue-i18n';
import Icon from './Icon.vue';

const { t } = useI18n();

const items = [
  { name: 'overview', icon: 'overview', labelKey: 'overview', to: '/home' },
  { name: 'models', icon: 'models', labelKey: 'models', to: '/models' },
  { name: 'logs', icon: 'logs', labelKey: 'logs', to: '/logs' },
  { name: 'settings', icon: 'settings', labelKey: 'settings', to: '/settings' },
];
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="logo">¢</span>
      <div class="brand-text">
        <div class="brand-name">CodeBuddy</div>
        <div class="brand-sub">API Proxy</div>
      </div>
    </div>

    <nav class="nav">
      <router-link
        v-for="it in items"
        :key="it.name"
        :to="it.to"
        class="nav-item"
        active-class="active"
      >
        <Icon :name="it.icon" :size="17" />
        <span>{{ t(`nav.${it.labelKey}`) }}</span>
      </router-link>
    </nav>

    <div class="footer">
      <span class="dot"></span>
      <span class="muted">{{ t('footer.powered') }}</span>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  width: var(--sidebar-w);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  border-right: 1px solid var(--border);
  padding: 18px 12px;
  z-index: 20;
  backdrop-filter: blur(12px);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 18px;
}
.logo {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
  flex: none;
  box-shadow: 0 8px 18px rgba(99, 102, 241, 0.28);
}
.brand-name {
  font-weight: 750;
  font-size: 14px;
  letter-spacing: -0.02em;
  line-height: 1.2;
}
.brand-sub {
  font-size: 11px;
  color: var(--text-2);
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 10px;
  color: var(--text-2);
  font-weight: 550;
  transition: all 0.15s ease;
}
.nav-item:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}
.nav-item.active {
  background: var(--primary-soft);
  color: var(--primary-text);
}
.footer {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 10px 2px;
  font-size: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}
@media (max-width: 820px) {
  .sidebar {
    position: static;
    width: 100%;
    flex-direction: row;
    align-items: center;
    padding: 10px 12px;
    border-right: none;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .brand { padding: 0 12px 0 4px; }
  .brand-sub { display: none; }
  .nav { flex-direction: row; margin: 0; }
  .nav-item { white-space: nowrap; }
  .footer { display: none; }
}
</style>
