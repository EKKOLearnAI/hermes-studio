<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import { useHomeStore } from '@/stores/hermes/home'
import type { HomeBindingDto, HomeDeviceDto, HomeWorkflowState, ReviewHomeWorkflowInput } from '@/api/hermes/home'
import HomeOverviewPanel from '@/components/hermes/home/HomeOverviewPanel.vue'
import HomeDevicePanel from '@/components/hermes/home/HomeDevicePanel.vue'
import HomeInventoryPanel from '@/components/hermes/home/HomeInventoryPanel.vue'
import HomeWorkflowPanel from '@/components/hermes/home/HomeWorkflowPanel.vue'
import type { HomeDeviceActionDraft } from '@/components/hermes/home/home-ui'

const { t } = useI18n()
const message = useMessage()
const store = useHomeStore()
const { overview, provider, devices, inventory, selectedWorkflow, loading, saving, error } = storeToRefs(store)
const canWrite = computed(() => isStoredSuperAdmin())
const terminalStates = new Set<HomeWorkflowState>(['succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated'])
let pollHandle: number | null = null
let pollSequence = 0

onMounted(loadDashboard)
onBeforeUnmount(stopPolling)

async function loadDashboard() {
  try { await store.loadDashboard() }
  catch { message.error(t('home.errors.load')) }
}
function operationId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16)
    ?? Math.random().toString(16).slice(2, 18)
  return `home-ui:${prefix}:${Date.now().toString(36)}:${random}`
}
function stopPolling() {
  pollSequence += 1
  if (pollHandle !== null) window.clearInterval(pollHandle)
  pollHandle = null
}
async function refreshWorkflow() {
  const id = store.selectedWorkflowId
  if (!id) return
  try {
    const workflow = await store.loadWorkflow(id)
    if (terminalStates.has(workflow.state)) {
      stopPolling()
      await Promise.allSettled([store.loadOverview(), store.loadDevices()])
    }
  } catch { stopPolling() }
}
function followWorkflow(id: string) {
  stopPolling()
  store.selectWorkflow(id)
  const sequence = pollSequence
  void store.loadWorkflow(id).catch(() => undefined)
  pollHandle = window.setInterval(() => {
    if (sequence !== pollSequence) return
    void refreshWorkflow()
  }, 1_500)
}
async function queueAction(action: () => Promise<{ workflow: { id: string } }>) {
  try {
    const result = await action()
    followWorkflow(result.workflow.id)
    message.success(t('home.success.queued'))
  } catch { message.error(t('home.errors.command')) }
}
async function refreshDevice(device: HomeDeviceDto, binding: HomeBindingDto) {
  await queueAction(() => store.refreshDevice(device.id, {
    bindingId: binding.id, externalId: binding.externalId, requestedAt: new Date().toISOString(),
    idempotencyKey: operationId('refresh'),
  }))
}
async function runDeviceAction(draft: HomeDeviceActionDraft) {
  const base = { bindingId: draft.bindingId, externalId: draft.externalId,
    verificationTimeoutMs: 30_000, idempotencyKey: operationId(draft.kind) }
  if (draft.kind === 'activate_scene') {
    await queueAction(() => store.activateScene(draft.deviceId, base))
  } else if (draft.kind === 'set_power') {
    await queueAction(() => store.commandDevice(draft.deviceId, { ...base, command: draft.kind,
      expectedStateVersion: draft.expectedStateVersion, desiredPower: draft.desiredPower }))
  } else if (draft.kind === 'set_level') {
    await queueAction(() => store.commandDevice(draft.deviceId, { ...base, command: draft.kind,
      expectedStateVersion: draft.expectedStateVersion, desiredLevel: draft.desiredLevel }))
  } else {
    await queueAction(() => store.commandDevice(draft.deviceId, { ...base, command: draft.kind,
      expectedStateVersion: draft.expectedStateVersion, desiredTemperatureC: draft.desiredTemperatureC }))
  }
}
async function adjustInventory(payload: { id: string; delta: number; reason: string }) {
  try {
    await store.adjustInventory(payload.id, { delta: payload.delta, reason: payload.reason,
      occurredAt: new Date().toISOString(), idempotencyKey: operationId('inventory') })
    await store.loadOverview().catch(() => undefined)
    message.success(t('home.success.inventory'))
  } catch { message.error(t('home.errors.inventory')) }
}
async function reviewWorkflow(input: ReviewHomeWorkflowInput) {
  const id = store.selectedWorkflowId
  if (!id) return
  try {
    const workflow = await store.reviewWorkflow(id, input)
    followWorkflow(workflow.id)
    message.success(t('home.success.reviewed'))
  } catch { message.error(t('home.errors.workflow')) }
}
</script>

<template>
  <main class="home-view" data-test="home-command-center">
    <header class="page-header">
      <div>
        <h1>{{ t('home.title') }}</h1>
        <p>{{ t('home.subtitle') }}</p>
      </div>
      <button :disabled="loading" data-test="home-dashboard-refresh" @click="loadDashboard">{{ t('home.refresh') }}</button>
    </header>
    <p v-if="!canWrite" class="read-only-banner">{{ t('home.readOnly') }}</p>
    <p v-if="error" class="load-error" role="alert">{{ error }}</p>
    <NSpin :show="loading && !overview">
      <div class="home-layout">
        <HomeOverviewPanel class="overview" :overview="overview" :provider="provider" />
        <HomeDevicePanel class="devices" :devices="devices" :can-write="canWrite" :busy="saving"
          @refresh="refreshDevice" @action="runDeviceAction" />
        <aside class="side-column">
          <HomeInventoryPanel :items="inventory" :can-write="canWrite" :busy="saving" @adjust="adjustInventory" />
          <HomeWorkflowPanel :workflow="selectedWorkflow" :can-write="canWrite" :busy="saving"
            @review="reviewWorkflow" @refresh="refreshWorkflow" />
        </aside>
      </div>
    </NSpin>
  </main>
</template>

<style scoped lang="scss">
.home-view { height: 100%; min-height: 0; overflow: auto; padding: 24px; color: var(--text-color); }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 25px; }
.page-header p { margin: 5px 0 0; color: var(--text-color-2); }
.page-header button { padding: 7px 12px; border: 1px solid var(--border-color); border-radius: 7px; background: transparent; color: var(--text-color); cursor: pointer; }
.page-header button:disabled { opacity: .5; }
.read-only-banner, .load-error { margin: 0 0 14px; padding: 10px 12px; border-radius: 7px; background: var(--action-color); color: var(--text-color-2); }
.load-error { background: color-mix(in srgb, var(--error-color) 10%, transparent); color: var(--error-color); }
.home-layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); gap: 14px; align-items: start; }
.overview { grid-column: 1 / -1; }
.devices { grid-column: 1; }
.side-column { display: grid; gap: 14px; }
@media (max-width: 980px) { .home-layout { grid-template-columns: 1fr; } .overview, .devices { grid-column: 1; } }
@media (max-width: 600px) { .home-view { padding: 16px; } .page-header { align-items: stretch; flex-direction: column; } }
</style>
