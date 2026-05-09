<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NSelect, NSpin, NTag, useMessage } from 'naive-ui'
import { fetchPlugins, type HermesPluginInfo, type HermesPluginsMetadata } from '@/api/hermes/plugins'

const message = useMessage()

const plugins = ref<HermesPluginInfo[]>([])
const warnings = ref<string[]>([])
const metadata = ref<HermesPluginsMetadata | null>(null)
const loading = ref(false)
const error = ref('')

const searchQuery = ref('')
const sourceFilter = ref<string | null>(null)
const kindFilter = ref<string | null>(null)
const statusFilter = ref<string | null>(null)

const statusOptions = [
  { label: 'Enabled', value: 'enabled' },
  { label: 'Auto-active', value: 'auto-active' },
  { label: 'Inactive', value: 'inactive' },
  { label: 'Disabled', value: 'disabled' },
  { label: 'Provider-managed', value: 'provider-managed' },
]

const sourceOptions = computed(() => toOptions(plugins.value.map(p => p.source)))
const kindOptions = computed(() => toOptions(plugins.value.map(p => p.kind)))

const summary = computed(() => ({
  total: plugins.value.length,
  active: plugins.value.filter(p => p.effectiveStatus === 'enabled' || p.effectiveStatus === 'auto-active').length,
  inactive: plugins.value.filter(p => p.effectiveStatus === 'inactive').length,
  disabled: plugins.value.filter(p => p.effectiveStatus === 'disabled').length,
  providerManaged: plugins.value.filter(p => p.effectiveStatus === 'provider-managed').length,
}))

const filteredPlugins = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return plugins.value.filter((plugin) => {
    if (sourceFilter.value && plugin.source !== sourceFilter.value) return false
    if (kindFilter.value && plugin.kind !== kindFilter.value) return false
    if (statusFilter.value && plugin.effectiveStatus !== statusFilter.value) return false
    if (!query) return true
    return [plugin.key, plugin.name, plugin.description, plugin.path, plugin.source, plugin.kind]
      .some(value => String(value || '').toLowerCase().includes(query))
  })
})

function toOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b)).map(value => ({
    label: value,
    value,
  }))
}

async function loadPlugins() {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchPlugins()
    plugins.value = data.plugins ?? []
    warnings.value = data.warnings ?? []
    metadata.value = data.metadata ?? null
  } catch (err: any) {
    error.value = err?.message || 'Failed to load plugins'
  } finally {
    loading.value = false
  }
}

function statusLabel(plugin: HermesPluginInfo) {
  switch (plugin.effectiveStatus) {
    case 'enabled': return 'Enabled by config'
    case 'auto-active': return 'Auto-active'
    case 'disabled': return 'Disabled'
    case 'provider-managed': return 'Provider-managed'
    default: return 'Inactive'
  }
}

function statusTagType(plugin: HermesPluginInfo): 'success' | 'warning' | 'error' | 'info' | 'default' {
  switch (plugin.effectiveStatus) {
    case 'enabled':
    case 'auto-active':
      return 'success'
    case 'disabled':
      return 'error'
    case 'provider-managed':
      return 'info'
    default:
      return 'warning'
  }
}

