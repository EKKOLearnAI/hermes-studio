<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import yaml from 'js-yaml'
import {
  NAlert, NButton, NEmpty, NInput, NModal,
  NSpin, NRadioGroup, NRadioButton, useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import McpServerCard from '@/components/hermes/mcp/McpServerCard.vue'
import {
  fetchMcpServers, mcpServerAdd, mcpServerRemove,
  mcpServerUpdate, mcpServerTest, mcpReload,
  type McpServerInfo, type McpServerConfig,
} from '@/api/hermes/mcp'

const { t } = useI18n()
const message = useMessage()

const servers = ref<McpServerInfo[]>([])
const loading = ref(false)
const error = ref('')
const searchQuery = ref('')

const showModal = ref(false)
const modalMode = ref<'add' | 'edit'>('add')
const editingName = ref('')
const jsonText = ref('')
const jsonError = ref('')
const saving = ref(false)
const inputMode = ref<'json' | 'yaml'>('json')

const jsonPlaceholder = '{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]\n  }\n}'
const yamlPlaceholder = 'my-server:\n  command: npx\n  args:\n    - "-y"\n    - "@modelcontextprotocol/server-filesystem"\n    - "/path"'

const placeholder = computed(() => inputMode.value === 'json' ? jsonPlaceholder : yamlPlaceholder)

let formatTimer: ReturnType<typeof setTimeout> | null = null
let _pendingReload: ReturnType<typeof setTimeout> | null = null
let _autoRetryCount = 0
const MAX_AUTO_RETRIES = 5
const BASE_RETRY_DELAY = 2000 // 2s base

function scheduleReload(delay = 3000) {
  if (_pendingReload) clearTimeout(_pendingReload)
  _pendingReload = setTimeout(() => { _pendingReload = null; loadServers() }, delay)
}

onUnmounted(() => {
  if (formatTimer) { clearTimeout(formatTimer); formatTimer = null }
  if (_pendingReload) { clearTimeout(_pendingReload); _pendingReload = null }
})

function handleInput(text: string) {
  if (formatTimer) clearTimeout(formatTimer)
  if (!text.trim()) {
    jsonError.value = ''
    return
  }
  const { data, error: parseErr } = parseConfig(text)
  if (parseErr) {
    jsonError.value = parseErr
    return
  }
  const { servers: extracted, error: extractErr } = extractServers(data)
  if (extractErr) {
    jsonError.value = extractErr
    return
  }
  jsonError.value = ''
  formatTimer = setTimeout(() => {
    const formatted = inputMode.value === 'json'
      ? JSON.stringify(extracted, null, 2)
      : yaml.dump(extracted, { indent: 2, lineWidth: -1 }).trimEnd()
    if (formatted !== text) jsonText.value = formatted
  }, 1500)
}

function handleModeChange(mode: 'json' | 'yaml') {
  if (!jsonText.value.trim()) return
  // Try to parse current content in old format
  const oldMode = mode === 'json' ? 'yaml' : 'json'
  let data: Record<string, unknown> | null = null
  try {
    if (oldMode === 'json') {
      data = JSON.parse(jsonText.value)
    } else {
      data = yaml.load(jsonText.value, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>
    }
  } catch {
    // If parse fails, try the new format
    try {
      if (mode === 'json') {
        data = JSON.parse(jsonText.value)
      } else {
        data = yaml.load(jsonText.value, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>
      }
    } catch {
      return
    }
  }
  if (!data || typeof data !== 'object') return
  // Convert to new format
  if (mode === 'json') {
    jsonText.value = JSON.stringify(data, null, 2)
  } else {
    jsonText.value = yaml.dump(data, { indent: 2, lineWidth: -1 }).trimEnd()
  }
  jsonError.value = ''
}

function parseConfig(text: string): { data: Record<string, unknown> | null; error: string } {
  if (inputMode.value === 'json') {
    try {
      const obj = JSON.parse(text)
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        return { data: null, error: t('mcp.invalidJson') }
      }
      return { data: obj, error: '' }
    } catch {
      return { data: null, error: t('mcp.invalidJson') }
    }
  } else {
    try {
      const obj = yaml.load(text, { schema: yaml.JSON_SCHEMA })
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        return { data: null, error: t('mcp.invalidYaml') }
      }
      return { data: obj as Record<string, unknown>, error: '' }
    } catch (e: any) {
      return { data: null, error: `${t('mcp.invalidYaml')}: ${e.message || ''}` }
    }
  }
}

function extractServers(data: Record<string, unknown> | null): { servers: Record<string, unknown>; error: string } {
  if (!data) return { servers: {}, error: t('mcp.invalidConfig') }
  // Unwrap mcpServers/mcp_servers wrapper
  if (data.mcpServers && typeof data.mcpServers === 'object' && !data.command) {
    return { servers: data.mcpServers as Record<string, unknown>, error: '' }
  }
  if (data.mcp_servers && typeof data.mcp_servers === 'object' && !data.command) {
    return { servers: data.mcp_servers as Record<string, unknown>, error: '' }
  }
  return { servers: data, error: '' }
}

function validateServerConfig(name: string, config: unknown): string | null {
  if (typeof config !== 'object' || config === null) {
    return `${name}: ${t('mcp.invalidServerConfig')}`
  }
  const cfg = config as Record<string, unknown>
  if (!cfg.command && !cfg.url) {
    return `${name}: ${t('mcp.missingCommandOrUrl')}`
  }
  return null
}

function parseAndValidate(text: string): { servers: Record<string, unknown>; error: string } {
  const { data, error: parseErr } = parseConfig(text)
  if (parseErr) return { servers: {}, error: parseErr }
  const { servers, error: extractErr } = extractServers(data)
  if (extractErr) return { servers: {}, error: extractErr }
  // Validate each server has command or url
  for (const [name, config] of Object.entries(servers)) {
    const err = validateServerConfig(name, config)
    if (err) return { servers: {}, error: err }
  }
  return { servers, error: '' }
}

const toolsByServer = ref<Record<string, {name: string, description: string}[]>>({})

const summary = computed(() => {
  let connected = 0, totalTools = 0
  for (const s of servers.value) {
    if (s.connected) connected++
    totalTools += s.tools_registered
  }
  return { total: servers.value.length, connected, disconnected: servers.value.length - connected, totalTools }
})

const filteredServers = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return servers.value
  return servers.value.filter(s =>
    s.name.toLowerCase().includes(query) ||
    s.transport.includes(query) ||
    s.tool_names.some(n => n.toLowerCase().includes(query))
  )
})

