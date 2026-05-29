<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NRadioButton, NRadioGroup, NSelect, NSpace, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  deleteCodingAgent,
  fetchCodingAgentsStatus,
  installCodingAgent,
  launchCodingAgentNativeTerminal,
  prepareCodingAgentLaunch,
  readCodingAgentConfigFile,
  writeCodingAgentConfigFile,
  type CodingAgentApiMode,
  type CodingAgentId,
  type CodingAgentLaunchMode,
  type CodingAgentLaunchResult,
  type CodingAgentToolStatus,
} from '@/api/coding-agents'
import { fetchAvailableModelsForProfile, type AvailableModelGroup } from '@/api/hermes/system'
import { useProfilesStore } from '@/stores/hermes/profiles'
import TerminalPanel from '@/components/hermes/chat/TerminalPanel.vue'

type CodingAgentBlock = {
  id: CodingAgentId
  tool: 'Claude Code' | 'Codex'
  provider: 'Anthropic' | 'OpenAI'
}

type ConfigFileEntry = {
  key: string
  path: string
  language: string
}

type ConfigEditorState = {
  selectedKey: string
  content: string
  originalContent: string
  loading: boolean
  saving: boolean
  absolutePath?: string
  exists?: boolean
}

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()
const loading = ref(false)
const loadError = ref('')
const tools = ref<CodingAgentToolStatus[]>([])
const installing = ref<Record<CodingAgentId, boolean>>({
  'claude-code': false,
  codex: false,
})
const deleting = ref<Record<CodingAgentId, boolean>>({
  'claude-code': false,
  codex: false,
})
const launchModalVisible = ref(false)
const launchLoading = ref(false)
const launchPreparing = ref(false)
const nativeLaunchPreparing = ref(false)
const launchAgentId = ref<CodingAgentId>('claude-code')
const launchProviders = ref<AvailableModelGroup[]>([])
const launchMode = ref<CodingAgentLaunchMode>('scoped')
const launchProvider = ref('')
const launchModel = ref('')
const launchApiMode = ref<CodingAgentApiMode>('codex_responses')
const launchResult = ref<CodingAgentLaunchResult | null>(null)
const terminalVisible = ref(false)
const terminalCommand = ref('')
const terminalKey = ref(0)

const agentLogos: Record<CodingAgentBlock['tool'], string> = {
  'Claude Code': '/coding-agents/claude-code.svg',
  Codex: '/coding-agents/codex-openai.png',
}

const agentBlocks: CodingAgentBlock[] = [
  {
    id: 'claude-code',
    tool: 'Claude Code',
    provider: 'Anthropic',
  },
  {
    id: 'codex',
    tool: 'Codex',
    provider: 'OpenAI',
  },
]

const configFiles: Record<CodingAgentId, ConfigFileEntry[]> = {
  'claude-code': [
    { key: 'settings', path: '~/.claude/settings.json', language: 'json' },
    { key: 'mcp', path: '~/.claude.json', language: 'json' },
    { key: 'prompt', path: '~/.claude/CLAUDE.md', language: 'markdown' },
  ],
  codex: [
    { key: 'auth', path: '~/.codex/auth.json', language: 'json' },
    { key: 'config', path: '~/.codex/config.toml', language: 'ini' },
    { key: 'agents', path: '~/.codex/AGENTS.md', language: 'markdown' },
  ],
}

const configEditorStates = ref<Record<CodingAgentId, ConfigEditorState>>({
  'claude-code': {
    selectedKey: 'settings',
    content: '',
    originalContent: '',
    loading: false,
    saving: false,
  },
  codex: {
    selectedKey: 'config',
    content: '',
    originalContent: '',
    loading: false,
    saving: false,
  },
})

const statusById = computed(() => {
  return tools.value.reduce((acc, tool) => {
    acc[tool.id] = tool
    return acc
  }, {} as Partial<Record<CodingAgentId, CodingAgentToolStatus>>)
})

const activeProfileName = computed(() => profilesStore.activeProfileName || 'default')

const launchProviderOptions = computed(() => launchProviders.value.map(provider => ({
  label: provider.label && provider.label !== provider.provider
    ? `${provider.label} (${provider.provider})`
    : provider.provider,
  value: provider.provider,
})))

const selectedLaunchProvider = computed(() => (
  launchProviders.value.find(provider => provider.provider === launchProvider.value) || null
))

const launchModelOptions = computed(() => (
  selectedLaunchProvider.value?.models.map(model => ({ label: model, value: model })) || []
))

