<script setup>
defineProps({
  label: { type: String, default: '' },
  value: { type: [String, Number], default: '' },
  tone: { type: String, default: 'primary' }, // primary | success | danger | warning | info
});
</script>

<template>
  <div class="stat-card">
    <div class="label">{{ label }}</div>
    <div class="value" :class="`tone-${tone}`">{{ value }}</div>
  </div>
</template>

<style scoped>
.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  box-shadow: var(--shadow-sm);
}
.label {
  font-size: 12px;
  color: var(--text-2);
  font-weight: 500;
  margin-bottom: 6px;
}
.value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;
}
.tone-primary { color: var(--primary); }
.tone-success { color: var(--success); }
.tone-danger { color: var(--danger); }
.tone-warning { color: var(--warning); }
.tone-info { color: var(--info); }
</style>
