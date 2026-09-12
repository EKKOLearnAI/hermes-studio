<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue'
import { NAlert, NButton, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { listDshSessionPresets, type DshSessionPreset } from '@/api/coding-agents/dsh'

const selected = defineModel<string>()
const emit = defineEmits<{ valid: [value: boolean] }>()
const inputId = useId()
const props = defineProps<{ disabled?: boolean }>()
const { t } = useI18n()
const presets = ref<DshSessionPreset[]>([])
const loading = ref(true)
const failed = ref(false)
const current = computed(() => presets.value.find(preset => preset.id === selected.value))
watch([loading, failed, current], () => emit('valid', !loading.value && !failed.value && !!current.value && !current.value.unavailable), { immediate: true })
const options = computed(() => presets.value.map(preset => ({
  value: preset.id,
  label: `${preset.name || preset.id}${preset.isDefault ? ` (${t('dshPresets.default')})` : ''}`,
  disabled: preset.unavailable,
})))
async function load() {
  loading.value = true
  failed.value = false
  try {
    presets.value = (await listDshSessionPresets()).presets
    if (!selected.value) selected.value = presets.value.find(preset => preset.isDefault && !preset.unavailable)?.id
  } catch { failed.value = true }
  finally { loading.value = false }
}
onMounted(load)
</script>

<template>
  <div class="preset-field" data-testid="dsh-session-preset">
    <label class="preset-label" :for="inputId">{{ t('dshPresets.sessionMode') }}</label>
    <NSelect :input-props="{ id: inputId, 'aria-label': t('dshPresets.sessionMode') }" :value="selected" :options="options" :loading="loading"
      :disabled="props.disabled || loading || failed" :placeholder="t('dshPresets.selectMode')"
      @update:value="selected = $event" />
    <p v-if="current?.description" class="description">{{ current.description }}</p>
    <p class="hint">{{ t('dshPresets.sessionHint') }}</p>
    <NAlert v-if="failed" type="error" :show-icon="false">
      {{ t('dshPresets.unavailable') }}
      <NButton size="small" :disabled="props.disabled" @click="load">{{ t('common.retry') }}</NButton>
    </NAlert>
    <p v-else-if="!loading && !presets.some(preset => !preset.unavailable)" class="hint">{{ t('dshPresets.empty') }}</p>
  </div>
</template>

<style scoped lang="scss">
.preset-field { display: flex; flex-direction: column; gap: 8px; }
.preset-label { font-size: 12px; color: var(--text-secondary); }
.description, .hint { margin: 0; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.hint { color: var(--text-secondary); }
</style>