const launchProtocolOptions = computed(() => [
  { label: t('codingAgents.protocolOpenAiChat'), value: 'chat_completions' },
  { label: t('codingAgents.protocolOpenAiResponses'), value: 'codex_responses' },
  { label: t('codingAgents.protocolAnthropicMessages'), value: 'anthropic_messages' },
])

const launchModeOptions = computed(() => [
  { label: t('codingAgents.launchModeGlobal'), value: 'global' },
  { label: t('codingAgents.launchModeScoped'), value: 'scoped' },
])

const launchModeThemeOverrides = {
  buttonColorActive: '#111827',
  buttonTextColorActive: '#fff',
  buttonBorderColorActive: '#111827',
  buttonBoxShadow: 'inset 0 0 0 1px var(--border-color)',
  buttonBoxShadowHover: 'inset 0 0 0 1px #111827',
}

const useGlobalLaunchConfig = computed(() => (
  launchMode.value === 'global'
))

function statusFor(id: CodingAgentId) {
  return statusById.value[id]
}

function configFilesFor(id: CodingAgentId) {
  return configFiles[id]
}

function selectedConfigFile(id: CodingAgentId) {
  return configFiles[id].find(file => file.key === configEditorStates.value[id].selectedKey) || configFiles[id][0]
}

function hasConfigUnsavedChanges(id: CodingAgentId) {
  const state = configEditorStates.value[id]
  return state.content !== state.originalContent
}

async function loadStatus() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await fetchCodingAgentsStatus()
    tools.value = data.tools
  } catch (err: any) {
    loadError.value = err?.message || t('codingAgents.loadFailed')
  } finally {
    loading.value = false
  }
}

async function loadConfigFile(agentId: CodingAgentId, file: ConfigFileEntry) {
  const state = configEditorStates.value[agentId]
  state.selectedKey = file.key
  state.loading = true
  try {
    const result = await readCodingAgentConfigFile(agentId, file.key)
    state.content = result.content
    state.originalContent = result.content
    state.absolutePath = result.absolutePath
    state.exists = result.exists
  } catch (err: any) {
    message.error(err?.message || t('codingAgents.configLoadFailed'))
  } finally {
    state.loading = false
  }
}

async function saveConfigFile(agentId: CodingAgentId) {
  const state = configEditorStates.value[agentId]
  const file = selectedConfigFile(agentId)
  if (!file) return
  state.saving = true
  try {
    const result = await writeCodingAgentConfigFile(
      agentId,
      file.key,
      state.content,
    )
    state.originalContent = result.content
    state.absolutePath = result.absolutePath
    state.exists = result.exists
    message.success(t('files.saved'))
  } catch (err: any) {
    message.error(err?.message || t('files.saveFailed'))
  } finally {
    state.saving = false
  }
}

function resetLaunchSelection() {
  const firstProvider = launchProviders.value[0]
  launchProvider.value = firstProvider?.provider || ''
  launchModel.value = firstProvider?.models[0] || ''
  launchApiMode.value = defaultLaunchApiMode(firstProvider)
}

function handleLaunchProviderChange(value: string) {
  const provider = launchProviders.value.find(item => item.provider === value)
  launchModel.value = provider?.models[0] || ''
  launchApiMode.value = defaultLaunchApiMode(provider)
}

function defaultLaunchApiMode(provider?: AvailableModelGroup | null): CodingAgentApiMode {
  const providerKey = String(provider?.provider || '').toLowerCase()
  const baseUrl = String(provider?.base_url || '').toLowerCase()
  if (
    providerKey.includes('claude') ||
    providerKey === 'anthropic' ||
    baseUrl.includes('anthropic') ||
    baseUrl.includes('/anthropic')
  ) {
    return 'anthropic_messages'
  }
  if (
    providerKey === 'deepseek' ||
    providerKey === 'lmstudio' ||
    baseUrl.includes('deepseek') ||
    baseUrl.includes('127.0.0.1') ||
    baseUrl.includes('localhost')
  ) {
    return 'chat_completions'
  }
  return 'codex_responses'
}

async function openLaunchModal(agentId: CodingAgentId) {
  launchAgentId.value = agentId
  launchMode.value = 'scoped'
  launchModalVisible.value = true
  launchResult.value = null
  launchLoading.value = true
  try {
    const result = await fetchAvailableModelsForProfile(activeProfileName.value)
    launchProviders.value = result.groups || []
    resetLaunchSelection()
  } catch (err: any) {
    message.error(err?.message || t('codingAgents.loadProvidersFailed'))
  } finally {
    launchLoading.value = false
  }
}

