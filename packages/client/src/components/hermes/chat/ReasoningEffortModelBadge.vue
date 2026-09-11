<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { getModelReasoningPolicy } from '@/utils/reasoning-effort'

const props = defineProps<{
  provider?: string
  model?: string
}>()

const { t } = useI18n()

const title = computed(() => {
  const policy = getModelReasoningPolicy(props.provider, props.model)
  if (!policy) return ''

  const official = policy.official
    .map(level => t(`chat.reasoningEffort.options.${level}`))
    .join(' / ')
  const extensions = policy.extensions
    .map(level => t(`chat.reasoningEffort.options.${level}`))
    .join(' / ')

  return extensions
    ? t('chat.reasoningEffort.supportHintExtended', { official, extensions })
    : t('chat.reasoningEffort.supportHint', { official })
})
</script>

<template>
  <span
    v-if="title"
    data-testid="reasoning-effort-badge"
    class="reasoning-effort-badge"
    :title="title"
    :aria-label="title"
  >
    {{ t('chat.reasoningEffort.tooltip') }}
  </span>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.reasoning-effort-badge {
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, $accent-primary 35%, transparent);
  border-radius: 999px;
  padding: 1px 6px;
  color: $accent-primary;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.3;
  white-space: nowrap;
}
</style>
