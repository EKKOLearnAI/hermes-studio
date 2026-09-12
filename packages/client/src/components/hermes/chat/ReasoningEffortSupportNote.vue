<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { getModelReasoningPolicy } from '@/utils/reasoning-effort'

const props = defineProps<{
  provider?: string
  model?: string
}>()

const { t } = useI18n()

const supportText = computed(() => {
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
  <small v-if="supportText" data-testid="reasoning-effort-support" class="reasoning-effort-support">
    {{ supportText }}
  </small>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.reasoning-effort-support {
  display: block;
  margin-top: 6px;
  color: $text-muted;
  font-size: 11px;
  line-height: 1.45;
}
</style>
