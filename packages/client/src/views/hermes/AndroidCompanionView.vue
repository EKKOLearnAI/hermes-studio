<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import { useAndroidCompanionStore } from '@/stores/hermes/android-companion'
import type { AndroidDeviceDto } from '@/api/hermes/android-companion'

const { t } = useI18n()
const message = useMessage()
const store = useAndroidCompanionStore()
const { overview, commands, receipts, notifications, artifacts, pairingOffer,
  activeTakeovers, activeCommands, loading, saving, error } = storeToRefs(store)
const canWrite = computed(() => isStoredSuperAdmin())
const revokeTarget = ref<AndroidDeviceDto | null>(null)
let pollHandle: number | null = null

onMounted(() => {
  void refresh(true)
  pollHandle = window.setInterval(() => { void refresh(false) }, 5_000)
})
onBeforeUnmount(() => {
  if (pollHandle !== null) window.clearInterval(pollHandle)
  pollHandle = null
})

async function refresh(notify: boolean) {
  try { await store.loadDashboard() } catch { if (notify) message.error(t('androidCompanion.errors.load')) }
}
async function createOffer() {
  try { await store.issuePairingOffer(); message.success(t('androidCompanion.success.offer')) }
  catch { message.error(t('androidCompanion.errors.pair')) }
}
async function cancelOffer() {
  const id = store.pairingOffer?.challengeId
  if (!id) return
  try { await store.revokePairingOffer(id); message.success(t('androidCompanion.success.revokeOffer')) }
  catch { message.error(t('androidCompanion.errors.revokeOffer')) }
}
async function confirmRevoke() {
  const device = revokeTarget.value
  if (!device) return
  try {
    await store.revokeDevice(device.id, device.version)
    revokeTarget.value = null
    message.success(t('androidCompanion.success.revokeDevice'))
  } catch { message.error(t('androidCompanion.errors.revokeDevice')) }
}
function short(value: string | null | undefined, size = 12) {
  if (!value) return '—'
  return value.length > size * 2 ? `${value.slice(0, size)}…${value.slice(-size)}` : value
}
function formatTime(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
function capabilityLabel(value: string) { return value === 'android.app.launch' ? 'App launch' : 'Screen capture' }
</script>

<template>
  <main class="android-view" data-test="android-companion-center">
    <header class="page-header">
      <div><h1>{{ t('androidCompanion.title') }}</h1><p>{{ t('androidCompanion.subtitle') }}</p></div>
      <button :disabled="loading" data-test="android-dashboard-refresh" @click="refresh(true)">
        {{ t('androidCompanion.refresh') }}
      </button>
    </header>
    <p v-if="!canWrite" class="notice">{{ t('androidCompanion.readOnly') }}</p>
    <p v-if="error" class="load-error" role="alert">{{ error }}</p>

    <NSpin :show="loading && !overview">
      <section class="status-panel" data-test="android-status-panel">
        <div class="section-heading">
          <div><span class="kicker">{{ t('androidCompanion.status.kicker') }}</span><h2>{{ t('androidCompanion.status.title') }}</h2></div>
          <span class="control-level">{{ t('androidCompanion.status.emergencyStop') }} · {{ t('androidCompanion.status.level', { level: overview?.emergencyStop.level ?? '—' }) }}</span>
        </div>
        <div class="metrics">
          <div><strong>{{ overview?.summary.pairedDeviceCount ?? 0 }}</strong><span>{{ t('androidCompanion.status.paired') }}</span></div>
          <div><strong>{{ overview?.summary.connectedDeviceCount ?? 0 }}</strong><span>{{ t('androidCompanion.status.connected') }}</span></div>
          <div><strong>{{ overview?.summary.healthyCapabilityCount ?? 0 }}</strong><span>{{ t('androidCompanion.status.capabilities') }}</span></div>
          <div><strong>{{ activeCommands.length }}</strong><span>{{ t('androidCompanion.status.commands') }}</span></div>
          <div><strong>{{ overview?.summary.verifiedReceiptCount ?? 0 }}</strong><span>{{ t('androidCompanion.status.verified') }}</span></div>
          <div><strong>{{ activeTakeovers.length }}</strong><span>{{ t('androidCompanion.status.takeovers') }}</span></div>
        </div>
      </section>

      <div class="trust-grid">
        <section class="panel pairing-panel">
          <div class="section-heading compact"><div><h2>{{ t('androidCompanion.pairing.title') }}</h2><p>{{ t('androidCompanion.pairing.summary') }}</p></div>
            <button v-if="!pairingOffer" :disabled="!canWrite || saving" data-test="android-pairing-issue" @click="createOffer">
              {{ t('androidCompanion.pairing.issue') }}
            </button></div>
          <div v-if="pairingOffer" class="pairing-offer" data-test="android-pairing-offer">
            <span class="kicker">{{ t('androidCompanion.pairing.offerTitle') }}</span>
            <strong class="pairing-code" data-test="android-pairing-code">{{ pairingOffer.code }}</strong>
            <dl><div><dt>{{ t('androidCompanion.pairing.expires') }}</dt><dd>{{ formatTime(pairingOffer.expiresAt) }}</dd></div>
              <div><dt>{{ t('androidCompanion.pairing.studio') }}</dt><dd class="mono">{{ short(pairingOffer.studioDeviceId) }}</dd></div></dl>
            <p>{{ t('androidCompanion.pairing.privacy') }}</p>
            <button class="danger" :disabled="!canWrite || saving" data-test="android-pairing-revoke" @click="cancelOffer">
              {{ t('androidCompanion.pairing.cancel') }}
            </button>
          </div>
        </section>

        <section class="panel devices-panel" data-test="android-devices-panel">
          <h2>{{ t('androidCompanion.devices.title') }}</h2>
          <p v-if="!overview?.devices.length" class="empty">{{ t('androidCompanion.devices.empty') }}</p>
          <article v-for="device in overview?.devices ?? []" :key="device.id" class="device-card">
            <div class="device-title"><div><strong>{{ device.label }}</strong><span class="mono">{{ short(device.id, 9) }}</span></div>
              <span :class="['pill', device.state === 'revoked' ? 'bad' : device.connected ? 'good' : 'muted']">
                {{ device.state === 'revoked' ? t('androidCompanion.devices.revoked') : device.connected ? t('androidCompanion.devices.connected') : t('androidCompanion.devices.offline') }}
              </span></div>
            <dl><div><dt>{{ t('androidCompanion.devices.android') }}</dt><dd>{{ device.androidVersion }}</dd></div>
              <div><dt>{{ t('androidCompanion.devices.app') }}</dt><dd>{{ device.appVersion }}</dd></div>
              <div><dt>{{ t('androidCompanion.devices.lastSeen') }}</dt><dd>{{ formatTime(device.lastSeenAt) }}</dd></div>
              <div><dt>{{ t('androidCompanion.devices.signing') }}</dt><dd class="mono">{{ short(device.signingFingerprint, 8) }}</dd></div>
              <div><dt>{{ t('androidCompanion.devices.exchange') }}</dt><dd class="mono">{{ short(device.exchangeFingerprint, 8) }}</dd></div></dl>
            <button v-if="device.state === 'paired'" class="danger-link" :disabled="!canWrite || saving"
              :data-test="`android-device-revoke-${device.id}`" @click="revokeTarget = device">
              {{ t('androidCompanion.devices.revoke') }}
            </button>
          </article>
        </section>
      </div>

      <section v-if="revokeTarget" class="revoke-confirm" data-test="android-revoke-confirmation">
        <div><strong>{{ t('androidCompanion.devices.confirmTitle') }}</strong><p>{{ t('androidCompanion.devices.confirmSummary') }}</p><span>{{ revokeTarget.label }} · {{ short(revokeTarget.id) }}</span></div>
        <div class="actions"><button :disabled="saving" @click="revokeTarget = null">{{ t('androidCompanion.devices.cancel') }}</button>
          <button class="danger" :disabled="saving" data-test="android-revoke-confirm" @click="confirmRevoke">{{ t('androidCompanion.devices.confirm') }}</button></div>
      </section>

      <section class="panel capabilities-panel" data-test="android-capabilities-panel">
        <h2>{{ t('androidCompanion.capabilities.title') }}</h2>
        <p v-if="!overview?.capabilities.length" class="empty">{{ t('androidCompanion.capabilities.empty') }}</p>
        <div class="capability-grid">
          <article v-for="item in overview?.capabilities ?? []" :key="`${item.deviceId}:${item.capabilityId}`" class="capability-card">
            <div><strong>{{ capabilityLabel(item.capabilityId) }}</strong>
              <span :class="['pill', item.enabled && item.health === 'healthy' ? 'good' : item.health === 'degraded' ? 'warn' : 'bad']">{{ t(`androidCompanion.capabilities.${item.health}`) }}</span></div>
            <dl><div><dt>{{ t('androidCompanion.capabilities.package') }}</dt><dd class="mono">{{ item.packageBinding }}</dd></div>
              <div><dt>{{ t('androidCompanion.capabilities.driver') }}</dt><dd>{{ item.driverVersion }}</dd></div>
              <div><dt>{{ t('androidCompanion.capabilities.permissions') }}</dt><dd>{{ item.permissions.join(', ') || '—' }}</dd></div>
              <div><dt>{{ t('androidCompanion.capabilities.verification') }}</dt><dd>{{ item.verificationStrategy }}</dd></div></dl>
          </article>
        </div>
      </section>

      <section class="panel takeover-panel" data-test="android-takeovers-panel">
        <h2>{{ t('androidCompanion.takeovers.title') }}</h2>
        <p v-if="!activeTakeovers.length" class="empty">{{ t('androidCompanion.takeovers.empty') }}</p>
        <article v-for="item in activeTakeovers" :key="item.id" class="takeover-card" data-test="android-active-takeover">
          <div><strong>{{ capabilityLabel(item.capabilityId) }}</strong><span class="pill warn">{{ t(`androidCompanion.takeovers.${item.status}`) }}</span></div>
          <p>{{ t('androidCompanion.takeovers.deviceAction') }}</p>
          <dl><div><dt>{{ t('androidCompanion.takeovers.reason') }}</dt><dd>{{ item.reasonCode }}</dd></div>
            <div><dt>{{ t('androidCompanion.activity.workflow') }}</dt><dd class="mono">{{ short(item.workflowId) }}</dd></div>
            <div><dt>{{ t('androidCompanion.takeovers.expires') }}</dt><dd>{{ formatTime(item.expiresAt) }}</dd></div></dl>
        </article>
      </section>

      <section class="activity-section" data-test="android-activity-panel">
        <h2>{{ t('androidCompanion.activity.title') }}</h2>
        <div class="activity-grid">
          <article class="panel activity-card"><h3>{{ t('androidCompanion.activity.commands') }} <span>{{ commands.length }}</span></h3>
            <p v-if="!commands.length" class="empty">{{ t('androidCompanion.activity.empty') }}</p>
            <div v-for="item in commands.slice(0, 8)" :key="item.id" class="record"><div><strong>{{ capabilityLabel(item.capabilityId) }}</strong><span class="pill muted">{{ item.status }}</span></div><small class="mono">{{ short(item.workflowId) }} · {{ t('androidCompanion.activity.attempts') }} {{ item.deliveryAttempts }}</small></div>
          </article>
          <article class="panel activity-card"><h3>{{ t('androidCompanion.activity.receipts') }} <span>{{ receipts.length }}</span></h3>
            <p v-if="!receipts.length" class="empty">{{ t('androidCompanion.activity.empty') }}</p>
            <div v-for="item in receipts.slice(0, 8)" :key="item.workflowId" class="record"><div><strong>{{ capabilityLabel(item.capabilityId) }}</strong><span :class="['pill', item.status === 'verified' ? 'good' : 'muted']">{{ item.status }}</span></div><small class="mono">{{ short(item.workflowId) }} · {{ formatTime(item.updatedAt) }}</small></div>
          </article>
          <article class="panel activity-card"><h3>{{ t('androidCompanion.activity.notifications') }} <span>{{ notifications.length }}</span></h3>
            <p v-if="!notifications.length" class="empty">{{ t('androidCompanion.activity.empty') }}</p>
            <div v-for="item in notifications.slice(0, 8)" :key="item.id" class="record"><div><strong>{{ item.titleSummary || item.category }}</strong><span class="pill muted">{{ item.sensitivity }}</span></div><small>{{ item.packageBinding }} · {{ formatTime(item.postedAt) }}</small></div>
          </article>
          <article class="panel activity-card"><h3>{{ t('androidCompanion.activity.artifacts') }} <span>{{ artifacts.length }}</span></h3>
            <p v-if="!artifacts.length" class="empty">{{ t('androidCompanion.activity.empty') }}</p>
            <div v-for="item in artifacts.slice(0, 8)" :key="item.id" class="record"><div><strong>{{ item.mimeType }} · {{ item.width }}×{{ item.height }}</strong><span>{{ formatBytes(item.byteSize) }}</span></div><small class="mono">{{ short(item.digest) }} · {{ formatTime(item.capturedAt) }}</small></div>
          </article>
        </div>
      </section>
    </NSpin>
  </main>
</template>

<style scoped lang="scss">
.android-view { height: 100%; min-height: 0; overflow: auto; padding: 24px; color: var(--text-color); }
.page-header,.section-heading,.device-title,.capability-card>div,.takeover-card>div,.record>div,.actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.page-header { margin-bottom: 18px; }.page-header h1 { margin: 0; font-size: 25px; }.page-header p,.section-heading p { margin: 5px 0 0; color: var(--text-color-2); }
button { padding: 7px 12px; border: 1px solid var(--border-color); border-radius: 7px; background: transparent; color: var(--text-color); cursor: pointer; } button:disabled { cursor: not-allowed; opacity: .45; }
.notice,.load-error { margin: 0 0 14px; padding: 10px 12px; border-radius: 8px; }.notice { background: color-mix(in srgb, var(--warning-color) 10%, transparent); }.load-error { background: color-mix(in srgb, var(--error-color) 10%, transparent); color: var(--error-color); }
.status-panel,.panel,.revoke-confirm { border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-color); }.status-panel,.panel { padding: 17px; }.section-heading h2,.panel h2,.activity-section>h2 { margin: 0; font-size: 17px; }.kicker { color: var(--primary-color); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }.control-level { padding: 5px 9px; border-radius: 999px; background: color-mix(in srgb, var(--warning-color) 12%, transparent); font-size: 12px; }
.metrics { display: grid; grid-template-columns: repeat(6,minmax(100px,1fr)); gap: 10px; margin-top: 16px; }.metrics>div { padding: 12px; border-radius: 9px; background: var(--hover-color); }.metrics strong,.metrics span { display: block; }.metrics strong { font-size: 22px; }.metrics span { margin-top: 3px; color: var(--text-color-2); font-size: 12px; }
.trust-grid { display: grid; grid-template-columns: minmax(280px,.85fr) minmax(380px,1.4fr); gap: 14px; margin-top: 14px; }.compact { align-items: center; }.pairing-offer { margin-top: 16px; padding: 14px; border: 1px dashed var(--primary-color); border-radius: 10px; }.pairing-code { display: block; margin: 10px 0; color: var(--primary-color); font-size: 34px; letter-spacing: .14em; }.pairing-offer p { color: var(--text-color-2); font-size: 12px; }
.device-card,.capability-card,.takeover-card,.record { border-top: 1px solid var(--border-color); padding: 13px 0; }.device-card:first-of-type { margin-top: 7px; }.device-title>div>* { display: block; }.device-title .mono { margin-top: 3px; color: var(--text-color-3); font-size: 11px; }
dl { margin: 10px 0; } dl>div { display: grid; grid-template-columns: 112px minmax(0,1fr); gap: 9px; margin-top: 6px; } dt { color: var(--text-color-3); font-size: 12px; } dd { margin: 0; overflow-wrap: anywhere; font-size: 12px; }.mono { font-family: ui-monospace,SFMono-Regular,Consolas,monospace; }
.pill { display: inline-flex; flex: 0 0 auto; padding: 3px 7px; border-radius: 999px; font-size: 11px; }.good { background: color-mix(in srgb, var(--success-color) 14%, transparent); color: var(--success-color); }.warn { background: color-mix(in srgb, var(--warning-color) 14%, transparent); color: var(--warning-color); }.bad { background: color-mix(in srgb, var(--error-color) 13%, transparent); color: var(--error-color); }.muted { background: var(--hover-color); color: var(--text-color-2); }
.danger,.danger-link { color: var(--error-color); }.danger { border-color: color-mix(in srgb, var(--error-color) 45%, var(--border-color)); }.danger-link { padding: 0; border: 0; }.revoke-confirm { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 14px; padding: 15px; border-color: color-mix(in srgb, var(--error-color) 40%, var(--border-color)); }.revoke-confirm p { margin: 4px 0; color: var(--text-color-2); }
.capabilities-panel,.takeover-panel,.activity-section { margin-top: 14px; }.capability-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 0 16px; }.capability-card>div,.takeover-card>div { align-items: center; }.empty { color: var(--text-color-3); }
.activity-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; margin-top: 10px; }.activity-card h3 { display: flex; justify-content: space-between; margin: 0; font-size: 14px; }.activity-card h3 span { color: var(--text-color-3); }.record:last-child { padding-bottom: 0; }.record small { display: block; margin-top: 4px; color: var(--text-color-3); overflow-wrap: anywhere; }
@media (max-width: 1050px) { .metrics { grid-template-columns: repeat(3,1fr); }.trust-grid { grid-template-columns: 1fr; } }
@media (max-width: 720px) { .android-view { padding: 16px; }.page-header,.section-heading,.revoke-confirm { align-items: stretch; flex-direction: column; }.metrics,.capability-grid,.activity-grid { grid-template-columns: 1fr; }.actions { justify-content: flex-end; } }
</style>
