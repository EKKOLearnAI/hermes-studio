<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NModal, NRadioButton, NRadioGroup, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import McpServerCard from '@/components/hermes/mcp/McpServerCard.vue'
import { useMcpConfigInput } from '@/composables/useMcpConfigInput'
import type { CodingAgentId } from '@/api/coding-agents'
import type { McpServerConfig } from '@/api/hermes/mcp'
import {
  addCodingAgentMcpServer,
  fetchCodingAgentMcpServers,
  removeCodingAgentMcpServer,
  testCodingAgentMcpServer,
  updateCodingAgentMcpServer,
  type CodingAgentMcpServerInfo,
} from '@/api/coding-agent-mcp'

const props = defineProps<{
  agentId: CodingAgentId
}>()

const { t } = useI18n()
const message = useMessage()
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const searchQuery = ref('')
const servers = ref<CodingAgentMcpServerInfo[]>([])
const testingServers = ref<Set<string>>(new Set())
const showModal = ref(false)
const modalMode = ref<'add' | 'edit'>('add')
const editingName = ref('')

const {
  inputMode,
  configText,
  configError,
  clearFormatTimer,
  handleInput,
  handleModeChange,
  parseAndValidate,
  setConfigText,
} = useMcpConfigInput({
  messages: {
    invalidJson: () => t('mcp.invalidJson'),
    invalidYaml: detail => detail ? `${t('mcp.invalidYaml')}: ${detail}` : t('mcp.invalidYaml'),
    invalidConfig: () => t('mcp.invalidConfig'),
  },
  validateServer(name, config) {
    if (!name.trim() || !config || typeof config !== 'object' || Array.isArray(config)) {
      return `${name || t('mcp.invalidConfig')}: ${t('mcp.invalidServerConfig')}`
    }
    const server = config as Record<string, unknown>
    if (!String(server.command || '').trim() && !String(server.url || '').trim()) {
      return `${name}: ${t('mcp.missingCommandOrUrl')}`
    }
    return null
  },
})

const placeholder = computed(() => inputMode.value === 'json'
  ? '{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],\n    "enabled": true\n  }\n}'
  : 'my-server:\n  command: npx\n  args:\n    - -y\n    - @modelcontextprotocol/server-filesystem\n    - /path\n  enabled: true')

const toolsByServer = computed<Record<string, Array<{ name: string; description?: string }>>>(() =>
  Object.fromEntries(servers.value.map(server => [server.name, server.tool_details || []])),
)

const summary = computed(() => ({
  total: servers.value.length,
  enabled: servers.value.filter(server => server.raw_config.enabled !== false).length,
  managed: servers.value.filter(server => server.managed).length,
  tools: servers.value.reduce((total, server) => total + server.tools_registered, 0),
}))

const filteredServers = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return servers.value
  return servers.value.filter(server =>
    server.name.toLowerCase().includes(query)
    || server.transport.includes(query)
    || String(server.raw_config.command || '').toLowerCase().includes(query)
    || String(server.raw_config.url || '').toLowerCase().includes(query)
    || server.tool_names.some(tool => tool.toLowerCase().includes(query)),
  )
})

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

async function loadServers() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetchCodingAgentMcpServers(props.agentId)
    servers.value = response.servers || []
  } catch (loadError) {
    error.value = errorMessage(loadError)
  } finally {
    loading.value = false
  }
}

function openAdd() {
  modalMode.value = 'add'
  editingName.value = ''
  inputMode.value = 'json'
  configText.value = ''
  configError.value = ''
  showModal.value = true
}

function openEdit(server: CodingAgentMcpServerInfo) {
  modalMode.value = 'edit'
  editingName.value = server.name
  inputMode.value = 'json'
  setConfigText({ [server.name]: server.raw_config })
  showModal.value = true
}

async function saveServer() {
  clearFormatTimer()
  const { servers: parsed, error: validationError } = parseAndValidate()
  if (validationError) {
    configError.value = validationError
    return
  }
  const entries = Object.entries(parsed) as Array<[string, McpServerConfig]>
  if (!entries.length) {
    configError.value = t('mcp.invalidConfig')
    return
  }
  saving.value = true
  try {
    if (modalMode.value === 'edit') {
      const config = entries.find(([name]) => name === editingName.value)?.[1] || entries[0][1]
      await updateCodingAgentMcpServer(props.agentId, editingName.value, config)
    } else {
      for (const [name, config] of entries) {
        await addCodingAgentMcpServer(props.agentId, name, config)
      }
    }
    showModal.value = false
    await loadServers()
    message.success(t('common.saved'))
  } catch (saveError) {
    message.error(`${t('common.saveFailed')}: ${errorMessage(saveError)}`)
  } finally {
    saving.value = false
  }
}

