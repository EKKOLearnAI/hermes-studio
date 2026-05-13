<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NSelect, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchPlugins, type HermesPluginInfo, type HermesPluginsMetadata } from '@/api/hermes/plugins'

const { t, te } = useI18n()
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

const statusValues = ['enabled', 'auto-active', 'inactive', 'disabled', 'provider-managed'] as const
const statusOptions = computed(() => statusValues.map(value => ({
  label: t(`plugins.status.${value}`),
  value,
})))

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
    error.value = err?.message || t('plugins.loadFailed')
  } finally {
    loading.value = false
  }
}

function statusLabel(plugin: HermesPluginInfo) {
  const key = `plugins.statusLabel.${plugin.effectiveStatus}`
  return te(key) ? t(key) : plugin.effectiveStatus
}

function configStatusLabel(plugin: HermesPluginInfo) {
  const key = `plugins.configStatuses.${plugin.configStatus}`
  return te(key) ? t(key) : plugin.configStatus
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
  message.success(t('plugins.commandCopied'))
}

onMounted(loadPlugins)
</script>

<template>
  <div class="plugins-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('plugins.title') }}</h2>
      <NButton size="small" quaternary :loading="loading" @click="loadPlugins">
        {{ t('plugins.refresh') }}
      </NButton>
    </header>

    <div class="plugins-content">
      <NAlert type="info" :bordered="false" class="plugins-notice">
        {{ t('plugins.notice') }}
      </NAlert>

      <NAlert v-if="error" type="error" class="plugins-notice">
        {{ error }}
      </NAlert>

      <NAlert v-for="warning in warnings" :key="warning" type="warning" class="plugins-notice">
        {{ warning }}
      </NAlert>

      <div class="summary-grid">
        <div class="summary-card">
          <span class="summary-label">{{ t('plugins.summary.total') }}</span>
          <strong>{{ summary.total }}</strong>
        </div>
        <div class="summary-card success">
          <span class="summary-label">{{ t('plugins.summary.active') }}</span>
          <strong>{{ summary.active }}</strong>
        </div>
        <div class="summary-card warning">
          <span class="summary-label">{{ t('plugins.summary.inactive') }}</span>
          <strong>{{ summary.inactive }}</strong>
        </div>
        <div class="summary-card error">
          <span class="summary-label">{{ t('plugins.summary.disabled') }}</span>
          <strong>{{ summary.disabled }}</strong>
        </div>
        <div class="summary-card info">
          <span class="summary-label">{{ t('plugins.summary.providerManaged') }}</span>
          <strong>{{ summary.providerManaged }}</strong>
        </div>
      </div>

      <div class="filter-row">
        <NInput v-model:value="searchQuery" :placeholder="t('plugins.searchPlaceholder')" clearable />
        <NSelect v-model:value="sourceFilter" :options="sourceOptions" :placeholder="t('plugins.source')" clearable />
        <NSelect v-model:value="kindFilter" :options="kindOptions" :placeholder="t('plugins.kind')" clearable />
        <NSelect v-model:value="statusFilter" :options="statusOptions" :placeholder="t('plugins.statusTitle')" clearable />
      </div>

      <NSpin :show="loading && plugins.length === 0">
        <div v-if="filteredPlugins.length" class="plugins-table-wrap">
          <table class="plugins-table">
            <thead>
              <tr>
                <th>{{ t('plugins.table.plugin') }}</th>
                <th>{{ t('plugins.table.status') }}</th>
                <th>{{ t('plugins.table.source') }}</th>
                <th>{{ t('plugins.table.kind') }}</th>
                <th>{{ t('plugins.table.capabilities') }}</th>
                <th>{{ t('plugins.table.path') }}</th>
                <th>{{ t('plugins.table.cli') }}</th>
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
                  <div class="config-status">{{ t('plugins.configStatus', { status: configStatusLabel(plugin) }) }}</div>
                </td>
                <td><NTag size="small" round>{{ plugin.source }}</NTag></td>
                <td><NTag size="small" round>{{ plugin.kind }}</NTag></td>
                <td>
                  <div class="capability-list">
                    <span>{{ t('plugins.capabilities.tools', { count: plugin.providesTools.length }) }}</span>
                    <span>{{ t('plugins.capabilities.hooks', { count: plugin.providesHooks.length }) }}</span>
                    <span>{{ t('plugins.capabilities.env', { count: plugin.requiresEnv.length }) }}</span>
                  </div>
                </td>
                <td><code class="path-cell">{{ plugin.path || t('plugins.notAvailable') }}</code></td>
                <td>
                  <NButton v-if="pluginCommand(plugin)" size="tiny" secondary @click="copyCommand(plugin)">
                    {{ t('plugins.copyCommand') }}
                  </NButton>
                  <span v-else class="muted">{{ t('plugins.managedElsewhere') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <NEmpty v-else-if="!loading" :description="t('plugins.noMatch')" />
      </NSpin>

      <div v-if="metadata" class="metadata-panel">
        <span>{{ t('plugins.metadata.agentRoot') }}: <code>{{ metadata.hermesAgentRoot }}</code></span>
        <span>{{ t('plugins.metadata.python') }}: <code>{{ metadata.pythonExecutable }}</code></span>
        <span>{{ t('plugins.metadata.scanCwd') }}: <code>{{ metadata.cwd }}</code></span>
        <span>{{ t('plugins.metadata.projectPlugins') }}: <code>{{ metadata.projectPluginsEnabled ? t('plugins.enabled') : t('plugins.disabled') }}</code></span>
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
