<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NEmpty, NInput, NPopconfirm, NSelect, NSpin, NTag } from 'naive-ui'
import { changeDshPlugins, readDshPlugins, type DshPluginChange, type DshPluginSnapshot } from '@/api/dsh-plugins'

import DshNativePluginsPanel from './DshNativePluginsPanel.vue'

const nativePanel = ref<InstanceType<typeof DshNativePluginsPanel>>()
const { t } = useI18n()
const data = ref<DshPluginSnapshot | null>(null)
const loading = ref(true)
const sending = ref(false)
const error = ref('')
const spec = ref('')
const mode = ref<'install' | 'update'>('install')
const draft = ref('[]\n')
const draftBase = ref('[]\n')
const draftRevision = ref('empty')
const conflict = ref(false)
const rollback = ref<string | null>(null)
const dirty = computed(() => draft.value !== draftBase.value)
const busy = computed(() => sending.value || !!data.value?.operations.some(operation => operation.status === 'running'))
const histories = computed(() => (data.value?.revisions || []).slice().reverse().map(revision => ({
  value: revision.id, label: new Date(revision.createdAt).toLocaleString(), disabled: revision.id === data.value?.activeRevision,
})))
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let refreshSequence = 0
let submittedConfig: { id: string; content: string } | null = null
let attempt: { value: string; key: string } | null = null

