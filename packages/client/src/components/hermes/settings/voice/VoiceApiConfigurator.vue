<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NDrawer, NDrawerContent, NForm, NFormItem, NInput, NSelect, NSlider, NButton, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { VoiceApiConnection, VoiceApiSavePayload } from '@/types/voice-api'
import { VOICE_API_PRESETS } from '@/constants/voiceApiPresets'
import { speedToEdgeRate, hzToEdgePitch } from '@/utils/ttsHelpers'

const props = defineProps<{
  connection: VoiceApiConnection | null
  show: boolean
}>()

const emit = defineEmits<{
  close: []
  save: [connection: VoiceApiConnection, payload: VoiceApiSavePayload]
}>()

const { t } = useI18n()

const loading = ref(false)
const formData = ref<Record<string, string | number | undefined>>({})
const apiKeyInput = ref('')

const preset = computed(() =>
  props.connection ? VOICE_API_PRESETS.find(p => p.kind === props.connection!.kind && p.provider === props.connection!.provider && (p.baseUrl === props.connection!.baseUrl || !p.baseUrl)) : null
)

const capabilities = computed(() => preset.value?.capabilities || {})

function setField(key: string, value: string | number | null | undefined) {
  formData.value[key] = value ?? ''
}

function stringField(key: string): string {
  const value = formData.value[key]
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function numberField(key: string, fallback = 0): number {
  const value = formData.value[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

watch(() => props.connection, (conn) => {
  if (conn) {
    formData.value = {
      ...conn.settings,
      model: conn.model || String(conn.settings.model || ''),
      voice: conn.voice || String(conn.settings.voice || ''),
    }
    if (conn.provider === 'edge') {
      formData.value.rate = numberField('rate', 1.0)
      formData.value.pitch = numberField('pitch', 0)
    }
    apiKeyInput.value = ''
  }
}, { immediate: true })

async function handleSave() {
  if (!props.connection) return

  loading.value = true
  try {
    const apiKey = apiKeyInput.value.trim()
    emit('save', props.connection, {
      settings: { ...formData.value },
      ...(apiKey ? { secrets: { apiKey } } : {}),
    })
  } finally {
    loading.value = false
  }
}

const edgeVoiceOptions = [
  { label: '晓晓 (zh-CN-XiaoxiaoNeural)', value: 'zh-CN-XiaoxiaoNeural' },
  { label: '晓萱 (zh-CN-XiaoxuanNeural)', value: 'zh-CN-XiaoxuanNeural' },
  { label: '云希 (zh-CN-YunxiNeural)', value: 'zh-CN-YunxiNeural' },
  { label: '云健 (zh-CN-YunjianNeural)', value: 'zh-CN-YunjianNeural' },
  { label: '云扬 (zh-CN-YunyangNeural)', value: 'zh-CN-YunyangNeural' },
  { label: 'Jenny (en-US-JennyNeural)', value: 'en-US-JennyNeural' },
  { label: 'Aria (en-US-AriaNeural)', value: 'en-US-AriaNeural' },
  { label: 'Guy (en-US-GuyNeural)', value: 'en-US-GuyNeural' },
]

const openaiVoiceOptions = [
  { label: 'Alloy', value: 'alloy' },
  { label: 'Echo', value: 'echo' },
  { label: 'Fable', value: 'fable' },
  { label: 'Nova', value: 'nova' },
  { label: 'Onyx', value: 'onyx' },
  { label: 'Shimmer', value: 'shimmer' },
]

const mimoVoiceOptions = [
  { label: '冰糖 (中文·女)', value: '冰糖' },
  { label: '茉莉 (中文·女)', value: '茉莉' },
  { label: '苏打 (中文·男)', value: '苏打' },
  { label: '白桦 (中文·男)', value: '白桦' },
]

const mimoModelOptions = [
  { label: t('settings.voice.mimoModelPreset'), value: 'mimo-v2.5-tts' },
  { label: t('settings.voice.mimoModelVoiceDesign'), value: 'mimo-v2.5-tts-voicedesign' },
  { label: t('settings.voice.mimoModelVoiceClone'), value: 'mimo-v2.5-tts-voiceclone' },
]
</script>

<template>
  <NDrawer :show="show" :width="400" @update:show="emit('close')">
    <NDrawerContent :title="connection?.label" closable>
      <NForm label-placement="top" v-if="connection">
        <NFormItem v-if="!connection.isBuiltin" :label="t('settings.voice.apiKey')">
          <NInput
            v-model:value="apiKeyInput"
            type="password"
            show-password-on="click"
            autocomplete="off"
            :placeholder="connection.hasSecret ? t('settings.voice.keepStoredKeyPlaceholder') : t('settings.voice.apiKeyPlaceholder')"
          />
        </NFormItem>

        <NFormItem :label="t('settings.voice.model')" v-if="capabilities.models">
          <NSelect
            v-if="connection.provider === 'mimo'"
            :value="stringField('model')"
            :options="mimoModelOptions"
            @update:value="value => setField('model', value)"
          />
          <NInput
            v-else
            :value="stringField('model')"
            :placeholder="t('models.selectOrInput')"
            @update:value="value => setField('model', value)"
          />
        </NFormItem>

        <NFormItem :label="t('settings.voice.voice')" v-if="capabilities.voices">
          <NSelect
            v-if="connection.provider === 'edge'"
            :value="stringField('voice')"
            :options="edgeVoiceOptions"
            filterable
            @update:value="value => setField('voice', value)"
          />
          <NSelect
            v-else-if="connection.provider === 'openai'"
            :value="stringField('voice')"
            :options="openaiVoiceOptions"
            @update:value="value => setField('voice', value)"
          />
          <NSelect
            v-else-if="connection.provider === 'mimo' && stringField('model') === 'mimo-v2.5-tts'"
            :value="stringField('voice')"
            :options="mimoVoiceOptions"
            @update:value="value => setField('voice', value)"
          />
          <NInput
            v-else
            :value="stringField('voice')"
            @update:value="value => setField('voice', value)"
          />
        </NFormItem>

        <template v-if="connection.provider === 'edge'">
          <NFormItem :label="t('settings.voice.edgeRate')">
            <NSpace vertical style="width: 100%">
              <NSlider
                :value="numberField('rate', 1)"
                :min="0.5"
                :max="2.0"
                :step="0.05"
                @update:value="value => setField('rate', Array.isArray(value) ? value[0] : value)"
              />
              <span style="font-size: 12px; opacity: 0.6">{{ numberField('rate', 1).toFixed(2) }}x ({{ speedToEdgeRate(numberField('rate', 1)) }})</span>
            </NSpace>
          </NFormItem>
          <NFormItem :label="t('settings.voice.edgePitch')">
            <NSpace vertical style="width: 100%">
              <NSlider
                :value="numberField('pitch', 0)"
                :min="-20"
                :max="20"
                :step="1"
                @update:value="value => setField('pitch', Array.isArray(value) ? value[0] : value)"
              />
              <span style="font-size: 12px; opacity: 0.6">{{ numberField('pitch', 0) > 0 ? '+' : '' }}{{ numberField('pitch', 0) }} Hz ({{ hzToEdgePitch(numberField('pitch', 0)) }})</span>
            </NSpace>
          </NFormItem>
        </template>

        <template v-if="connection.provider === 'mimo'">
          <NFormItem :label="t('settings.voice.mimoStylePrompt')" v-if="capabilities.stylePrompt">
            <NInput :value="stringField('stylePrompt')" type="textarea" :rows="2" @update:value="value => setField('stylePrompt', value)" />
          </NFormItem>
          <NFormItem :label="t('settings.voice.mimoVoiceDesignPrompt')" v-if="stringField('model') === 'mimo-v2.5-tts-voicedesign'">
            <NInput :value="stringField('voiceDesignDesc')" type="textarea" :rows="3" @update:value="value => setField('voiceDesignDesc', value)" />
          </NFormItem>
        </template>

        <template v-if="connection.kind === 'stt' && connection.provider !== 'browser'">
          <NFormItem :label="t('settings.voice.sttLanguage')">
            <NInput :value="stringField('language')" @update:value="value => setField('language', value)" />
          </NFormItem>
          <NFormItem :label="t('settings.voice.sttPrompt')">
            <NInput :value="stringField('prompt')" type="textarea" :rows="2" @update:value="value => setField('prompt', value)" />
          </NFormItem>
        </template>
      </NForm>

      <template #footer>
        <NSpace justify="end">
          <NButton @click="emit('close')">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="loading" @click="handleSave">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>
