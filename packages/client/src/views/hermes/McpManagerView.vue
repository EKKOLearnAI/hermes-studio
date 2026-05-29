<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import yaml from 'js-yaml'
import {
  NAlert, NButton, NEmpty, NInput, NModal,
  NSpin, NSwitch, NTag, NPopconfirm, NPopover, NSpace, NRadioGroup, NRadioButton, useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchMcpServers, fetchMcpTools, mcpServerAdd, mcpServerRemove,
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
const loadingTools = ref('')

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
      if (server) delete toolsByServer.value[server]
      else toolsByServer.value = {}
      message.success(server ? t('mcp.reloaded', { server }) : t('mcp.reloadedAll'))
      await loadServers()
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
  const config: Record<string, unknown> = {}
  if (server.command) config.command = server.command
  if (server.args?.length) config.args = server.args
  if (server.url) config.url = server.url
  if (server.env && Object.keys(server.env).length) config.env = server.env
  if (server.headers && Object.keys(server.headers).length) config.headers = server.headers
  if (server.tools_config) config.tools = server.tools_config
  if (server.prompts !== undefined && server.prompts !== null) config.prompts = server.prompts
  if (server.resources !== undefined && server.resources !== null) config.resources = server.resources
  const serverConfig = { [server.name]: config }
  // Format based on current input mode
  if (inputMode.value === 'yaml') {
    jsonText.value = yaml.dump(serverConfig, { indent: 2, lineWidth: -1 }).trimEnd()
  } else {
    jsonText.value = JSON.stringify(serverConfig, null, 2)
  }
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
      delete toolsByServer.value[server.name]
      await loadServers()
    } else {
      message.error(res.error || t('mcp.removeFailed'))
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.removeFailed'))
  }
}

