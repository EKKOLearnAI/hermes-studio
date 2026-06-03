<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NInput, NSelect, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const prefsStore = useSessionBrowserPrefsStore()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const message = useMessage()
const { t } = useI18n()

const DEFAULT_TITLE_PROMPT = [
  'Generate a short, clear, neutral session title.',
  'Use 2–4 words only.',
  'Avoid generic wording, punctuation, and unnecessary detail.',
  'Return the title only.',
].join(' ')

type TitleMode = 'first' | 'ai'
type TitleModelMode = 'chat' | 'custom'

const configureOpen = ref(false)
const titleMode = ref<TitleMode>('ai')
const modelMode = ref<TitleModelMode>('chat')
const providerDraft = ref('')
const modelDraft = ref('')
const promptDraft = ref(DEFAULT_TITLE_PROMPT)
const promptEditing = ref(false)

const titleStatus = computed(() => settingsStore.sessionTitleGeneration.enabled === true ? 'AI-generated' : 'First message')

const activeProfileModels = computed(() => {
  const active = profilesStore.activeProfileName || 'default'
  return appStore.profileModelGroups.find(group => group.profile === active)
    || appStore.profileModelGroups.find(group => group.profile === 'default')
    || appStore.profileModelGroups[0]
})

const providerOptions = computed(() => (activeProfileModels.value?.groups || []).map(group => ({
  label: group.label || group.provider,
  value: group.provider,
})))

const currentProviderModels = computed(() => {
  const groups = activeProfileModels.value?.groups || []
  return groups.find(group => group.provider === providerDraft.value)?.models || []
})

const modelOptions = computed(() => currentProviderModels.value.map(model => ({
  label: appStore.displayModelName(model),
  value: model,
})))

watch(providerDraft, (provider) => {
  if (modelOptions.value.some(option => option.value === modelDraft.value)) return
  const first = (activeProfileModels.value?.groups || []).find(group => group.provider === provider)?.models?.[0]
  modelDraft.value = first || ''
})

function syncDraftsFromStore() {
  const config = settingsStore.sessionTitleGeneration
  titleMode.value = config.enabled === true ? 'ai' : 'first'
  modelMode.value = config.use_chat_model === false ? 'custom' : 'chat'
  providerDraft.value = config.provider || activeProfileModels.value?.default_provider || providerOptions.value[0]?.value || ''
  modelDraft.value = config.model || activeProfileModels.value?.default || modelOptions.value[0]?.value || ''
  promptDraft.value = typeof config.prompt === 'string' && config.prompt.trim()
    ? config.prompt
    : DEFAULT_TITLE_PROMPT
  promptEditing.value = false
}

watch(
  () => settingsStore.sessionTitleGeneration,
  () => {
    if (!configureOpen.value) syncDraftsFromStore()
  },
  { immediate: true, deep: true },
)

async function save(values: Record<string, any>) {
  try {
    await settingsStore.saveSection('session_title_generation', values)
    message.success(t('settings.saved'))
  } catch (_err: any) {
    message.error(t('settings.saveFailed'))
  }
}

async function openConfigure() {
  syncDraftsFromStore()
  configureOpen.value = true
  if (appStore.profileModelGroups.length === 0) {
    await appStore.loadModels()
    syncDraftsFromStore()
  }
}

function closeConfigure() {
  configureOpen.value = false
  syncDraftsFromStore()
}

function resetPromptDraft() {
  promptDraft.value = DEFAULT_TITLE_PROMPT
  promptEditing.value = false
}

async function saveConfigure() {
  const prompt = promptDraft.value.trim() || DEFAULT_TITLE_PROMPT
  const values: Record<string, any> = {
    enabled: titleMode.value === 'ai',
    use_chat_model: modelMode.value !== 'custom',
    prompt,
  }

  if (titleMode.value === 'ai' && modelMode.value === 'custom') {
    values.provider = providerDraft.value
    values.model = modelDraft.value
  }

  await save(values)
  configureOpen.value = false
}
</script>

