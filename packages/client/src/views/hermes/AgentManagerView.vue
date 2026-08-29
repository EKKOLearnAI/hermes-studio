<script setup lang="ts">
import { computed, defineAsyncComponent, h, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NDrawer, NDrawerContent, NPopconfirm, NSpin, NTag, useDialog, useMessage } from 'naive-ui'
import {
  checkCodingAgentUpdate,
  deleteCodingAgent,
  fetchCodingAgentsStatus,
  installCodingAgent,
  type CodingAgentId,
  type CodingAgentToolStatus,
  type CodingAgentUpdateResult,
} from '@/api/coding-agents'
import { fetchAgentStatusSnapshot, type AgentStatusSnapshot } from '@/api/agent-status'
import { fetchRuntimeVersionStatus } from '@/api/hermes/runtime-versions'
import VersionManagementModal from '@/components/layout/VersionManagementModal.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'

const AiHelpChatPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/ChatPanel.vue')).default)

interface CodingAgentCard {
  id: CodingAgentId
  name: string
  provider: string
  logo: string
  command: string
  packageName: string
}

defineProps<{
  sidebarCollapsed: boolean
}>()

const emit = defineEmits<{
  toggleSidebar: []
}>()

const codingAgents: CodingAgentCard[] = [
  {
    id: 'claude-code',
    name: 'Claude',
    provider: 'Anthropic',
    logo: '/coding-agents/claude-code.svg',
    command: 'claude',
    packageName: '@anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    provider: 'OpenAI',
    logo: '/coding-agents/codex-openai.png',
    command: 'codex',
    packageName: '@openai/codex',
  },
  {
    id: 'pi',
    name: 'Pi',
    provider: 'Pi',
    logo: '/coding-agents/pi.svg',
    command: 'pi',
    packageName: '@earendil-works/pi-coding-agent',
  },
]

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const appStore = useAppStore()
const chatStore = useChatStore()
const route = useRoute()
const router = useRouter()

const tools = ref<CodingAgentToolStatus[]>([])
const agentStatusSnapshot = ref<AgentStatusSnapshot | null>(null)
const loading = ref(false)
const loadError = ref('')
const runtimeManagerVisible = ref(false)
const aiHelpDrawerVisible = ref(false)
const aiHelpPrompt = ref('')
const installing = ref<Record<CodingAgentId, boolean>>({ 'claude-code': false, codex: false, pi: false })
const deleting = ref<Record<CodingAgentId, boolean>>({ 'claude-code': false, codex: false, pi: false })
const checkingUpdate = ref<Record<CodingAgentId, boolean>>({ 'claude-code': false, codex: false, pi: false })
const updateInfo = ref<Record<CodingAgentId, CodingAgentUpdateResult | null>>({
  'claude-code': null,
  codex: null,
  pi: null,
})

const hermesStatus = computed(() => agentStatusSnapshot.value?.agents.find(agent => agent.id === 'hermes'))
const hermesDetected = computed(() => Boolean(hermesStatus.value?.installed))
const hermesVersion = computed(() => formatHermesVersion(hermesStatus.value?.version))
const hermesType = computed<'CLI' | 'Runtime' | ''>(() => {
  if (hermesStatus.value?.source === 'user-cli') return 'CLI'
  if (hermesStatus.value?.source === 'managed-runtime') return 'Runtime'
  return ''
})

watch(runtimeManagerVisible, (visible, previous) => {
  if (!visible && previous) {
    void syncAgentStatus().catch((error) => {
      loadError.value = errorMessage(error)
    })
  }
})

function toolStatus(id: CodingAgentId): CodingAgentToolStatus | undefined {
  return tools.value.find(tool => tool.id === id)
}

function formatVersion(value?: string): string {
  const version = value?.trim()
  if (!version) return t('agentManager.unknownVersion')
  return /^v(?=\d)/i.test(version) ? version : `v${version}`
}

function formatHermesVersion(value?: string): string {
  return formatVersion(value?.split('·')[0])
}

function installedVersion(id: CodingAgentId): string {
  const status = toolStatus(id)
  const version = status?.version?.trim()
  if (version) return formatVersion(version)
  return status?.rawVersion?.trim() || t('agentManager.unknownVersion')
}

