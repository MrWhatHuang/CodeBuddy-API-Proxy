<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useRequest } from 'alova/client';
import { api } from '@/api';
import Sidebar from '@/components/Sidebar.vue';
import TopBar from '@/components/TopBar.vue';

const route = useRoute();
const { t } = useI18n();

const { data: config } = useRequest(() => api.config());

const needsBuild = computed(() => !!config.value?.runtime?.build?.needsBuild);
const reload = () => window.location.reload();

const isLogin = computed(() => route.name === 'login');
const pageTitle = computed(() => {
  if (route.meta?.title) return t(`nav.${route.meta.title}`);
  return t('app.title');
});
</script>

<template>
  <div v-if="isLogin" class="login-root">
    <router-view />
  </div>

  <div v-else class="layout">
    <Sidebar />
    <div class="main">
      <div v-if="needsBuild" class="build-banner">
        <div class="build-banner-text">
          <span class="build-banner-icon">!</span>
          <span>{{ t('build.warnText') }}</span>
        </div>
        <div class="build-banner-code">npm install && npm run build</div>
        <button class="btn btn-primary btn-sm" @click="reload">{{ t('build.recheck') }}</button>
      </div>
      <TopBar :title="pageTitle" />
      <main class="content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  margin-left: var(--sidebar-w);
}
.content {
  flex: 1;
  padding: 24px 28px 40px;
  max-width: 1120px;
  width: 100%;
  margin: 0 auto;
}
.build-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 16px;
  background: color-mix(in srgb, var(--warning) 15%, transparent);
  border-bottom: 1px solid var(--warning);
  color: var(--text);
  font-size: 13px;
}
.build-banner-text {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.build-banner-icon {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--warning);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  flex: none;
}
.build-banner-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 8px;
}
.build-banner .btn-sm { padding: 4px 10px; font-size: 12px; }
.login-root {
  min-height: 100vh;
}
@media (max-width: 820px) {
  .main { margin-left: 0; }
  .content { padding: 16px; }
}
</style>
