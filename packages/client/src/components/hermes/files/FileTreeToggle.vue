<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  collapsed: boolean
}>()

const emit = defineEmits<{
  (event: 'toggle'): void
}>()

const { t } = useI18n()
const label = computed(() => t(props.collapsed ? 'files.expandTree' : 'files.collapseTree'))
</script>

<template>
  <NTooltip trigger="hover">
    <template #trigger>
      <NButton
        class="file-tree-toggle"
        size="small"
        quaternary
        circle
        :aria-label="label"
        :aria-expanded="!props.collapsed"
        :title="label"
        @click="emit('toggle')"
      >
        <template #icon>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 5h14v14H5z" />
            <path d="M9 5v14" />
            <path :d="props.collapsed ? 'm12 9 3 3-3 3' : 'm15 9-3 3 3 3'" />
          </svg>
        </template>
      </NButton>
    </template>
    {{ label }}
  </NTooltip>
</template>

<style scoped lang="scss">
.file-tree-toggle {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;

  :deep(svg) {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  &:dir(rtl) :deep(svg) {
    transform: scaleX(-1);
  }
}
</style>
