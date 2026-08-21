<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  value: { type: String, default: '' },
  mono: { type: Boolean, default: true },
});

const { t } = useI18n();
const copied = ref(false);

async function copy() {
  try {
    await navigator.clipboard.writeText(props.value);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = props.value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
  <div class="copy-field">
    <code :class="{ mono }">{{ value }}</code>
    <button class="copy-btn" :class="{ copied }" @click="copy">
      {{ copied ? t('common.copied') : t('common.copy') }}
    </button>
  </div>
</template>

<style scoped>
.copy-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
code {
  flex: 1;
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  overflow: auto;
  white-space: nowrap;
  color: var(--text);
}
.copy-btn {
  flex: none;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  transition: all 0.15s ease;
}
.copy-btn:hover { background: var(--surface-2); color: var(--text); }
.copy-btn.copied { background: var(--success); color: #fff; border-color: var(--success); }
</style>