function currentLaunchRequest() {
  if (useGlobalLaunchConfig.value) {
    return {
      mode: 'global' as const,
      profile: activeProfileName.value,
    }
  }
  const provider = selectedLaunchProvider.value
  return {
    mode: 'scoped' as const,
    profile: activeProfileName.value,
    provider: launchProvider.value,
    model: launchModel.value,
    baseUrl: provider?.base_url || '',
    apiKey: provider?.api_key || '',
    apiMode: launchApiMode.value,
  }
}

async function launchBuiltInTerminal() {
  if (!useGlobalLaunchConfig.value && (!launchProvider.value || !launchModel.value)) {
    message.error(t('codingAgents.selectProviderModel'))
    return
  }
  launchPreparing.value = true
  try {
    launchResult.value = await prepareCodingAgentLaunch(launchAgentId.value, currentLaunchRequest())
    terminalCommand.value = launchResult.value.shellCommand
    terminalKey.value += 1
    launchModalVisible.value = false
    terminalVisible.value = true
    message.success(t('codingAgents.launchPrepared'))
  } catch (err: any) {
    message.error(err?.message || t('codingAgents.launchPrepareFailed'))
  } finally {
    launchPreparing.value = false
  }
}

async function launchNativeTerminal() {
  if (!useGlobalLaunchConfig.value && (!launchProvider.value || !launchModel.value)) {
    message.error(t('codingAgents.selectProviderModel'))
    return
  }
  nativeLaunchPreparing.value = true
  try {
    await launchCodingAgentNativeTerminal(launchAgentId.value, currentLaunchRequest())
    launchModalVisible.value = false
    message.success(t('codingAgents.nativeLaunchStarted'))
  } catch (err: any) {
    message.error(err?.message || t('codingAgents.nativeLaunchFailed'))
  } finally {
    nativeLaunchPreparing.value = false
  }
}

async function handleInstall(id: CodingAgentId) {
  installing.value[id] = true
  try {
    const result = await installCodingAgent(id)
    tools.value = result.tools
    if (result.success) {
      message.success(t('codingAgents.installSuccess'))
    } else {
      message.error(result.message || t('codingAgents.installFailed'))
    }
  } catch (err: any) {
    message.error(err?.message || t('codingAgents.installFailed'))
  } finally {
    installing.value[id] = false
  }
}

async function handleDelete(id: CodingAgentId) {
  deleting.value[id] = true
  try {
    const result = await deleteCodingAgent(id)
    tools.value = result.tools
    if (result.success) {
      message.success(t('codingAgents.deleteSuccess'))
    } else {
      message.error(result.message || t('codingAgents.deleteFailed'))
    }
  } catch (err: any) {
    message.error(err?.message || t('codingAgents.deleteFailed'))
  } finally {
    deleting.value[id] = false
  }
}

onMounted(() => {
  void loadStatus()
  void loadConfigFile('claude-code', configFiles['claude-code'][0])
  void loadConfigFile('codex', configFiles.codex[1])
})
</script>