<template>
  <section class="settings-section">
    <SettingRow :label="t('settings.session.liveMonitorHumanOnly')" :hint="t('settings.session.liveMonitorHumanOnlyHint')">
      <NSwitch :value="prefsStore.humanOnly" @update:value="v => prefsStore.setHumanOnly(v)" />
    </SettingRow>

    <SettingRow label="Session titles">
      <div class="title-row-control">
        <span class="title-status">{{ titleStatus }}</span>
        <NButton size="small" tertiary data-testid="session-title-configure" @click="openConfigure">
          Configure
        </NButton>
      </div>
    </SettingRow>

    <div v-if="configureOpen" class="modal-backdrop">
      <div class="title-modal">
        <div class="modal-header">
          <h2>Session titles</h2>
        </div>

        <div class="modal-section">
          <div class="modal-section-title">Mode</div>
          <button
            type="button"
            class="choice-row"
            :class="{ active: titleMode === 'first' }"
            data-testid="session-title-mode-first"
            @click="titleMode = 'first'"
          >
            <span class="choice-mark">{{ titleMode === 'first' ? '●' : '○' }}</span>
            <span>
              <strong>First message</strong>
              <small>Use the first words of the first user message.</small>
            </span>
          </button>
          <button
            type="button"
            class="choice-row"
            :class="{ active: titleMode === 'ai' }"
            data-testid="session-title-mode-ai"
            @click="titleMode = 'ai'"
          >
            <span class="choice-mark">{{ titleMode === 'ai' ? '●' : '○' }}</span>
            <span>
              <strong>AI-generated</strong>
              <small>Generate a short title after the first assistant reply.</small>
            </span>
          </button>
        </div>

        <template v-if="titleMode === 'ai'">
          <div class="modal-section">
            <div class="modal-section-title">Model</div>
            <button
              type="button"
              class="choice-row"
              :class="{ active: modelMode === 'chat' }"
              data-testid="session-title-model-chat"
              @click="modelMode = 'chat'"
            >
              <span class="choice-mark">{{ modelMode === 'chat' ? '●' : '○' }}</span>
              <span><strong>Same as chat model</strong></span>
            </button>
            <button
              type="button"
              class="choice-row"
              :class="{ active: modelMode === 'custom' }"
              data-testid="session-title-model-custom"
              @click="modelMode = 'custom'"
            >
              <span class="choice-mark">{{ modelMode === 'custom' ? '●' : '○' }}</span>
              <span><strong>Custom model</strong></span>
            </button>

            <div v-if="modelMode === 'custom'" class="custom-model-grid">
              <label>
                <span>Provider</span>
                <NSelect v-model:value="providerDraft" :options="providerOptions" />
              </label>
              <label>
                <span>Model</span>
                <NSelect v-model:value="modelDraft" :options="modelOptions" />
              </label>
            </div>
          </div>

          <div class="modal-section">
            <div class="prompt-summary">
              <div>
                <div class="modal-section-title">Prompt</div>
                <div class="prompt-state">Default prompt</div>
              </div>
              <NButton size="small" tertiary @click="promptEditing = !promptEditing">
                {{ promptEditing ? 'Done' : 'Edit' }}
              </NButton>
            </div>
            <NInput
              v-if="promptEditing"
              v-model:value="promptDraft"
              type="textarea"
              :autosize="{ minRows: 4, maxRows: 8 }"
              placeholder="Generate a short, clear, neutral session title."
            />
          </div>
        </template>

        <div class="modal-actions">
          <NButton tertiary @click="resetPromptDraft">Reset to default</NButton>
          <div class="modal-actions-right">
            <NButton tertiary @click="closeConfigure">Cancel</NButton>
            <NButton type="primary" data-testid="session-title-save" @click="saveConfigure">Save</NButton>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}

.title-row-control {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title-status {
  min-width: 98px;
  text-align: right;
  font-size: 12px;
  color: var(--text-secondary);
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.42);
}

.title-modal {
  position: relative;
  width: min(560px, calc(100vw - 32px));
  padding: 20px;
  border-radius: 14px;
  border: 1px solid $border-light;
  background: var(--bg-primary);
  color: var(--text-primary);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.24);
}

.modal-header h2 {
  margin: 0 0 18px;
  font-size: 18px;
  font-weight: 650;
}

.modal-section {
  padding: 16px 0;
  border-top: 1px solid $border-light;
}

.modal-section-title {
  margin-bottom: 10px;
  font-size: 12px;
  font-weight: 650;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.choice-row {
  width: 100%;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;

  &.active {
    border-color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }

  strong {
    display: block;
    font-size: 13px;
    font-weight: 600;
  }

  small {
    display: block;
    margin-top: 2px;
    font-size: 12px;
    color: var(--text-secondary);
  }
}

.choice-mark {
  width: 18px;
  color: $accent-primary;
  line-height: 1.4;
}

.custom-model-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 12px;

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }
}

.prompt-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
}

.prompt-state {
  font-size: 13px;
  color: var(--text-primary);
}

.modal-actions {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid $border-light;
}

.modal-actions-right {
  display: flex;
  gap: 8px;
}

@media (max-width: $breakpoint-mobile) {
  .title-row-control {
    width: 100%;
    justify-content: space-between;
  }

  .title-status {
    text-align: left;
  }

  .custom-model-grid {
    grid-template-columns: 1fr;
  }

  .modal-actions {
    flex-direction: column;
  }

  .modal-actions-right {
    justify-content: flex-end;
  }
}
</style>