function failure(code?: string) {
  const key = code === 'DSH_REVISION_CHANGED' ? 'conflict' : code === 'DSH_DEPENDENCY_UNAVAILABLE' ? 'missingDependency'
    : code === 'DSH_OPERATION_CONFLICT' ? 'busy' : code === 'DSH_OPERATION_INTERRUPTED' ? 'interrupted'
      : code === 'DSH_CAPABILITY_UNSUPPORTED' ? 'unsupported' : code === 'DSH_SELECTION_INVALID' ? 'invalid'
        : code === 'DSH_OPERATION_TIMEOUT' ? 'timeout' : 'failed'
  return t(`dshPlugins.${key}`)
}
function resetDraft() {
  if (!data.value) return
  draft.value = draftBase.value = data.value.content
  draftRevision.value = data.value.revision
  conflict.value = false
}
async function refresh() {
  clearTimeout(timer)
  const sequence = ++refreshSequence
  try {
    const snapshot = await readDshPlugins()
    if (disposed || sequence !== refreshSequence) return
    data.value = snapshot
    if (submittedConfig) {
      const operation = snapshot.operations.find(op => op.id === submittedConfig!.id)
      if (operation?.status === 'succeeded') {
        draftBase.value = submittedConfig.content
        draftRevision.value = operation.revision || snapshot.revision
        conflict.value = false
        submittedConfig = null
      } else if (operation?.status === 'failed') submittedConfig = null
    }
    if (!dirty.value && !conflict.value) resetDraft()
    if (snapshot.operations.some(operation => operation.status === 'running')) timer = setTimeout(refresh, 1000)
  } catch (err: any) { if (!disposed && sequence === refreshSequence) error.value = failure(err?.code) }
  finally { if (sequence === refreshSequence) loading.value = false }
}
async function change(change: DshPluginChange) {
  if (!data.value || busy.value) return
  error.value = ''; sending.value = true
  const value = JSON.stringify(change)
  if (!attempt || attempt.value !== value) attempt = { value, key: `plugin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }
  try {
    const operation = await changeDshPlugins(change, change.action === 'configure' ? draftRevision.value : data.value.revision, attempt.key)
    if (change.action === 'configure') submittedConfig = { id: operation.id, content: change.content }
    attempt = null
    // Keep the draft until the operation succeeds; background failure must not
    // erase it or make the editor appear saved.
    await refresh()
  } catch (err: any) {
    error.value = failure(err?.code)
    if (err?.status && err.status < 500) attempt = null
    if (err?.code === 'DSH_REVISION_CHANGED') { conflict.value = true; await refresh() }
  } finally { sending.value = false }
}
function prepareUpdate(name: string, version: string) { mode.value = 'update'; spec.value = `${name}@${version}` }
onMounted(refresh)
onUnmounted(() => { disposed = true; clearTimeout(timer) })
</script>

<template>
  <div class="plugins-view dsh-plugins" data-testid="dsh-plugins">
    <header class="page-header"><h2 class="header-title">{{ t('dshPlugins.title') }}</h2><NButton size="small" quaternary :loading="loading" @click="refresh(); nativePanel?.refresh()">{{ t('mcp.refresh') }}</NButton></header>
    <div class="plugins-content">
    <DshNativePluginsPanel ref="nativePanel" />
    <details class="managed-packages" data-testid="managed-packages"><summary>{{ t('dshPlugins.additionalPackages') }}</summary><div class="managed-content">
    <NAlert type="info" :show-icon="false">{{ t('dshPlugins.description') }}</NAlert>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NSpin v-if="loading" />
    <template v-else-if="data">
      <section>
        <h3>{{ t('dshPlugins.packages') }}</h3>
        <form class="install-row" @submit.prevent="change({ action: mode, packageSpec: spec.trim() })">
          <NSelect v-model:value="mode" :disabled="busy" :options="[{ label: t('dshPlugins.install'), value: 'install' }, { label: t('dshPlugins.update'), value: 'update' }]" class="mode" :aria-label="t('dshPlugins.action')" />
          <NInput v-model:value="spec" :disabled="busy" placeholder="@example/plugin@1.2.3" :input-props="{ 'aria-label': t('dshPlugins.packageSpec') }" />
          <NButton attr-type="submit" type="primary" :disabled="busy || !spec.trim()">{{ t(`dshPlugins.${mode}`) }}</NButton>
        </form>
        <p class="hint">{{ t('dshPlugins.installHint') }}</p>
        <NEmpty v-if="!data.packages.length" :description="t('dshPlugins.empty')" />
        <article v-for="pkg in data.packages" :key="pkg.name" class="package" :data-testid="`dsh-package-${pkg.name}`">
          <div class="package-heading"><strong>{{ pkg.name }}</strong><NTag size="small">{{ pkg.version }}</NTag><NTag size="small">{{ t(`dshPlugins.${pkg.kind}`) }}</NTag></div>
          <div class="package-actions">
            <NTag v-if="pkg.containsBrowserPart" type="warning">{{ t('dshPlugins.browser') }}</NTag>
            <NTag v-if="pkg.kind === 'bundle'">{{ t(pkg.configuredEnabled ? 'dshPlugins.enabled' : 'dshPlugins.disabled') }}</NTag>
            <NButton v-if="pkg.kind === 'bundle'" size="small" :disabled="busy || (!pkg.configuredEnabled && pkg.containsBrowserPart)" @click="change({ action: 'toggle', packageName: pkg.name, enabled: !pkg.configuredEnabled })">{{ t(pkg.configuredEnabled ? 'dshPlugins.disable' : 'dshPlugins.enable') }}</NButton>
            <NButton size="small" :disabled="busy" @click="prepareUpdate(pkg.name, pkg.version)">{{ t('dshPlugins.update') }}</NButton>
            <NPopconfirm @positive-click="change({ action: 'remove', packageName: pkg.name })"><template #trigger><NButton size="small" :disabled="busy">{{ t('dshPlugins.remove') }}</NButton></template>{{ t('dshPlugins.removeConfirm', { name: pkg.name }) }}</NPopconfirm>
          </div>
          <p v-if="pkg.kind === 'bundle'" class="hint">{{ t('dshPlugins.runtimeUnknown') }}</p>
          <details v-if="pkg.entries.length"><summary>{{ t('dshPlugins.entries') }}</summary><ul><li v-for="entry in pkg.entries" :key="entry.id"><code>{{ entry.id }}</code> — {{ entry.module }}</li></ul></details>
        </article>
      </section>
      <section>
        <div class="section-heading"><h3>{{ t('dshPlugins.configuration') }}</h3>
          <NPopconfirm @positive-click="resetDraft"><template #trigger><NButton :disabled="busy || !dirty" size="small">{{ t('dshPlugins.reload') }}</NButton></template>{{ t('dshPlugins.discard') }}</NPopconfirm>
          <NButton type="primary" :disabled="busy || !dirty" @click="change({ action: 'configure', content: draft })">{{ t('files.saveFile') }}</NButton>
        </div>
        <p class="hint">{{ t('dshPlugins.configHint') }}</p>
        <NInput v-model:value="draft" type="textarea" :autosize="{ minRows: 7, maxRows: 20 }" :input-props="{ 'aria-label': t('dshPlugins.configuration') }" />
        <template v-if="conflict"><h4>{{ t('dshPlugins.latest') }}</h4><NInput :value="data.content" readonly type="textarea" /></template>
      </section>
      <section v-if="histories.length > 1"><h3>{{ t('dshPlugins.history') }}</h3><div class="install-row"><NSelect v-model:value="rollback" :options="histories" :disabled="busy" :placeholder="t('dshPlugins.chooseVersion')" /><NPopconfirm @positive-click="rollback && change({ action: 'rollback', revisionId: rollback })"><template #trigger><NButton :disabled="busy || !rollback">{{ t('dshPlugins.rollback') }}</NButton></template>{{ t('dshPlugins.rollbackConfirm') }}</NPopconfirm></div></section>
      <section v-if="data.operations.length"><h3>{{ t('dshPlugins.operations') }}</h3><div v-for="op in data.operations.slice().reverse()" :key="op.id" class="operation"><span>{{ op.packageName || t(`dshPlugins.${op.action}`) }}</span><NTag :type="op.status === 'failed' ? 'error' : op.status === 'succeeded' ? 'success' : 'info'">{{ t(`dshPlugins.${op.status}`) }}</NTag><span v-if="op.code">{{ failure(op.code) }}</span></div></section>
    </template>
    </div></details>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/plugins-page' as plugins-page;
@include plugins-page.layout(100%);

.dsh-plugins { min-height: 0; }
.section-heading, .package-heading, .package-actions, .install-row, .operation { display: flex; align-items: center; gap: 10px; }
h3 { margin: 0 0 12px; }
.section-heading h3 { flex: 1; margin: 0; }.section-heading { margin-bottom: 12px; }
section, .package { border: 1px solid $border-color; border-radius: $radius-md; background: $bg-card; padding: 14px; }
.package { margin-top: 12px; }.package-heading, .package-actions, .operation { flex-wrap: wrap; }.package-heading strong { overflow-wrap: anywhere; }
.package-actions { margin-top: 10px; }.operation { padding: 8px 0; }.hint { color: $text-muted; font-size: 13px; line-height: 1.6; }
.managed-content { display: flex; flex-direction: column; gap: 16px; margin-top: 16px; }.managed-packages { margin-top: 20px; }.managed-packages > summary { cursor: pointer; font-weight: 600; font-size: 13px; color: $text-secondary; }
.mode { width: 130px; flex-shrink: 0; } li { overflow-wrap: anywhere; }
@media (max-width: 768px) { .install-row { flex-wrap: wrap; }.install-row > .n-input { flex-basis: 100%; }.section-heading { flex-wrap: wrap; } }
</style>
