<script setup lang="ts">
defineProps<{
  label: string
  hint?: string
}>()
</script>

<template>
  <div class="setting-row">
    <div class="setting-info">
      <label class="setting-label">{{ label }}</label>
      <p v-if="hint" class="setting-hint">{{ hint }}</p>
    </div>
    <div class="setting-control">
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid rgba(var(--border-color-rgb, 224, 224, 224), 0.15);

  &:last-child {
    border-bottom: none;
  }
}

.setting-info {
  flex: 1;
  margin-right: 16px;
}

.setting-label {
  font-size: 13px;
  color: $text-primary;
  display: block;
}

.setting-hint {
  font-size: 12px;
  color: $text-muted;
  margin-top: 2px;
}

.setting-control {
  flex-shrink: 0;
}

@media (max-width: $breakpoint-mobile) {
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .setting-info {
    margin-right: 0;
  }

  .setting-control {
    width: 100%;
  }
}
</style>
