<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const loading = ref(false);
const error = ref('');
const mustChange = ref(false);
const enabled = ref(false);

onMounted(async () => {
  try {
    const s = await api.adminStatus();
    enabled.value = !!s.enabled;
    // 未登录时服务端不返回用户名，避免泄露；仅已登录时回填
    if (s.username) username.value = s.username;
    if (!s.enabled || s.authenticated) {
      router.replace(typeof route.query.back === 'string' ? route.query.back : '/home');
    }
  } catch { /* 忽略状态加载失败 */ }
});

function back() {
  const back = typeof route.query.back === 'string' ? route.query.back : '/home';
  router.replace(back);
}

async function doLogin() {
  if (!password.value) { error.value = t('admin.login.passwordRequired'); return; }
  loading.value = true;
  error.value = '';
  try {
    const r = await api.adminLogin({ username: username.value, password: password.value });
    if (r.mustChange) {
      mustChange.value = true;
      currentPassword.value = password.value;
      password.value = '';
    } else {
      back();
    }
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function doChangePassword() {
  if (!newPassword.value || newPassword.value.length < 8) { error.value = t('admin.login.pwTooShort'); return; }
  if (!/[A-Za-z]/.test(newPassword.value) || !/[0-9]/.test(newPassword.value)) { error.value = t('admin.login.pwComplexity'); return; }
  if (newPassword.value !== confirmPassword.value) { error.value = t('admin.login.pwMismatch'); return; }
  loading.value = true;
  error.value = '';
  try {
    await api.adminChangePassword({ currentPassword: currentPassword.value, newPassword: newPassword.value });
    back();
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="card login-card">
      <div class="logo">¢</div>
      <h2>{{ mustChange ? t('admin.login.changeTitle') : t('admin.login.title') }}</h2>

      <template v-if="!mustChange">
        <div class="field">
          <label>{{ t('admin.login.username') }}</label>
          <input v-model="username" type="text" class="input" autocomplete="username" :placeholder="t('admin.login.usernamePlaceholder')" />
        </div>
        <div class="field">
          <label>{{ t('admin.login.password') }}</label>
          <input
            v-model="password"
            type="password"
            class="input"
            autocomplete="current-password"
            @keyup.enter="doLogin"
          />
        </div>
        <div v-if="error" class="form-error">{{ error }}</div>
        <button class="btn btn-primary btn-block" :disabled="loading" @click="doLogin">
          {{ loading ? t('common.loading') : t('admin.login.submit') }}
        </button>
      </template>

      <template v-else>
        <p class="hint">{{ t('admin.login.changeHint') }}</p>
        <div class="field">
          <label>{{ t('admin.login.newPassword') }}</label>
          <input v-model="newPassword" type="password" class="input" autocomplete="new-password" />
        </div>
        <div class="field">
          <label>{{ t('admin.login.confirmPassword') }}</label>
          <input v-model="confirmPassword" type="password" class="input" autocomplete="new-password" @keyup.enter="doChangePassword" />
        </div>
        <div v-if="error" class="form-error">{{ error }}</div>
        <button class="btn btn-primary btn-block" :disabled="loading" @click="doChangePassword">
          {{ loading ? t('common.loading') : t('common.save') }}
        </button>
      </template>
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
  background: var(--bg);
}
.login-card {
  width: 100%;
  max-width: 400px;
  text-align: left;
  padding: 36px 30px;
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
h2 { font-size: 19px; margin: 0 0 20px; font-weight: 650; text-align: center; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 13px; color: var(--text-2); margin-bottom: 6px; }
.input { width: 100%; }
.btn-block { width: 100%; margin-top: 6px; }
.form-error { color: var(--danger); font-size: 13px; margin: 10px 0; }
.hint { color: var(--text-2); font-size: 13px; margin: 0 0 16px; text-align: center; }
</style>