async function loadServers() {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchMcpServers()
    servers.value = data.servers ?? []
    // Populate toolsByServer from embedded tool_details
    for (const s of servers.value) {
      if (s.tool_details?.length) {
        toolsByServer.value[s.name] = s.tool_details.map(t => ({
          name: t.name,
          description: t.description || '',
        }))
      }
    }
    // Auto-retry with exponential backoff if enabled servers are still disconnected
    const hasPending = servers.value.some(s => s.raw_config.enabled !== false && !s.connected)
    if (hasPending && _autoRetryCount < MAX_AUTO_RETRIES) {
      const delay = BASE_RETRY_DELAY * Math.pow(2, _autoRetryCount) // 2s, 4s, 8s, 16s, 32s
      _autoRetryCount++
      scheduleReload(delay)
    } else {
      _autoRetryCount = 0
    }
  } catch (err: any) {
    error.value = err?.message || t('mcp.loadFailed')
  } finally {
    loading.value = false
  }
}

async function handleReload(server?: string) {
  try {
    const res = await mcpReload(server)
    if (res.ok) {
      if (server) {
        const { [server]: _, ...rest } = toolsByServer.value
        toolsByServer.value = rest
      } else {
        toolsByServer.value = {}
      }
      message.success(server ? t('mcp.reloaded', { server }) : t('mcp.reloadedAll'))
      scheduleReload()
    } else {
      message.error(res.error || t('mcp.reloadFailed'))
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.reloadFailed'))
  }
}

function openAddModal() {
  modalMode.value = 'add'
  editingName.value = ''
  jsonText.value = ''
  jsonError.value = ''
  inputMode.value = 'json'
  showModal.value = true
}

function openEditModal(server: McpServerInfo) {
  modalMode.value = 'edit'
  editingName.value = server.name
  const serverConfig = { [server.name]: server.raw_config }
  jsonText.value = inputMode.value === 'yaml'
    ? yaml.dump(serverConfig, { indent: 2, lineWidth: -1 }).trimEnd()
    : JSON.stringify(serverConfig, null, 2)
  jsonError.value = ''
  showModal.value = true
}

async function saveServer() {
  if (formatTimer) { clearTimeout(formatTimer); formatTimer = null }
  const { servers: parsed, error: validationErr } = parseAndValidate(jsonText.value)
  if (validationErr) {
    jsonError.value = validationErr
    return
  }
  jsonError.value = ''
  saving.value = true
  try {
    if (modalMode.value === 'add') {
      // Expect: { "server-name": { "command": "...", ... } }
      const entries = Object.entries(parsed)
      if (entries.length === 0) {
        jsonError.value = t('mcp.invalidConfig')
        saving.value = false
        return
      }
      let added = 0
      for (const [name, config] of entries) {
        if (typeof config !== 'object' || config === null) continue
        const res = await mcpServerAdd(name, config as McpServerConfig)
        if (res.ok) added++
        else message.error(`${name}: ${res.error || t('mcp.addFailed')}`)
      }
      if (added > 0) {
        showModal.value = false
        message.success(t('mcp.serverAdded', { name: `${added} server(s)` }))
        // Immediately show server from config (disconnected)
        await loadServers()
        // Delayed refresh to show updated connection status after discovery
        scheduleReload()
      }
    } else {
      const name = editingName.value
      // For edit, config can be flat or wrapped: { "name": { ... } }
      const config = (parsed[name] && typeof parsed[name] === 'object')
        ? parsed[name] as Record<string, unknown>
        : parsed
      const res = await mcpServerUpdate(name, config)
      if (res.ok) {
        showModal.value = false
        message.success(t('mcp.serverUpdated', { name: editingName.value }))
        // Immediately show updated config
        await loadServers()
        // Delayed refresh to show reconnection status
        scheduleReload()
      } else {
        message.error(res.error || t('mcp.updateFailed'))
      }
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function handleRemove(server: McpServerInfo) {
  try {
    const res = await mcpServerRemove(server.name)
    if (res.ok) {
      message.success(t('mcp.serverRemoved', { name: server.name }))
      const { [server.name]: _, ...rest } = toolsByServer.value
      toolsByServer.value = rest
      await loadServers()
    } else {
      message.error(res.error || t('mcp.removeFailed'))
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.removeFailed'))
  }
}

async function handleToggleEnabled(server: McpServerInfo) {
  const newValue = !server.raw_config.enabled
  try {
    const config = { ...server.raw_config, enabled: newValue }
    const res = await mcpServerUpdate(server.name, config)
    if (res.ok) {
      message.success(t(newValue ? 'mcp.enabled' : 'mcp.disabled', { name: server.name }))
      const { [server.name]: _, ...rest } = toolsByServer.value
      toolsByServer.value = rest
      await mcpReload(server.name)
      scheduleReload()
    } else {
      message.error(res.error || t('mcp.updateFailed'))
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.updateFailed'))
  }
}

async function handleTest(server: McpServerInfo) {
  try {
    const res = await mcpServerTest(server.name)
    if (res.ok && res.tools) {
      message.success(t('mcp.testOk', { count: res.tools.length }), { duration: 3000 })
    } else {
      message.warning(res.error || t('mcp.testEmpty'))
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.testFailed'))
  }
}


void loadServers()
</script>

<template>
  <div class="mcp-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('mcp.title') }}</h2>
      <div class="header-actions">
        <NButton size="small" quaternary :loading="loading" @click="_autoRetryCount = 0; loadServers()">
          {{ t('mcp.refresh') }}
        </NButton>
      </div>
    </header>

    <div class="mcp-content">
      <NAlert v-if="error" type="error" class="mcp-notice">
        {{ error }}
      </NAlert>

      <div class="summary-grid">
        <div class="summary-card">
          <span class="summary-label">{{ t('mcp.total') }}</span>
          <strong>{{ summary.total }}</strong>
        </div>
        <div class="summary-card success">
          <span class="summary-label">{{ t('mcp.connected') }}</span>
          <strong>{{ summary.connected }}</strong>
        </div>
        <div class="summary-card warning">
          <span class="summary-label">{{ t('mcp.disconnected') }}</span>
          <strong>{{ summary.disconnected }}</strong>
        </div>
        <div class="summary-card info">
          <span class="summary-label">{{ t('mcp.tool') }}</span>
          <strong>{{ summary.totalTools }}</strong>
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
          <NButton size="small" type="primary" @click="handleReload()">
            {{ t('mcp.reloadAll') }}
          </NButton>
          <NButton type="primary" size="small" @click="openAddModal">
            {{ t('mcp.addServer') }}
          </NButton>
        </div>
      </div>

      <NSpin :show="loading && servers.length === 0">
        <div v-if="filteredServers.length" class="servers-grid">
          <McpServerCard
            v-for="server in filteredServers"
            :key="server.name"
            :server="server"
            :tools-by-server="toolsByServer"
            @edit="openEditModal"
            @test="handleTest"
            @reload="handleReload"
            @remove="handleRemove"
            @toggle-enabled="handleToggleEnabled"
          />
        </div>
        <NEmpty v-else-if="!loading" :description="t('mcp.empty')" />
      </NSpin>
    </div>

    <NModal v-model:show="showModal" :title="modalMode === 'add' ? t('mcp.addTitle') : t('mcp.editTitle')" preset="card" :style="{ width: 'min(520px, calc(100vw - 32px))' }">
      <div class="mode-switch-row">
        <NRadioGroup v-model:value="inputMode" size="small" @update:value="handleModeChange">
          <NRadioButton value="json">JSON</NRadioButton>
          <NRadioButton value="yaml">YAML</NRadioButton>
        </NRadioGroup>
      </div>
      <NInput
        v-model:value="jsonText"
        type="textarea"
        :rows="16"
        class="config-textarea"
        :placeholder="placeholder"
        :status="jsonError ? 'error' : undefined"
        @input="handleInput"
      />
      <div v-if="jsonError" class="config-error">{{ jsonError }}</div>
      <div class="modal-actions">
        <NButton @click="showModal = false">{{ t('mcp.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="saveServer">
          {{ modalMode === 'add' ? t('mcp.add') : t('mcp.save') }}
        </NButton>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.mcp-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.mcp-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.page-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
}

.header-title {
  margin: 0;
  color: $text-primary;
  font-size: 16px;
  font-weight: 600;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 80px;
  justify-content: flex-end;
}

.mcp-notice {
  margin-bottom: 14px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.summary-card {
  padding: 14px;
  border: 1px solid $border-color;
  border-radius: 12px;
  background: $bg-secondary;
  display: flex;
  flex-direction: column;
  gap: 6px;

  strong {
    font-size: 24px;
    line-height: 1;
  }

  &.success strong { color: $success; }
  &.warning strong { color: $warning; }
  &.error strong { color: $error; }
  &.info strong { color: $accent-primary; }
}

.summary-label {
  font-size: 11px;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.toolbar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;

  .search-input {
    flex: 1;
    min-width: 0;
    max-width: 360px;
  }
}

.btn-group {
  display: flex;
  gap: 8px;
  flex-shrink: 1;
  min-width: 0;

  .n-button {
    flex: 1;
    white-space: nowrap;
  }
}

.servers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
  gap: 14px;
}

.mode-switch-row {
  display: flex;
  justify-content: center;
  margin-bottom: 8px;
}

.config-textarea {
  font-family: monospace;
  font-size: 13px;
}

.config-error {
  color: var(--n-error-color);
  font-size: 12px;
  margin-top: 4px;
}

.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}

@media (max-width: $breakpoint-mobile) {
  .summary-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .toolbar-row {
    flex-direction: column;
    align-items: stretch;

    .search-input {
      max-width: none;
    }

    .btn-group {
      width: 100%;
    }
  }

  .servers-grid {
    grid-template-columns: 1fr;
  }
}
</style>
