<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  level: { type: String, default: 'info' },
  category: { type: String, default: '' },
});

const { t } = useI18n();

const levelTone = computed(() => ({
  debug: 'neutral',
  info: 'info',
  warn: 'warning',
  error: 'danger',
}[props.level] || 'neutral'));

const levelLabel = computed(() => t(`logs.level${props.level.charAt(0).toUpperCase() + props.level.slice(1)}`));
const catLabel = computed(() => {
  if (!props.category) return '';
  return t(`logs.cat${props.category.charAt(0).toUpperCase() + props.category.slice(1)}`);
});
</script>

<template>
  <span class="row">
    <span class="badge" :class="`badge-${levelTone}`">{{ levelLabel }}</span>
    <span v-if="category" class="badge badge-neutral">{{ catLabel }}</span>
  </span>
</template>

<style scoped>
.row { display: inline-flex; gap: 4px; align-items: center; }
</style>