<template>
  <div class="coding-agents-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('codingAgents.title') }}</h2>
      <NButton size="small" quaternary :loading="loading" @click="loadStatus">
        {{ t('codingAgents.refresh') }}
      </NButton>
    </header>

    <div class="coding-agents-content">
      <NAlert v-if="loadError" type="error" class="status-alert">
        {{ loadError }}
      </NAlert>

      <div class="agent-blocks">
        <section v-for="block in agentBlocks" :key="block.tool" class="agent-block">
          <header class="agent-block-header">
            <img class="agent-logo" :src="agentLogos[block.tool]" alt="" />
            <div>
              <h3>{{ block.tool }}</h3>
              <NTag class="provider-tag" size="small">{{ block.provider }}</NTag>
            </div>
          </header>

          <div class="agent-install-state">
            <div class="install-state-main">
              <div class="install-state-title">{{ t('codingAgents.installStatus') }}</div>
              <div class="install-state-value">
                <NTag v-if="loading && !statusFor(block.id)" size="small">
                  {{ t('codingAgents.checking') }}
                </NTag>
                <template v-else-if="statusFor(block.id)?.installed">
                  <NTag size="small" type="success">{{ t('codingAgents.installed') }}</NTag>
                  <span class="version-text">
                    {{ statusFor(block.id)?.version || statusFor(block.id)?.rawVersion }}
                  </span>
                </template>
                <NTag v-else size="small" type="warning">{{ t('codingAgents.notInstalled') }}</NTag>
              </div>
            </div>
            <NButton
              v-if="statusFor(block.id)?.installed"
              size="small"
              type="error"
              secondary
              :loading="deleting[block.id]"
              @click="handleDelete(block.id)"
            >
              {{ deleting[block.id] ? t('codingAgents.deleting') : t('codingAgents.deleteNow') }}
            </NButton>
            <NButton
              v-else
              size="small"
              type="primary"
              secondary
              :loading="installing[block.id]"
              :disabled="loading && !statusFor(block.id)"
              @click="handleInstall(block.id)"
            >
              {{ installing[block.id] ? t('codingAgents.installing') : t('codingAgents.installNow') }}
            </NButton>
          </div>

          <div class="config-file-section">
            <div class="config-file-title">{{ t('codingAgents.configFiles') }}</div>
            <div class="config-file-list">
              <button
                v-for="file in configFilesFor(block.id)"
                :key="file.key"
                class="config-file-cell"
                :class="{ active: configEditorStates[block.id].selectedKey === file.key }"
                type="button"
                @click="loadConfigFile(block.id, file)"
              >
                {{ file.path }}
              </button>
            </div>
          </div>

          <div class="inline-config-editor">
            <div class="config-editor-meta">
              <span class="config-editor-path">
                {{ selectedConfigFile(block.id)?.path }}
              </span>
              <NTag v-if="configEditorStates[block.id].exists === false" size="small" type="warning">
                {{ t('codingAgents.configFileNotCreated') }}
              </NTag>
            </div>
            <NSpin :show="configEditorStates[block.id].loading">
              <NInput
                v-model:value="configEditorStates[block.id].content"
                type="textarea"
                class="config-textarea"
                :disabled="configEditorStates[block.id].loading"
              />
            </NSpin>
            <div class="config-editor-actions">
              <NSpace justify="end">
                <NButton
                  size="small"
                  type="primary"
                  :loading="configEditorStates[block.id].saving"
                  :disabled="configEditorStates[block.id].loading || !hasConfigUnsavedChanges(block.id)"
                  @click="saveConfigFile(block.id)"
                >
                  {{ t('files.saveFile') }}
                </NButton>
                <NButton
                  size="small"
                  type="primary"
                  :disabled="!statusFor(block.id)?.installed"
                  @click="openLaunchModal(block.id)"
                >
                  {{ t('codingAgents.launch') }}
                </NButton>
              </NSpace>
            </div>
          </div>
        </section>
      </div>
    </div>

    <NModal
      v-model:show="launchModalVisible"
      preset="card"
      class="launch-modal"
      :style="{ width: '620px', maxWidth: 'calc(100vw - 32px)' }"
      :title="t('codingAgents.launchTitle')"
      :bordered="false"
    >
      <NSpin :show="launchLoading">
        <NForm label-placement="top">
          <NFormItem :label="t('codingAgents.profileScope')">
            <NTag size="small">{{ activeProfileName }}</NTag>
          </NFormItem>
          <NFormItem :label="t('codingAgents.launchModeScope')">
            <NRadioGroup
              v-model:value="launchMode"
              name="coding-agent-launch-mode"
              :theme-overrides="launchModeThemeOverrides"
            >
              <NRadioButton
                v-for="option in launchModeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </NRadioButton>
            </NRadioGroup>
          </NFormItem>
          <NFormItem v-if="!useGlobalLaunchConfig" :label="t('codingAgents.providerScope')">
            <NSelect
              v-model:value="launchProvider"
              :options="launchProviderOptions"
              :placeholder="t('codingAgents.providerPlaceholder')"
              filterable
              @update:value="handleLaunchProviderChange"
            />
          </NFormItem>
          <NFormItem v-if="!useGlobalLaunchConfig" :label="t('codingAgents.modelScope')">
            <NSelect
              v-model:value="launchModel"
              :options="launchModelOptions"
              :placeholder="t('codingAgents.modelPlaceholder')"
              filterable
            />
          </NFormItem>
          <NFormItem v-if="!useGlobalLaunchConfig" :label="t('codingAgents.protocolScope')">
            <NSelect
              v-model:value="launchApiMode"
              :options="launchProtocolOptions"
            />
          </NFormItem>
        </NForm>
      </NSpin>
      <template #footer>
        <NSpace justify="end">
          <NButton
            secondary
            :loading="launchPreparing"
            :disabled="nativeLaunchPreparing"
            @click="launchBuiltInTerminal"
          >
            {{ t('codingAgents.builtInTerminal') }}
          </NButton>
          <NButton
            type="primary"
            :loading="nativeLaunchPreparing"
            :disabled="launchPreparing"
            @click="launchNativeTerminal"
          >
            {{ t('codingAgents.nativeTerminal') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <Teleport to="body">
      <div v-if="terminalVisible" class="drawer-overlay" @click="terminalVisible = false"></div>
      <div :class="['drawer-panel', { show: terminalVisible }]">
        <div class="drawer-header">
          <div class="drawer-tabs">
            <button class="tab-button active" type="button">
              {{ t('codingAgents.terminalTitle') }}
            </button>
          </div>
          <button class="close-button" type="button" @click="terminalVisible = false">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div class="drawer-content">
          <div class="drawer-pane">
            <TerminalPanel
              :key="terminalKey"
              :visible="terminalVisible"
              :initial-command="terminalCommand"
            />
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.coding-agents-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.coding-agents-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  background: $bg-secondary;
}

.agent-blocks {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.agent-block {
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: $bg-card;
  overflow: hidden;
}

.status-alert {
  margin-bottom: 14px;
}

.agent-block-header {
  padding: 14px;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  align-items: flex-start;
  gap: 12px;
  border-bottom: 1px solid $border-light;

  h3 {
    margin: 0;
    font-size: 16px;
    line-height: 1.2;
  }
}

.provider-tag {
  margin-top: 8px;
}

.agent-logo {
  width: 36px;
  height: 36px;
  object-fit: contain;
  border-radius: 8px;
  background: $bg-secondary;
  padding: 6px;
}

.agent-install-state {
  min-height: 58px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid $border-light;
}

.install-state-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.install-state-title {
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.2;
}

.install-state-value {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.version-text {
  min-width: 0;
  color: $text-secondary;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-file-section {
  padding: 12px 14px;
  border-bottom: 1px solid $border-light;
}

.config-file-title {
  margin-bottom: 8px;
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.2;
}

.config-file-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.config-file-cell {
  border: none;
  color: $text-secondary;
  background: $code-bg;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;

  &:hover {
    color: $text-primary;
    background: $bg-card-hover;
  }

  &.active {
    color: $text-primary;
    background: $bg-card-hover;
    box-shadow: inset 0 0 0 1px $border-color;
  }
}

.config-editor-meta {
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.config-editor-path {
  min-width: 0;
  color: $text-secondary;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inline-config-editor {
  padding: 12px 14px 14px;
}

.config-textarea {
  width: 100%;
  height: 300px;

  :deep(.n-input-wrapper),
  :deep(.n-input__textarea) {
    height: 100%;
  }

  :deep(.n-input__textarea-el) {
    height: 100%;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
  }
}

.config-editor-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}

.launch-modal {
  max-width: 620px;
}

.launch-result {
  margin-top: 4px;
  padding: 12px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: $bg-secondary;

  code {
    display: block;
    margin-bottom: 10px;
    color: $text-primary;
    word-break: break-all;
  }

  pre {
    margin: 0;
    padding: 10px;
    border-radius: $radius-sm;
    background: $code-bg;
    color: $text-primary;
    white-space: pre-wrap;
    word-break: break-all;
  }
}

.launch-result-label {
  margin-bottom: 6px;
  font-size: 12px;
  color: $text-secondary;
}

.drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 999;
}

.drawer-panel {
  position: fixed;
  top: 0;
  right: min(-1180px, -88vw);
  width: min(1180px, 88vw);
  height: calc(100 * var(--vh));
  max-height: calc(100 * var(--vh));
  background: $bg-card;
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  z-index: 1000;
  transition: right 0.3s ease;

  &.show {
    right: 0;
  }
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.drawer-tabs {
  display: flex;
  gap: 8px;
}

.tab-button {
  padding: 8px 16px;
  border: none;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  flex-shrink: 0;
  white-space: nowrap;
  border-radius: $radius-sm;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.05);
  }

  &.active {
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.1);
  }
}

.close-button {
  padding: 8px;
  border: none;
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: $text-secondary;
  cursor: pointer;
  border-radius: $radius-sm;
  transition: all 0.2s;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.15);
  }
}

.drawer-content {
  flex: 1;
  overflow: hidden;
  position: relative;
  min-height: 0;
}

.drawer-pane {
  height: 100%;
  overflow: auto;
}

@media (max-width: 760px) {
  .agent-blocks {
    grid-template-columns: 1fr;
  }

  .coding-agents-content {
    padding: 14px;
  }

  .drawer-panel {
    width: 100%;
    right: -100%;

    &.show {
      right: 0;
    }
  }
}
</style>
