<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '@/api';

const { t } = useI18n();
const router = useRouter();

const statusText = ref('');
const hintText = ref('');
const authUrl = ref('');
const error = ref(false);
const succeeded = ref(false);
let pollTimer = null;
let state = '';

async function start() {
  try {
    const d = await api.loginState();
    state = d.state;
    authUrl.value = d.authUrl;
    statusText.value = t('login.openHint');
    hintText.value = t('login.waitingHint');
    window.open(d.authUrl, '_blank');
    pollTimer = setInterval(poll, 2000);
  } catch (e) {
    error.value = true;
    statusText.value = `${t('login.failed')}: ${e.message}`;
  }
}

async function poll() {
  try {
    const sd = await api.loginStatus(state);
    if (sd.status === 'success') {
      clearInterval(pollTimer);
      succeeded.value = true;
      authUrl.value = '';
      hintText.value = '';
      statusText.value = t('login.success');
      setTimeout(() => router.replace('/home'), 700);
    } else if (sd.status === 'error' || sd.status === 'timeout') {
      clearInterval(pollTimer);
      error.value = true;
      statusText.value = `${t('login.failed')}: ${sd.error || t('login.timeout')}`;
    } else {
      statusText.value = t('login.waiting');
      hintText.value = t('login.waitingHint');
    }
  } catch (e) {
    statusText.value = `${t('login.queryError')}: ${e.message}`;
  }
}

onMounted(start);
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<template>
  <div class="login-wrap">
    <div class="card login-card">
      <div class="logo">¢</div>
      <h2>{{ t('login.title') }}</h2>
      <div class="spinner" v-if="!error && !succeeded"></div>
      <div class="status" :class="{ ok: succeeded, bad: error }">{{ statusText || t('login.getting') }}</div>
      <p v-if="hintText && !error && !succeeded" class="hint">{{ hintText }}</p>
      <a v-if="authUrl && !succeeded" class="manual" :href="authUrl" target="_blank" rel="noreferrer">
        {{ t('login.openManually') }}
      </a>
      <router-link to="/home" class="back">{{ t('login.backHome') }}</router-link>
    </div>
  </div>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.login-card {
  width: 100%;
  max-width: 440px;
  text-align: center;
  padding: 40px 30px;
  box-shadow: var(--shadow);
}
.logo {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  font-weight: 700;
  margin: 0 auto 16px;
}
h2 { font-size: 19px; margin: 0 0 16px; font-weight: 650; }
.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  margin: 20px auto;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.status { font-size: 14px; color: var(--text-2); line-height: 1.7; min-height: 42px; }
.status.ok { color: var(--success); font-weight: 600; }
.status.bad { color: var(--danger); }
.manual { display: inline-block; margin-top: 4px; font-size: 13px; }
.back {
  display: inline-block;
  margin-top: 18px;
  padding: 8px 18px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
}
.back:hover { text-decoration: none; background: var(--surface-3); }
</style>