function replaceTool(next: CodingAgentToolStatus) {
  tools.value = tools.value.some(tool => tool.id === next.id)
    ? tools.value.map(tool => tool.id === next.id ? next : tool)
    : [...tools.value, next]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type AgentManagementOperation = 'install' | 'delete'

function operationLabel(operation: AgentManagementOperation): string {
  return t(operation === 'install' ? 'agentManager.installOperation' : 'agentManager.deleteOperation')
}

function buildAiHelpPrompt(agent: CodingAgentCard, operation: AgentManagementOperation, error: string): string {
  return t('agentManager.aiHelpPrompt', {
    name: agent.name,
    id: agent.id,
    operation: operationLabel(operation),
    command: agent.command,
    package: agent.packageName,
    error,
  })
}

function startAiHelpChat(prompt: string) {
  chatStore.newChat({
    source: 'coding_agent',
    agent: 'ekko-agent',
    codingAgentId: 'ekko-agent',
    codingAgentMode: 'scoped',
  })
  aiHelpPrompt.value = prompt
  aiHelpDrawerVisible.value = true
}

function openAiHelpDrawer(agent: CodingAgentCard, operation: AgentManagementOperation, error: string) {
  startAiHelpChat(buildAiHelpPrompt(agent, operation, error))
}

function openGeneralAiHelpDrawer() {
  startAiHelpChat(t('agentManager.aiHelpGeneralPrompt'))
}

function offerAiHelp(id: CodingAgentId, operation: AgentManagementOperation, error: string) {
  const agent = codingAgents.find(item => item.id === id)
  if (!agent) return
  dialog.warning({
    title: t('agentManager.aiHelpDialogTitle', { name: agent.name }),
    content: () => h('div', { class: 'agent-ai-help-dialog' }, [
      h('p', t('agentManager.aiHelpDialogQuestion', {
        name: agent.name,
        operation: operationLabel(operation),
      })),
      h('pre', { class: 'agent-ai-help-error' }, error),
    ]),
    positiveText: t('agentManager.aiHelpDialogPositive'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => openAiHelpDrawer(agent, operation, error),
  })
}

function handleMutationError(id: CodingAgentId, operation: AgentManagementOperation, error: unknown) {
  const detail = errorMessage(error)
  message.error(detail)
  offerAiHelp(id, operation, detail)
}

function applyAgentStatusSnapshot(snapshot: AgentStatusSnapshot) {
  agentStatusSnapshot.value = snapshot
  const statuses = new Map(snapshot.agents.map(status => [status.id, status]))
  tools.value = codingAgents.map((agent) => {
    const status = statuses.get(agent.id)
    return {
      ...agent,
      installed: Boolean(status?.installed),
      version: status?.version || '',
      rawVersion: status?.version || '',
      source: status?.source === 'user-cli' ? 'user-cli' : 'not-installed',
      path: status?.path || '',
      error: status?.error || '',
    }
  })
}

async function syncAgentStatus() {
  applyAgentStatusSnapshot(await fetchAgentStatusSnapshot())
}

async function loadCachedStatus() {
  loading.value = true
  loadError.value = ''
  try {
    await syncAgentStatus()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function refreshAll() {
  loading.value = true
  loadError.value = ''
  const results = await Promise.allSettled([
    fetchCodingAgentsStatus(),
    fetchRuntimeVersionStatus({ includeRemote: false }),
  ])
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => errorMessage(result.reason))
  try {
    await syncAgentStatus()
  } catch (error) {
    errors.push(errorMessage(error))
  }
  if (errors.length) loadError.value = errors.join('\n')
  loading.value = false
}

async function handleInstall(id: CodingAgentId) {
  installing.value[id] = true
  try {
    const result = await installCodingAgent(id)
    tools.value = result.tools
    if (!result.success) throw new Error(result.message || t('codingAgents.installFailed'))
    updateInfo.value[id] = null
    message.success(t('codingAgents.installSuccess'))
  } catch (error) {
    handleMutationError(id, 'install', error)
  } finally {
    installing.value[id] = false
  }
}

async function handleDelete(id: CodingAgentId) {
  deleting.value[id] = true
  try {
    const result = await deleteCodingAgent(id)
    tools.value = result.tools
    if (!result.success) throw new Error(result.message || t('codingAgents.deleteFailed'))
    updateInfo.value[id] = null
    message.success(t('codingAgents.deleteSuccess'))
  } catch (error) {
    handleMutationError(id, 'delete', error)
  } finally {
    deleting.value[id] = false
  }
}

async function handleCheckUpdate(id: CodingAgentId) {
  checkingUpdate.value[id] = true
  try {
    const result = await checkCodingAgentUpdate(id)
    if (!result.success) throw new Error(result.message || t('codingAgents.checkUpdateFailed'))
    replaceTool(result.tool)
    updateInfo.value[id] = result
  } catch (error) {
    message.error(errorMessage(error))
  } finally {
    checkingUpdate.value[id] = false
  }
}

onMounted(() => {
  if (route.query.runtime === 'install') {
    runtimeManagerVisible.value = true
    const query = { ...route.query }
    delete query.runtime
    void router.replace({ query })
  }
  void loadCachedStatus()
})
</script>

<template>
  <div class="agent-manager-panel">
      <header class="page-header">
        <div class="agent-manager-header-left">
          <NButton
            class="agent-manager-sidebar-toggle"
            quaternary
            size="small"
            circle
            :title="sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')"
            :aria-label="sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')"
            @click="emit('toggleSidebar')"
          >
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
            </template>
          </NButton>
          <h2 class="header-title">{{ t('agentManager.title') }}</h2>
        </div>
        <div class="agent-manager-header-actions">
          <NButton size="small" secondary :loading="loading" @click="refreshAll()">
            {{ t('agentManager.refresh') }}
          </NButton>
          <NButton size="small" secondary @click="openGeneralAiHelpDrawer">
            {{ t('agentManager.aiHelpDialogPositive') }}
          </NButton>
        </div>
      </header>

      <NSpin :show="loading" class="agent-manager-spin">
        <div class="agent-manager-content">
          <NAlert v-if="loadError" type="error" :bordered="false">
            {{ loadError }}
          </NAlert>

          <div class="coding-agent-grid">
            <section class="agent-card coding-agent-card" data-testid="agent-card-ekko">
              <header class="agent-card-header compact">
                <div class="agent-identity">
                  <img :src="'/coding-agents/ekko-agent.png'" alt="" class="agent-logo" />
                  <div>
                    <div class="agent-name-row">
                      <h3>Ekko</h3>
                      <NTag type="success" size="small" :bordered="false">{{ t('agentManager.builtIn') }}</NTag>
                    </div>
                    <p class="agent-version">Studio {{ formatVersion(appStore.serverVersion) }}</p>
                  </div>
                </div>
              </header>
              <div class="agent-actions">
                <NButton
                  secondary
                  size="small"
                  @click="router.push({ name: 'ekko.settings' })"
                >
                  {{ t('sidebar.settings') }}
                </NButton>
              </div>
            </section>

          <section class="agent-card coding-agent-card hermes-card" data-testid="agent-card-hermes">
            <header class="agent-card-header compact">
              <div class="agent-identity">
                <img :src="'/coding-agents/hermes.png'" alt="" class="agent-logo" />
                <div>
                  <div class="agent-name-row">
                    <h3>Hermes</h3>
                    <NTag
                      v-if="hermesDetected && hermesType"
                      data-testid="hermes-source-type"
                      type="info"
                      size="small"
                      :bordered="false"
                    >
                      {{ hermesType }}
                    </NTag>
                    <NTag :type="hermesDetected ? 'success' : 'warning'" size="small" :bordered="false">
                      {{ hermesDetected ? t('codingAgents.installed') : t('codingAgents.notInstalled') }}
                    </NTag>
                  </div>
                  <p v-if="hermesDetected" class="agent-version">{{ hermesVersion }}</p>
                  <p v-else>{{ t('agentManager.hermesDescription') }}</p>
                </div>
              </div>
            </header>

            <div class="agent-actions">
              <NButton
                v-if="!hermesDetected || hermesType === 'Runtime'"
                type="primary"
                secondary
                size="small"
                @click="runtimeManagerVisible = true"
              >
                {{ hermesDetected ? t('agentManager.manageRuntime') : t('codingAgents.installNow') }}
              </NButton>
              <NButton
                v-if="hermesDetected"
                secondary
                size="small"
                @click="router.push({ name: 'hermes.configSettings' })"
              >
                {{ t('sidebar.settings') }}
              </NButton>
            </div>
          </section>

            <section
              v-for="agent in codingAgents"
              :key="agent.id"
              class="agent-card coding-agent-card"
              :data-testid="`agent-card-${agent.id}`"
            >
              <header class="agent-card-header compact">
                <div class="agent-identity">
                  <img :src="agent.logo" alt="" class="agent-logo" />
                  <div>
                    <div class="agent-name-row">
                      <h3>{{ agent.name }}</h3>
                      <NTag size="small" :bordered="false">{{ agent.provider }}</NTag>
                      <NTag
                        :type="toolStatus(agent.id)?.installed ? 'success' : 'warning'"
                        size="small"
                        :bordered="false"
                      >
                        {{ toolStatus(agent.id)?.installed ? t('codingAgents.installed') : t('codingAgents.notInstalled') }}
                      </NTag>
                    </div>
                    <p v-if="toolStatus(agent.id)?.installed" class="agent-version">
                      {{ installedVersion(agent.id) }}
                    </p>
                    <p v-else>{{ t('agentManager.codingAgentDescription') }}</p>
                  </div>
                </div>
              </header>

              <div class="agent-actions">
                <NButton
                  v-if="!toolStatus(agent.id)?.installed"
                  type="primary"
                  secondary
                  size="small"
                  :loading="installing[agent.id]"
                  @click="handleInstall(agent.id)"
                >
                  {{ t('codingAgents.installNow') }}
                </NButton>
                <NButton
                  v-else-if="updateInfo[agent.id]?.updateAvailable"
                  type="primary"
                  secondary
                  size="small"
                  :loading="installing[agent.id]"
                  @click="handleInstall(agent.id)"
                >
                  {{ t('agentManager.updateToVersion', { version: updateInfo[agent.id]?.latestVersion }) }}
                </NButton>
                <NButton
                  v-if="toolStatus(agent.id)?.installed"
                  secondary
                  size="small"
                  :loading="checkingUpdate[agent.id]"
                  :disabled="installing[agent.id] || deleting[agent.id]"
                  @click="handleCheckUpdate(agent.id)"
                >
                  {{ t('codingAgents.checkUpdate') }}
                </NButton>
                <NPopconfirm
                  v-if="toolStatus(agent.id)?.installed"
                  @positive-click="handleDelete(agent.id)"
                >
                  <template #trigger>
                    <NButton
                      type="error"
                      secondary
                      size="small"
                      :loading="deleting[agent.id]"
                      :disabled="installing[agent.id] || checkingUpdate[agent.id]"
                    >
                      {{ t('codingAgents.deleteNow') }}
                    </NButton>
                  </template>
                  {{ t('agentManager.deleteConfirm', { name: agent.name }) }}
                </NPopconfirm>
              </div>
            </section>
          </div>
        </div>
      </NSpin>

    <VersionManagementModal v-model:show="runtimeManagerVisible" />

    <NDrawer
      v-model:show="aiHelpDrawerVisible"
      class="agent-ai-help-drawer"
      placement="right"
      width="min(760px, 100vw)"
    >
      <NDrawerContent :title="t('agentManager.aiHelpDrawerTitle')" closable body-content-style="padding: 0; overflow: hidden;">
        <AiHelpChatPanel
          v-if="aiHelpDrawerVisible"
          standalone
          :initial-composer-text="aiHelpPrompt"
          :composer-persist-draft="false"
        />
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.agent-manager-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: $bg-main-surface;
}

:global(.agent-ai-help-dialog p) {
  margin: 0 0 12px;
}

:global(.agent-ai-help-error) {
  max-height: 180px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

:global(.agent-ai-help-drawer .n-drawer-body-content-wrapper) {
  height: 100%;
}

.agent-manager-header-left,
.agent-manager-header-actions,
.agent-identity,
.agent-name-row,
.agent-actions {
  display: flex;
  align-items: center;
}

.agent-manager-header-left {
  min-width: 0;
  gap: 8px;
}

.agent-manager-header-actions {
  flex: 0 0 auto;
  gap: 8px;
}

.header-title {
  margin: 0;
}

.agent-manager-spin {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;

  :deep(.n-spin-content) {
    height: 100%;
  }
}

.agent-manager-content {
  max-width: 1240px;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 0 auto;
  padding: 24px;
}

.agent-card {
  padding: 18px;
  border: 1px solid $border-color;
  border-radius: 14px;
  background: $bg-card;
  box-shadow: 0 5px 18px rgba(0, 0, 0, 0.05);
}

.agent-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;

  &.compact {
    align-items: center;
  }
}

.agent-identity {
  min-width: 0;
  align-items: flex-start;
  gap: 12px;

  h3 {
    margin: 0;
    font-size: 17px;
  }

  p {
    max-width: 720px;
    margin: 5px 0 0;
    color: $text-secondary;
    font-size: 12px;
    line-height: 1.55;

    &.agent-version {
      color: $text-primary;
      font-size: 13px;
      font-weight: 650;
      letter-spacing: 0.01em;
    }
  }
}

.agent-name-row {
  flex-wrap: wrap;
  gap: 8px;
}

.agent-logo {
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  padding: 4px;
  border: 1px solid $border-color;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.92);
  object-fit: contain;
}

.coding-agent-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
  gap: 16px;
}

.coding-agent-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.agent-actions {
  flex-wrap: wrap;
  gap: 8px;
  margin-top: auto;
}

@media (max-width: $breakpoint-mobile) {
  :global(.agent-ai-help-drawer.n-drawer) {
    width: 100vw !important;
    max-width: 100vw;
  }

  .agent-manager-sidebar-toggle {
    display: none;
  }

  .agent-manager-content {
    padding: 16px;
  }

  .coding-agent-grid {
    grid-template-columns: 1fr;
  }

  .agent-card-header,
  .agent-card-header.compact {
    align-items: stretch;
  }

  .agent-card-header,
  .agent-card-header.compact {
    flex-direction: column;
  }

}
</style>
