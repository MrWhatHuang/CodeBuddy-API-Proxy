<script setup>
import { computed } from 'vue';

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
});

const paths = {
  overview: 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z',
  models: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 2.2L6 8.5v7l6 3.3 6-3.3v-7L12 5.2zM12 12l6-3.3M12 12v7.3M12 12L6 8.7',
  accounts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  logs: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm2 4h10M7 12h10M7 16h6',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a7.8 7.8 0 0 0 .1-2l2-1.5-2-3.4-2.4 1a7.7 7.7 0 0 0-1.7-1L13 4h-2l-.4 2.1a7.7 7.7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.8 7.8 0 0 0 .1 2l-2 1.5 2 3.4 2.4-1a7.7 7.7 0 0 0 1.7 1L11 20h2l.4-2.1a7.7 7.7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5z',
  apikeys: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-2.8-2.8L17.5 2l4.5 4.5-2 2-2.5 1-1.5 1.5-2.1 2.1z',
  usage: 'M4 20h16M6 20V10m4 10V4m4 16V8m4 12v-6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M17 14.5A6.5 6.5 0 0 1 9.5 7 7 7 0 1 0 17 14.5z',
  monitor: 'M4 5h16v10H4V5zm3 14h10M12 15v4',
  copy: 'M8 8h10v12H8V8zm-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v0',
  user: 'M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z',
  server: 'M4 5h16v5H4V5zm0 9h16v5H4v-5zM7 7.5h.01M7 16.5h.01',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm10 3l-4.3-4.3',
  trash: 'M5 7h14M9 7V5h6v2m-8 0l1 12h8l1-12',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v6h-6',
  check: 'M5 12l5 5L20 7',
  chevron: 'M8 10l4 4 4-4',
  spark: 'M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3z',
};

const d = computed(() => paths[props.name] || paths.spark);
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="d" />
  </svg>
</template>

<style scoped>
.icon { display: block; flex: none; }
</style>