<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NSelect, NInput, NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { useSpeech } from '@/composables/useSpeech'
import SettingRow from './SettingRow.vue'

const { t } = useI18n()
const vs = useVoiceSettings()
const speech = useSpeech()

const testText = ref(t('settings.voice.testTextDefault'))
const testPlaying = ref(false)

const providerOptions = [
  { label: t('settings.voice.providerWebSpeech'), value: 'webspeech' },
  { label: t('settings.voice.providerOpenai'), value: 'openai' },
  { label: t('settings.voice.providerCustom'), value: 'custom' },
  { label: t('settings.voice.providerEdge'), value: 'edge' },
]

const openaiModelOptions = [
  { label: 'tts-1', value: 'tts-1' },
  { label: 'tts-1-hd', value: 'tts-1-hd' },
]

const openaiVoiceOptions = [
  { label: 'Alloy', value: 'alloy' },
  { label: 'Echo', value: 'echo' },
  { label: 'Fable', value: 'fable' },
  { label: 'Nova', value: 'nova' },
  { label: 'Onyx', value: 'onyx' },
  { label: 'Shimmer', value: 'shimmer' },
]

const edgeVoiceOptions = [
  { label: '晓晓 (zh-CN-XiaoxiaoNeural)', value: 'zh-CN-XiaoxiaoNeural' },
  { label: '晓萱 (zh-CN-XiaoxuanNeural)', value: 'zh-CN-XiaoxuanNeural' },
  { label: '云希 (zh-CN-YunxiNeural)', value: 'zh-CN-YunxiNeural' },
  { label: '云健 (zh-CN-YunjianNeural)', value: 'zh-CN-YunjianNeural' },
  { label: '云扬 (zh-CN-YunyangNeural)', value: 'zh-CN-YunyangNeural' },
  { label: 'Jenny (en-US-JennyNeural)', value: 'en-US-JennyNeural' },
  { label: 'Aria (en-US-AriaNeural)', value: 'en-US-AriaNeural' },
  { label: 'Guy (en-US-GuyNeural)', value: 'en-US-GuyNeural' },
  { label: 'Sonia (en-GB-SoniaNeural)', value: 'en-GB-SoniaNeural' },
  { label: 'Ryan (en-GB-RyanNeural)', value: 'en-GB-RyanNeural' },
  { label: 'Nanami (ja-JP-NanamiNeural)', value: 'ja-JP-NanamiNeural' },
  { label: 'Keita (ja-JP-KeitaNeural)', value: 'ja-JP-KeitaNeural' },
  { label: 'Sun-Hi (ko-KR-SunHiNeural)', value: 'ko-KR-SunHiNeural' },
  { label: 'InJoon (ko-KR-InJoonNeural)', value: 'ko-KR-InJoonNeural' },
  { label: 'Denise (fr-FR-DeniseNeural)', value: 'fr-FR-DeniseNeural' },
  { label: 'Henri (fr-FR-HenriNeural)', value: 'fr-FR-HenriNeural' },
  { label: 'Katja (de-DE-KatjaNeural)', value: 'de-DE-KatjaNeural' },
  { label: 'Conrad (de-DE-ConradNeural)', value: 'de-DE-ConradNeural' },
]

// Get WebSpeech voices list on mount
const webspeechVoices = ref<SpeechSynthesisVoice[]>([])
onMounted(() => {
  if ('speechSynthesis' in window) {
    const voices = window.speechSynthesis.getVoices()
    if (voices.length) {
      webspeechVoices.value = voices
    }
    window.speechSynthesis.onvoiceschanged = () => {
      webspeechVoices.value = window.speechSynthesis.getVoices()
    }
  }
})

async function handleTest() {
  const text = testText.value.trim()
  if (!text) return
  testPlaying.value = true
  try {
    if (vs.provider.value === 'webspeech') {
      speech.stop(false)
      speech.speakViaBrowser('__test__', text, {
        voiceName: vs.webspeechVoice.value || undefined,
      })
    } else if (vs.provider.value === 'openai') {
      if (!vs.openaiBaseUrl.value) {
        console.warn('[VoiceSettings] OpenAI base URL empty')
        return
      }
      await speech.openaiPlay('__test__', text, {
        baseUrl: vs.openaiBaseUrl.value,
        apiKey: vs.openaiApiKey.value || undefined,
        model: vs.openaiModel.value,
        voice: vs.openaiVoice.value,
      })
    } else if (vs.provider.value === 'custom') {
      if (!vs.customUrl.value) {
        console.warn('[VoiceSettings] Custom URL empty')
        return
      }
      await speech.openaiPlay('__test__', text, {
        baseUrl: vs.customUrl.value,
        apiKey: vs.customApiKey.value || undefined,
      })
    } else if (vs.provider.value === 'edge') {
      await speech.openaiPlay('__test__', text, {
        baseUrl: '/api/tts/proxy',
        voice: vs.edgeVoice.value,
      })
    }
  } catch (err) {
    console.error('[VoiceSettings] Test failed:', err)
  } finally {
    testPlaying.value = false
  }
}
</script>