async function removeServer(server: CodingAgentMcpServerInfo) {
  try {
    await removeCodingAgentMcpServer(props.agentId, server.name)
    await loadServers()
    message.success(t('mcp.serverRemoved', { name: server.name }))
  } catch (removeError) {
    message.error(`${t('common.deleteFailed')}: ${errorMessage(removeError)}`)
  }
}

async function toggleServer(server: CodingAgentMcpServerInfo) {
  try {
    await updateCodingAgentMcpServer(props.agentId, server.name, {
      ...server.raw_config,
      enabled: server.raw_config.enabled === false,
    })
    await loadServers()
  } catch (toggleError) {
    message.error(`${t('common.saveFailed')}: ${errorMessage(toggleError)}`)
  }
}

async function testServer(server: CodingAgentMcpServerInfo) {
  const next = new Set(testingServers.value)
  next.add(server.name)
  testingServers.value = next
  try {
    const response = await testCodingAgentMcpServer(props.agentId, server.name)
    if (response.ok) {
      message.success(t('mcp.testOk', { count: response.tools?.length || 0 }))
      await loadServers()
    } else {
      message.warning(response.error || t('mcp.testEmpty'))
    }
  } catch (testError) {
    message.error(`${t('mcp.testFailed')}: ${errorMessage(testError)}`)
  } finally {
    const current = new Set(testingServers.value)
    current.delete(server.name)
    testingServers.value = current
  }
}

onMounted(loadServers)
watch(() => props.agentId, loadServers)
</script>

<template>
  <div class="mcp-view embedded">
    <header class="page-header">
      <h2 class="header-title">{{ t('mcp.title') }}</h2>
      <NButton size="small" quaternary :loading="loading" @click="loadServers">
        {{ t('mcp.refresh') }}
      </NButton>
    </header>

    <div class="mcp-content" :class="{ 'is-loading': loading && servers.length === 0 }">
      <div v-if="loading && servers.length === 0" class="mcp-loading-state">
        <NSpin />
      </div>
      <template v-else>
        <NAlert v-if="error" type="error" class="mcp-notice">{{ error }}</NAlert>

        <div class="summary-grid">
          <div class="summary-card">
            <span class="summary-label">{{ t('mcp.total') }}</span>
            <strong>{{ summary.total }}</strong>
          </div>
          <div class="summary-card success">
            <span class="summary-label">{{ t('ekkoConfig.enabled') }}</span>
            <strong>{{ summary.enabled }}</strong>
          </div>
          <div class="summary-card warning">
            <span class="summary-label">{{ t('ekkoConfig.managed') }}</span>
            <strong>{{ summary.managed }}</strong>
          </div>
          <div class="summary-card info">
            <span class="summary-label">{{ t('mcp.tool') }}</span>
            <strong>{{ summary.tools }}</strong>
          </div>
        </div>

        <div class="toolbar-row">
          <NInput
            v-model:value="searchQuery"
            :placeholder="t('mcp.searchPlaceholder')"
            clearable
            size="small"
            class="search-input"
          />
          <div class="btn-group">
            <NButton type="primary" size="small" @click="openAdd">{{ t('mcp.addServer') }}</NButton>
          </div>
        </div>

        <div v-if="filteredServers.length" class="servers-grid">
          <McpServerCard
            v-for="server in filteredServers"
            :key="server.name"
            :server="server"
            :tools-by-server="toolsByServer"
            :show-manage-tools="false"
            :show-reload="false"
            :readonly="server.managed"
            :context-label="server.managed ? t('ekkoConfig.managed') : t('ekkoConfig.custom')"
            :testing="testingServers.has(server.name)"
            @edit="openEdit(server)"
            @test="testServer(server)"
            @remove="removeServer(server)"
            @toggle-enabled="toggleServer(server)"
          />
        </div>
        <NEmpty v-else :description="t('mcp.empty')" />
      </template>
    </div>

    <NModal
      v-model:show="showModal"
      :title="modalMode === 'add' ? t('mcp.addTitle') : t('mcp.editTitle')"
      preset="card"
      :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    >
      <div class="mode-switch-row">
        <NRadioGroup v-model:value="inputMode" size="small" @update:value="handleModeChange">
          <NRadioButton value="json">JSON</NRadioButton>
          <NRadioButton value="yaml">YAML</NRadioButton>
        </NRadioGroup>
      </div>
      <NInput
        v-model:value="configText"
        type="textarea"
        :rows="16"
        class="config-textarea"
        :placeholder="placeholder"
        :status="configError ? 'error' : undefined"
        @input="handleInput"
      />
      <div v-if="configError" class="config-error">{{ configError }}</div>
      <div class="modal-actions">
        <NButton @click="showModal = false">{{ t('mcp.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="saveServer">{{ t('mcp.save') }}</NButton>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/mcp-manager' as mcp-manager;

@include mcp-manager.layout;

.mcp-view.embedded {
  height: 100%;
}
</style>
