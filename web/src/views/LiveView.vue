<script setup>
/**
 * 实时数据：独立菜单页。
 * 面板本身（开始监测 + 中间完整请求 body + JSON 美化）复用 LiveDataPanel 组件，
 * 这里只负责把 i18n 文案传进去。
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import LiveDataPanel from '@/components/LiveDataPanel.vue';

const { t } = useI18n();

// 组件内部用到的全部文案键（键名与 i18n 的 live 块一致）
const LIVE_LABEL_KEYS = [
  'waiting', 'connected', 'connecting', 'stopped', 'disconnected',
  'empty', 'body', 'headers', 'response', 'pretty', 'raw',
  'truncated', 'parseError', 'clear', 'clearConfirm', 'count', 'bytes', 'events',
  'copy', 'copied', 'autoScroll', 'pause', 'resume', 'expand', 'collapse',
  'showHeaders', 'hideHeaders', 'latest', 'noSelection', 'noBody', 'error',
];

const liveLabels = computed(() => {
  const out = {};
  for (const key of LIVE_LABEL_KEYS) out[key] = t(`live.${key}`);
  return out;
});
</script>

<template>
  <div>
    <div class="live-intro">
      <h2 class="live-page-title">{{ t('live.title') }}</h2>
      <p class="hint live-page-desc">{{ t('live.desc') }}</p>
    </div>

    <LiveDataPanel
      :title="t('live.title')"
      :start-label="t('live.start')"
      :stop-label="t('live.stop')"
      :labels="liveLabels"
    />

    <p class="hint live-footnote">{{ t('live.liveHint') }}</p>
  </div>
</template>

<style scoped>
.live-intro { margin-bottom: 16px; }
.live-page-title {
  font-size: 18px;
  font-weight: 650;
  margin: 0 0 4px;
}
.live-page-desc { margin: 0; }
.live-footnote { margin: 12px 2px 0; }
</style>
