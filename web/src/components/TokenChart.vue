<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  days: { type: Array, default: () => [] },
  series: { type: Array, default: () => [] },
});

const { t } = useI18n();

const palette = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#84cc16'];

const colorAt = (i) => palette[i % palette.length];

function totalOf(points) {
  let s = 0;
  if (points) for (const k in points) s += points[k];
  return s;
}

const W = 760;
const H = 260;
const PAD_L = 46;
const PAD_B = 30;
const PAD_T = 14;
const PAD_R = 12;

const plotW = W - PAD_L - PAD_R;
const plotH = H - PAD_T - PAD_B;

const totals = computed(() => {
  if (!props.days.length) return [];
  return props.days.map((day) => {
    let sum = 0;
    for (const s of props.series) sum += s.points[day] || 0;
    return { day, sum };
  });
});

const maxTotal = computed(() => {
  let m = 0;
  for (const tt of totals.value) if (tt.sum > m) m = tt.sum;
  return m || 1;
});

const yTicks = computed(() => {
  const ticks = [];
  const step = niceStep(maxTotal.value / 4);
  if (!step) return [{ v: 0, y: plotH }];
  for (let v = 0; v <= maxTotal.value; v += step) {
    ticks.push({ v, y: PAD_T + plotH - (v / maxTotal.value) * plotH });
  }
  return ticks;
});

function niceStep(raw) {
  if (!raw || raw <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}

const barGap = 6;
const nDays = props.days.length || 1;
const slot = plotW / nDays;
const barW = Math.max(2, Math.min(26, slot - barGap));

// 返回每个系列在该天的分段：{ v, h, y, cachedV, cachedH, cachedY }
// 每个系列按 total 堆叠，其中 cached 部分用浅色/斜纹标出（位于该段底部）
function barSegments(day, series) {
  const segs = [];
  let acc = 0;
  const dayTotal = maxTotal.value;
  for (const s of series) {
    const v = s.points[day] || 0;
    const cachedV = s.cached && s.cached[day] ? Math.min(s.cached[day], v) : 0;
    const h = (v / dayTotal) * plotH;
    const y = PAD_T + plotH - acc - h;
    const cachedH = (cachedV / dayTotal) * plotH;
    segs.push({ v, h, y, cachedV, cachedH, cachedY: y + h - cachedH });
    acc += h;
  }
  return segs;
}

function fmt(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function shortDay(day) {
  const parts = String(day).split('-');
  if (parts.length === 3) return `${parts[1]}/${parts[2]}`;
  return day;
}
</script>

<template>
  <div class="chart">
    <svg :viewBox="`0 0 ${W} ${H}`" class="chart-svg">
      <!-- 网格线与 Y 轴刻度 -->
      <g v-for="tk in yTicks" :key="tk.v">
        <line :x1="PAD_L" :x2="W - PAD_R" :y1="tk.y" :y2="tk.y" class="grid-line" />
        <text :x="PAD_L - 8" :y="tk.y + 4" class="axis-label" text-anchor="end">{{ fmt(tk.v) }}</text>
      </g>

      <!-- 柱状条（堆叠，含缓存命中浅色段） -->
      <g v-for="(tt, i) in totals" :key="tt.day">
        <g v-for="(seg, si) in barSegments(tt.day, series)" :key="si">
          <!-- 缓存命中部分：斜纹/浅色 -->
          <rect
            v-if="seg.cachedV > 0"
            :x="PAD_L + i * slot + (slot - barW) / 2"
            :y="seg.cachedY"
            :width="barW"
            :height="seg.cachedH"
            :fill="colorAt(si)"
            fill-opacity="0.28"
            rx="2"
            class="cached-seg"
          >
            <title>{{ series[si].name }} · {{ tt.day }}: 缓存命中 {{ fmt(seg.cachedV) }} Token</title>
          </rect>
          <!-- 非缓存主体 -->
          <rect
            v-if="seg.v > 0"
            :x="PAD_L + i * slot + (slot - barW) / 2"
            :y="seg.y"
            :width="barW"
            :height="seg.h"
            :fill="colorAt(si)"
            fill-opacity="0.75"
            rx="2"
          >
            <title>{{ series[si].name }} · {{ tt.day }}: {{ fmt(seg.v) }} Token（含缓存 {{ fmt(seg.cachedV) }}）</title>
          </rect>
        </g>
        <text
          :x="PAD_L + i * slot + slot / 2"
          :y="H - PAD_B + 16"
          class="axis-label"
          text-anchor="middle"
        >{{ shortDay(tt.day) }}</text>
      </g>
    </svg>

    <!-- 图例 -->
    <div class="legend" v-if="series.length">
      <div class="legend-item" v-for="(s, i) in series" :key="s.id">
        <span class="swatch" :style="{ background: colorAt(i) }"></span>
        <span class="legend-name">{{ s.name }}</span>
        <span class="legend-total">{{ fmt(totalOf(s.points)) }}</span>
      </div>
      <div class="legend-divider"></div>
      <div class="legend-item">
        <span class="swatch swatch-cached"></span>
        <span class="legend-name">{{ t('overview.chartCached') }}</span>
      </div>
    </div>
    <div v-else class="empty-mini">{{ t('usage.empty') }}</div>
  </div>
</template>

<style scoped>
.chart { position: relative; }
.chart-svg { width: 100%; height: auto; display: block; }
.grid-line { stroke: var(--border); stroke-width: 1; }
.axis-label { font-size: 10px; fill: var(--text-3); }
.legend { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 12px; }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.legend-divider { width: 1px; align-self: stretch; background: var(--border); margin: 0 4px; }
.swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
.swatch-cached { background: var(--primary); opacity: 0.28; }
.cached-seg { stroke: var(--border-strong); stroke-width: 0.5; }
.legend-name { color: var(--text); font-weight: 500; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legend-total { color: var(--text-2); font-size: 11px; }
.empty-mini { color: var(--text-3); text-align: center; padding: 30px 0; font-size: 13px; }
</style>
