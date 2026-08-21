<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import Sidebar from '@/components/Sidebar.vue';
import TopBar from '@/components/TopBar.vue';

const route = useRoute();
const { t } = useI18n();

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
.login-root {
  min-height: 100vh;
}
@media (max-width: 820px) {
  .main { margin-left: 0; }
  .content { padding: 16px; }
}
</style>
