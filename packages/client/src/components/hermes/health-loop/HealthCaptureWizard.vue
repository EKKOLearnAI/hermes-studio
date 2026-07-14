<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(defineProps<{
  requirements?: string[]
  extractedValues?: Record<string, string | number>
  processors?: string[]
  busy?: boolean
}>(), { requirements: () => [], extractedValues: () => ({}), processors: () => [], busy: false })
const emit = defineEmits<{
  submit: [payload: { file: File; sourceId: string; processorId: string; extractedValues: Record<string, string | number> }]
}>()
const { t } = useI18n()
const file = ref<File | null>(null)
const sourceId = ref('manual-capture')
const processorId = ref(props.processors[0] ?? '')
const canSubmit = computed(() => Boolean(file.value && processorId.value && !props.busy))

watch(() => props.processors, processors => {
  if (!processors.includes(processorId.value)) processorId.value = processors[0] ?? ''
})

function selectFile(event: Event) {
  const input = event.target as HTMLInputElement
  file.value = input.files?.[0] ?? null
}

function submit() {
  if (!file.value || !canSubmit.value) return
  emit('submit', { file: file.value, sourceId: sourceId.value, processorId: processorId.value, extractedValues: props.extractedValues })
}
</script>

<template>
  <section class="loop-panel capture" data-test="health-capture-wizard" aria-labelledby="health-capture-title">
    <div class="heading">
      <h3 id="health-capture-title">{{ t('health.loop.capture.title') }}</h3>
      <span>{{ t('health.loop.capture.localFirst') }}</span>
    </div>
    <ol class="requirements">
      <li v-for="requirement in requirements" :key="requirement" data-test="capture-requirement">
        {{ t(requirement) }}
      </li>
    </ol>
    <label>
      <span>{{ t('health.loop.capture.fileLabel') }}</span>
      <input
        type="file"
        data-test="capture-file-input"
        :aria-label="t('health.loop.capture.fileLabel')"
        accept=".json,.csv,.txt,.pdf,image/*"
        @change="selectFile"
      >
    </label>
    <label>
      <span>{{ t('health.loop.capture.processorLabel') }}</span>
      <select v-model="processorId" data-test="capture-processor">
        <option value="" disabled>{{ t('health.loop.capture.selectProcessor') }}</option>
        <option v-for="processor in processors" :key="processor" :value="processor">{{ processor }}</option>
      </select>
    </label>
    <div class="review" data-test="extracted-value-review">
      <strong>{{ t('health.loop.capture.extractedValues') }}</strong>
      <dl v-if="Object.keys(extractedValues).length">
        <template v-for="(value, key) in extractedValues" :key="key">
          <dt>{{ key }}</dt><dd>{{ value }}</dd>
        </template>
      </dl>
      <p v-else>{{ t('health.loop.capture.noExtractedValues') }}</p>
    </div>
    <button type="button" data-test="capture-submit" :disabled="!canSubmit" @click="submit">
      {{ busy ? t('health.loop.capture.uploading') : t('health.loop.capture.continue') }}
    </button>
  </section>
</template>

<style scoped lang="scss">
.loop-panel { min-width: 0; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-color); padding: 16px; }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h3 { margin: 0; font-size: 18px; }
.heading span, label > span, .review p { color: var(--text-color-3); font-size: 12px; }
.capture, label { display: grid; gap: 10px; }
.requirements { display: grid; gap: 5px; margin: 2px 0; padding-left: 20px; color: var(--text-color-2); font-size: 13px; }
input, select { min-width: 0; border: 1px solid var(--border-color); border-radius: 8px; background: transparent; color: var(--text-color); padding: 8px; }
.review { border: 1px solid var(--border-color); border-radius: 8px; padding: 10px; }
dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px 12px; margin: 8px 0 0; }
dt { color: var(--text-color-2); }
dd { margin: 0; font-weight: 600; }
button { border: 0; border-radius: 8px; background: var(--primary-color); color: white; cursor: pointer; font: inherit; padding: 9px 12px; }
button:disabled { cursor: not-allowed; opacity: .5; }
</style>
