import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', redirect: '/home' },
  { path: '/home', name: 'overview', component: () => import('@/views/OverviewView.vue'), meta: { title: 'overview' } },
  { path: '/models', name: 'models', component: () => import('@/views/ModelsView.vue'), meta: { title: 'models' } },
  { path: '/logs', name: 'logs', component: () => import('@/views/LogsView.vue'), meta: { title: 'logs' } },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue'), meta: { title: 'settings' } },
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { title: 'login' } },
  { path: '/:pathMatch(.*)*', redirect: '/home' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