function pluginCommand(plugin: HermesPluginInfo) {
  const escapedKey = plugin.key.replace(/'/g, `'\\''`)
  if (plugin.effectiveStatus === 'disabled' || plugin.effectiveStatus === 'inactive') {
    return `hermes plugins enable '${escapedKey}'`
  }
  if (plugin.effectiveStatus === 'enabled') {
    return `hermes plugins disable '${escapedKey}'`
  }
  return ''
}

async function copyCommand(plugin: HermesPluginInfo) {
  const command = pluginCommand(plugin)
  if (!command) return
  await navigator.clipboard.writeText(command)
  message.success('Command copied')
}

onMounted(loadPlugins)
</script>

<template>
  <div class="plugins-view">
    <header class="page-header">
      <div>
        <h2 class="header-title">Plugins</h2>
        <p class="header-subtitle">Read-only inventory of discoverable Hermes plugin manifests.</p>
      </div>
      <NButton size="small" :loading="loading" @click="loadPlugins">
        Refresh
      </NButton>
    </header>

    <div class="plugins-content">
      <NAlert type="info" :bordered="false" class="plugins-notice">
        This page uses Hermes Agent discovery metadata without loading plugin code. Management actions stay in CLI for v1; changes take effect in new Hermes sessions.
      </NAlert>

      <NAlert v-if="error" type="error" class="plugins-notice">
        {{ error }}
      </NAlert>

      <NAlert v-for="warning in warnings" :key="warning" type="warning" class="plugins-notice">
        {{ warning }}
      </NAlert>

      <div class="summary-grid">
        <div class="summary-card">
          <span class="summary-label">Total</span>
          <strong>{{ summary.total }}</strong>
        </div>
        <div class="summary-card success">
          <span class="summary-label">Enabled / auto</span>
          <strong>{{ summary.active }}</strong>
        </div>
        <div class="summary-card warning">
          <span class="summary-label">Inactive</span>
          <strong>{{ summary.inactive }}</strong>
        </div>
        <div class="summary-card error">
          <span class="summary-label">Disabled</span>
          <strong>{{ summary.disabled }}</strong>
        </div>
        <div class="summary-card info">
          <span class="summary-label">Provider-managed</span>
          <strong>{{ summary.providerManaged }}</strong>
        </div>
      </div>

      <div class="filter-row">
        <NInput v-model:value="searchQuery" placeholder="Search key, name, description, path..." clearable />
        <NSelect v-model:value="sourceFilter" :options="sourceOptions" placeholder="Source" clearable />
        <NSelect v-model:value="kindFilter" :options="kindOptions" placeholder="Kind" clearable />
        <NSelect v-model:value="statusFilter" :options="statusOptions" placeholder="Status" clearable />
      </div>

      <NSpin :show="loading && plugins.length === 0">
        <div v-if="filteredPlugins.length" class="plugins-table-wrap">
          <table class="plugins-table">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Status</th>
                <th>Source</th>
                <th>Kind</th>
                <th>Capabilities</th>
                <th>Path / entrypoint</th>
                <th>CLI</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="plugin in filteredPlugins" :key="plugin.key">
                <td>
                  <div class="plugin-name">
                    <strong>{{ plugin.key }}</strong>
                    <span v-if="plugin.name !== plugin.key">{{ plugin.name }}</span>
                  </div>
                  <div v-if="plugin.description" class="description">{{ plugin.description }}</div>
                  <div v-if="plugin.version || plugin.author" class="meta-line">
                    <span v-if="plugin.version">v{{ plugin.version }}</span>
                    <span v-if="plugin.author">{{ plugin.author }}</span>
                  </div>
                </td>
                <td>
                  <NTag size="small" :type="statusTagType(plugin)">{{ statusLabel(plugin) }}</NTag>
                  <div class="config-status">config: {{ plugin.configStatus }}</div>
                </td>
                <td><NTag size="small" round>{{ plugin.source }}</NTag></td>
                <td><NTag size="small" round>{{ plugin.kind }}</NTag></td>
                <td>
                  <div class="capability-list">
                    <span>{{ plugin.providesTools.length }} tools</span>
                    <span>{{ plugin.providesHooks.length }} hooks</span>
                    <span>{{ plugin.requiresEnv.length }} env</span>
                  </div>
                </td>
                <td><code class="path-cell">{{ plugin.path || 'n/a' }}</code></td>
                <td>
                  <NButton v-if="pluginCommand(plugin)" size="tiny" secondary @click="copyCommand(plugin)">
                    Copy command
                  </NButton>
                  <span v-else class="muted">managed elsewhere</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <NEmpty v-else-if="!loading" description="No plugins match the current filters" />
      </NSpin>

      <div v-if="metadata" class="metadata-panel">
        <span>Agent root: <code>{{ metadata.hermesAgentRoot }}</code></span>
        <span>Python: <code>{{ metadata.pythonExecutable }}</code></span>
        <span>Scan cwd: <code>{{ metadata.cwd }}</code></span>
        <span>Project plugins: <code>{{ metadata.projectPluginsEnabled ? 'enabled' : 'disabled' }}</code></span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.plugins-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.header-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: $text-muted;
}

.plugins-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.plugins-notice {
  margin-bottom: 14px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(120px, 1fr));
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

.filter-row {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) repeat(3, minmax(140px, 180px));
  gap: 10px;
  margin-bottom: 16px;
}

.plugins-table-wrap {
  overflow-x: auto;
  border: 1px solid $border-color;
  border-radius: 12px;
  background: $bg-secondary;
}

.plugins-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 980px;

  th,
  td {
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

.plugin-name {
  display: flex;
  flex-direction: column;
  gap: 2px;

  span {
    color: $text-muted;
    font-size: 12px;
  }
}

.description {
  margin-top: 6px;
  color: $text-secondary;
  max-width: 420px;
}

.meta-line,
.config-status,
.muted {
  margin-top: 6px;
  color: $text-muted;
  font-size: 11px;
}

.meta-line {
  display: flex;
  gap: 8px;
}

.capability-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: $text-secondary;
}

.path-cell {
  display: inline-block;
  max-width: 320px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: $text-muted;
  background: rgba(var(--accent-primary-rgb), 0.06);
  padding: 2px 6px;
  border-radius: 6px;
}

.metadata-panel {
  margin-top: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  color: $text-muted;
  font-size: 11px;

  code {
    color: $text-secondary;
  }
}

@media (max-width: 900px) {
  .summary-grid,
  .filter-row {
    grid-template-columns: 1fr;
  }
}
</style>