<template>
  <div class="voice-settings">
    <SettingRow
      :label="t('settings.voice.ttsProvider')"
      :hint="t('settings.voice.ttsProviderHint')"
    >
      <NSelect
        :value="vs.provider.value"
        :options="providerOptions"
        size="small"
        style="width: 300px"
        @update:value="vs.setProvider"
      />
    </SettingRow>

    <!-- ════ WebSpeech API ════ -->
    <template v-if="vs.provider.value === 'webspeech'">
      <SettingRow
        :label="t('settings.voice.webspeechVoice')"
        :hint="t('settings.voice.webspeechVoiceHint')"
      >
        <NSelect
          :value="vs.webspeechVoice.value"
          size="small"
          filterable
          style="width: 320px"
          :placeholder="t('settings.voice.webspeechVoicePlaceholder')"
          :consistent-menu-width="false"
          :options="webspeechVoices.map(v => ({
            label: `${v.name} (${v.lang})`,
            value: v.name,
          }))"
          @update:value="vs.setWebSpeechVoice"
        />
      </SettingRow>

    </template>

    <!-- ════ OpenAI TTS ════ -->
    <template v-if="vs.provider.value === 'openai'">
      <SettingRow
        :label="t('settings.voice.openaiKey')"
        :hint="t('settings.voice.openaiKeyHint')"
      >
        <NInput
          :value="vs.openaiApiKey.value"
          type="password"
          size="small"
          show-password-on="click"
          style="width: 360px"
          placeholder="sk-..."
          @update:value="vs.setOpenaiApiKey"
        />
      </SettingRow>

      <SettingRow
        :label="t('settings.voice.openaiUrl')"
        :hint="t('settings.voice.openaiUrlHint')"
      >
        <NInput
          :value="vs.openaiBaseUrl.value"
          size="small"
          style="width: 360px"
          placeholder="https://api.openai.com/v1/audio/speech"
          @update:value="vs.setOpenaiBaseUrl"
        />
      </SettingRow>

      <SettingRow
        :label="t('settings.voice.openaiModel')"
        :hint="t('settings.voice.openaiModelHint')"
      >
        <NSelect
          :value="vs.openaiModel.value"
          :options="openaiModelOptions"
          size="small"
          style="width: 200px"
          @update:value="vs.setOpenaiModel"
        />
      </SettingRow>

      <SettingRow
        :label="t('settings.voice.openaiVoice')"
        :hint="t('settings.voice.openaiVoiceHint')"
      >
        <NSelect
          :value="vs.openaiVoice.value"
          :options="openaiVoiceOptions"
          size="small"
          style="width: 200px"
          @update:value="vs.setOpenaiVoice"
        />
      </SettingRow>

    </template>

    <!-- ════ Custom Endpoint ════ -->
    <template v-if="vs.provider.value === 'custom'">
      <div class="provider-hint">
        {{ t('settings.voice.customHint') }}
      </div>

      <SettingRow
        :label="t('settings.voice.customUrl')"
        :hint="t('settings.voice.customUrlHint')"
      >
        <NInput
          :value="vs.customUrl.value"
          size="small"
          style="width: 360px"
          :placeholder="t('settings.voice.customUrlPlaceholder')"
          @update:value="vs.setCustomUrl"
        />
      </SettingRow>

      <SettingRow
        :label="t('settings.voice.customApiKey')"
        :hint="t('settings.voice.customApiKeyHint')"
      >
        <NInput
          :value="vs.customApiKey.value"
          type="password"
          size="small"
          show-password-on="click"
          style="width: 360px"
          :placeholder="t('settings.voice.customApiKeyPlaceholder')"
          @update:value="vs.setCustomApiKey"
        />
      </SettingRow>


    </template>

    <!-- ════ Edge TTS ════ -->
    <template v-if="vs.provider.value === 'edge'">
      <div class="provider-hint">
        {{ t('settings.voice.edgeHint') }}
      </div>

<SettingRow
        :label="t('settings.voice.edgeVoice')"
        :hint="t('settings.voice.edgeVoiceHint')"
      >
        <NSelect
          :value="vs.edgeVoice.value"
          :options="edgeVoiceOptions"
          size="small"
          filterable
          style="width: 320px"
          :consistent-menu-width="false"
          @update:value="vs.setEdgeVoice"
        />
      </SettingRow>

    </template>

    <!-- ─── Test / Audition ─── -->
    <div class="test-section">
      <h4 class="test-title">{{ t('settings.voice.testTitle') }}</h4>
      <div class="test-row">
        <NInput
          v-model:value="testText"
          size="small"
          style="width: 360px"
          :placeholder="t('settings.voice.testTextPlaceholder')"
          :disabled="testPlaying"
          @keyup.enter="handleTest"
        />
        <NButton
          size="small"
          type="primary"
          :loading="testPlaying"
          :disabled="testPlaying"
          @click="handleTest"
        >
          {{ testPlaying ? t('settings.voice.testButtonPlaying') : t('settings.voice.testButton') }}
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.voice-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.provider-hint {
  font-size: 12px;
  color: #888;
  line-height: 1.5;
  padding: 0 0 4px 0;
}

.test-section {
  padding-top: 16px;

  .test-title {
    margin: 0 0 8px 0;
    font-size: 14px;
    font-weight: 600;
  }

  .test-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
}
</style>