async function handleToggleEnabled(server: McpServerInfo) {
  const newValue = !server.enabled
  try {
    const res = await mcpServerUpdate(server.name, { enabled: newValue })
    if (res.ok) {
      message.success(t(newValue ? 'mcp.enabled' : 'mcp.disabled', { name: server.name }))
      delete toolsByServer.value[server.name]
      await loadServers()
      // Reload to apply
      const reloadRes = await mcpReload(server.name)
      if (!reloadRes.ok) message.warning(reloadRes.error || t('mcp.reloadFailed'))
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

async function showTools(server: McpServerInfo) {
  if (toolsByServer.value[server.name]) return
  loadingTools.value = server.name
  try {
    const res = await fetchMcpTools(server.name)
    const entry = res.results?.find(r => r.server === server.name)
    toolsByServer.value[server.name] = entry?.tools?.map((tool) => ({
      name: tool.name || '?',
      description: tool.description || ''
    })) || []
  } catch (err) {
    console.warn('[MCP] Failed to load tools for', server.name, err)
    toolsByServer.value[server.name] = []
  } finally {
    loadingTools.value = ''
  }
}

function statusType(server: McpServerInfo): 'success' | 'error' | 'warning' {
  if (server.connected) return 'success'
  if (server.error) return 'error'
  return 'warning'
}

function statusLabel(server: McpServerInfo): string {
  if (server.connected) return t('mcp.connected')
  if (server.error) return t('mcp.error')
  return t('mcp.disconnected')
}

void loadServers()
</script>

<template>
  <div class="mcp-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('mcp.title') }}</h2>
      <NSpace>
        <NButton size="small" secondary @click="handleReload()">
          {{ t('mcp.reloadAll') }}
        </NButton>
        <NButton size="small" quaternary :loading="loading" @click="loadServers">
          {{ t('mcp.refresh') }}
        </NButton>
      </NSpace>
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
          <span class="summary-label">{{ t('mcp.tools') }}</span>
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
        <NButton type="primary" size="small" @click="openAddModal">
          {{ t('mcp.addServer') }}
        </NButton>
      </div>

      <NSpin :show="loading && servers.length === 0">
        <div v-if="filteredServers.length" class="table-wrap">
          <table class="mcp-table" :aria-label="t('mcp.title')">
            <thead>
              <tr>
                <th scope="col">{{ t('mcp.tableName') }}</th>
                <th scope="col">{{ t('mcp.tableTransport') }}</th>
                <th scope="col">{{ t('mcp.tableStatus') }}</th>
                <th scope="col">{{ t('mcp.tableEnabled') }}</th>
                <th scope="col">{{ t('mcp.tableTools') }}</th>
                <th scope="col">{{ t('mcp.tableActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="server in filteredServers" :key="server.name">
                <td>
                  <strong>{{ server.name }}</strong>
                  <div v-if="server.error" class="error-detail">{{ server.error }}</div>
                </td>
                <td>
                  <NTag size="small" round>{{ server.transport }}</NTag>
                </td>
                <td>
                  <NTag size="small" :type="statusType(server)">{{ statusLabel(server) }}</NTag>
                </td>
                <td>
                  <NSwitch
                    :value="server.enabled !== false"
                    size="small"
                    @update:value="() => handleToggleEnabled(server)"
                  />
                </td>
                <td>
                  <NPopover
                    v-if="server.tools > 0"
                    trigger="hover"
                    class="tool-popover"
                    @update:show="(v: boolean) => v && showTools(server)"
                  >
                    <template #trigger>
                      <span v-if="server.tools_registered < server.tools" class="tools-link">
                        {{ t('mcp.toolsFiltered', { registered: server.tools_registered, total: server.tools }) }}
                      </span>
                      <span v-else class="tools-link">{{ t('mcp.toolsCount', { count: server.tools }) }}</span>
                    </template>
                    <div v-if="loadingTools === server.name" class="tool-popover-loading">{{ t('mcp.loading') }}</div>
                    <div v-else-if="toolsByServer[server.name]?.length" class="tool-list">
                      <div v-for="tool in toolsByServer[server.name]" :key="tool.name" class="tool-item">
                        <div class="tool-name">{{ tool.name }}</div>
                        <div v-if="tool.description" class="tool-desc">{{ tool.description }}</div>
                      </div>
                    </div>
                    <div v-else class="tool-popover-loading">{{ t('mcp.noTools') }}</div>
                  </NPopover>
                  <span v-else class="muted">{{ t('mcp.zeroTools') }}</span>
                </td>
                <td>
                  <NSpace>
                    <NButton size="tiny" secondary @click="openEditModal(server)">{{ t('mcp.edit') }}</NButton>
                    <NButton size="tiny" secondary @click="handleTest(server)">{{ t('mcp.test') }}</NButton>
                    <NButton size="tiny" secondary @click="handleReload(server.name)">{{ t('mcp.reload') }}</NButton>
                    <NPopconfirm @positive-click="handleRemove(server)">
                      <template #trigger>
                        <NButton size="tiny" secondary type="error">{{ t('mcp.remove') }}</NButton>
                      </template>
                      {{ t('mcp.confirmRemove', { name: server.name }) }}
                    </NPopconfirm>
                  </NSpace>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <NEmpty v-else-if="!loading" :description="t('mcp.empty')" />
      </NSpin>
    </div>

    <NModal v-model:show="showModal" :title="modalMode === 'add' ? t('mcp.addTitle') : t('mcp.editTitle')" preset="card" class="modal-card">
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

.mcp-notice {
  margin-bottom: 14px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
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
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;

  .search-input {
    flex: 1;
    max-width: 360px;
  }
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid $border-color;
  border-radius: 12px;
  background: $bg-secondary;
}

.mcp-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 640px;

  th, td {
    padding: 12px;
    border-bottom: 1px solid $border-color;
    text-align: left;
    vertical-align: top;
    font-size: 13px;
  }

  th {
    color: $text-muted;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: rgba(var(--accent-primary-rgb), 0.04);
  }

  tr:last-child td {
    border-bottom: none;
  }
}

.error-detail {
  margin-top: 4px;
  color: $error;
  font-size: 11px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tools-link {
  cursor: pointer;
  color: $accent-primary;
  text-decoration: underline;
  text-decoration-style: dotted;

  &:hover {
    text-decoration-style: solid;
  }
}

.muted {
  color: var(--n-text-color-3);
  font-size: 12px;
}

.modal-card {
  width: 580px;
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
</style>

<style lang="scss">
/* Popover styles — must be unscoped because NPopover teleports to <body> */
.mcp-view .tool-popover {
  max-width: 400px;
}

.mcp-view .tool-list {
  max-height: 200px;
  overflow-y: auto;
}

.mcp-view .tool-item {
  font-size: 12px;
  padding: 3px 0;
  border-bottom: 1px solid rgba(var(--text-muted-rgb, 128,128,128), 0.15);

  &:last-child { border-bottom: none; }

  .tool-name {
    font-weight: 500;
    color: var(--n-text-color);
  }

  .tool-desc {
    font-size: 11px;
    color: var(--n-text-color-3);
    margin-top: 2px;
    line-height: 1.4;
    white-space: normal;
    word-break: break-word;
  }
}

.mcp-view .tool-popover-loading {
  font-size: 12px;
  color: var(--n-text-color-3);
  padding: 4px 0;
}
</style>
