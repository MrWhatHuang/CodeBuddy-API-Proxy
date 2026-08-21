<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRequest } from 'alova/client';
import { api } from '@/api';

const { t } = useI18n();

const { data: status, loading } = useRequest(() => api.status());

const models = computed(() => status.value?.models || []);
</script>

<template>
  <div class="card">
    <h2 class="card-title">
      {{ t('models.title') }}
      <span class="sub">{{ t('overview.modelCount', { count: models.length }) }}</span>
    </h2>

    <div v-if="loading" class="muted">{{ t('common.loading') }}</div>
    <div v-else-if="!models.length" class="empty"><span class="icon">◈</span>{{ t('common.empty') }}</div>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('models.colId') }}</th>
            <th>{{ t('models.colName') }}</th>
            <th>{{ t('models.colCtx') }}</th>
            <th>{{ t('models.colOutput') }}</th>
            <th>{{ t('models.colCapabilities') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in models" :key="m.id">
            <td>
              <code>{{ m.id }}</code>
              <span v-if="m.isDefault" class="badge badge-primary">{{ t('models.default') }}</span>
              <span class="badge" :class="m.region === 'intl' ? 'badge-warning' : 'badge-neutral'">
                {{ m.region === 'intl' ? t('models.intl') : t('models.cn') }}
              </span>
            </td>
            <td>{{ m.name }}</td>
            <td class="mono muted">{{ Math.round(m.maxInputTokens / 1000) }}k</td>
            <td class="mono muted">{{ Math.round(m.maxOutputTokens / 1000) }}k</td>
            <td>
              <span v-if="m.tools" class="tag">{{ t('models.tool') }}</span>
              <span v-if="m.vision" class="tag">{{ t('models.vision') }}</span>
              <span v-if="!m.tools && !m.vision" class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.table-wrap { overflow-x: auto; }
.tag {
  font-size: 11px;
  color: var(--text-2);
  border: 1px solid var(--border-strong);
  padding: 1px 7px;
  border-radius: 6px;
  margin-right: 4px;
  background: var(--surface-2);
}
.badge { margin-left: 4px; }
</style>
