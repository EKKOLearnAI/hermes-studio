<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HomeBindingDto, HomeDeviceDto } from '@/api/hermes/home'
import {
  homeDeviceFreshness,
  homeStateVersion,
  latestHomeObservation,
  primaryHomeBinding,
  type HomeDeviceActionDraft,
} from './home-ui'

type PendingAction = {
  device: HomeDeviceDto; binding: HomeBindingDto
  kind: HomeDeviceActionDraft['kind']; value: boolean | number | null; expectedStateVersion: number
}

defineProps<{ devices: HomeDeviceDto[]; canWrite: boolean; busy?: boolean }>()
const emit = defineEmits<{
  refresh: [device: HomeDeviceDto, binding: HomeBindingDto]
  action: [draft: HomeDeviceActionDraft]
}>()
const { t } = useI18n()
const pending = ref<PendingAction | null>(null)
const pendingValid = computed(() => {
  const action = pending.value
  if (!action || action.kind === 'set_power' || action.kind === 'activate_scene') return !!action
  const value = Number(action.value)
  if (!Number.isFinite(value)) return false
  return action.kind === 'set_level' ? value >= 0 && value <= 100 : value >= 5 && value <= 35
})

function stateValue(device: HomeDeviceDto, key: string): unknown {
  return device.states.find(state => state.key === key)?.value
}
function scalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return '—'
}
function observedAt(device: HomeDeviceDto): string {
  const value = latestHomeObservation(device)
  return value ? new Date(value).toLocaleString() : '—'
}
function openAction(device: HomeDeviceDto, binding: HomeBindingDto, kind: HomeDeviceActionDraft['kind']) {
  if (kind === 'set_power') {
    pending.value = { device, binding, kind, value: stateValue(device, 'power') !== true,
      expectedStateVersion: homeStateVersion(device, 'power') }
    return
  }
  if (kind === 'set_level') {
    const current = Number(stateValue(device, 'level'))
    pending.value = { device, binding, kind, value: Number.isFinite(current) ? current : 50,
      expectedStateVersion: homeStateVersion(device, 'level') }
    return
  }
  if (kind === 'set_temperature') {
    const current = Number(stateValue(device, 'temperature'))
    pending.value = { device, binding, kind, value: Number.isFinite(current) ? current : 22,
      expectedStateVersion: homeStateVersion(device, 'temperature') }
    return
  }
  pending.value = { device, binding, kind, value: null, expectedStateVersion: 0 }
}
function desiredLabel(action: PendingAction): string {
  if (action.kind === 'set_power') return action.value ? t('home.devices.powerOn') : t('home.devices.powerOff')
  if (action.kind === 'set_level') return `${Number(action.value)}%`
  if (action.kind === 'set_temperature') return `${Number(action.value)} °C`
  return t('home.devices.activateScene')
}
function confirmAction() {
  const action = pending.value
  if (!action) return
  const common = { deviceId: action.device.id, bindingId: action.binding.id, externalId: action.binding.externalId }
  if (action.kind === 'set_power') emit('action', { ...common, kind: action.kind,
    expectedStateVersion: action.expectedStateVersion, desiredPower: Boolean(action.value) })
  else if (action.kind === 'set_level') emit('action', { ...common, kind: action.kind,
    expectedStateVersion: action.expectedStateVersion, desiredLevel: Number(action.value) })
  else if (action.kind === 'set_temperature') emit('action', { ...common, kind: action.kind,
    expectedStateVersion: action.expectedStateVersion, desiredTemperatureC: Number(action.value) })
  else emit('action', { ...common, kind: action.kind })
  pending.value = null
}
</script>

<template>
  <section class="home-panel" data-test="home-device-panel">
    <header><h2>{{ t('home.devices.title') }}</h2><span>{{ devices.length }}</span></header>
    <p v-if="!devices.length" class="empty">{{ t('home.devices.empty') }}</p>
    <div v-else class="device-grid">
      <article v-for="device in devices" :key="device.id" class="device-card" :data-test="`home-device-${device.id}`">
        <div class="device-heading">
          <div>
            <span class="device-class">{{ device.deviceClass }}</span>
            <h3>{{ device.name }}</h3>
          </div>
          <span class="availability" :class="device.availability">{{ t(`home.status.${device.availability}`) }}</span>
        </div>
        <div class="device-meta">
          <span class="freshness" :class="homeDeviceFreshness(device)">{{ t(`home.freshness.${homeDeviceFreshness(device)}`) }}</span>
          <span>{{ t('home.devices.lastSeen') }}: {{ observedAt(device) }}</span>
        </div>
        <dl class="state-list">
          <div v-for="state in device.states.slice(0, 4)" :key="state.key">
            <dt>{{ state.key }}</dt><dd>{{ scalar(state.value) }}</dd>
          </div>
        </dl>
        <div v-if="primaryHomeBinding(device)" class="device-actions">
          <button :disabled="!canWrite || busy" data-test="home-refresh-device"
            @click="emit('refresh', device, primaryHomeBinding(device)!)">{{ t('home.devices.refresh') }}</button>
          <template v-if="primaryHomeBinding(device)!.externalId.startsWith('scene.')">
            <button :disabled="!canWrite || busy" data-test="home-activate-scene"
              @click="openAction(device, primaryHomeBinding(device)!, 'activate_scene')">{{ t('home.devices.activateScene') }}</button>
          </template>
          <template v-else>
            <button v-if="primaryHomeBinding(device)!.capabilities.includes('power')" :disabled="!canWrite || busy"
              data-test="home-command-power" @click="openAction(device, primaryHomeBinding(device)!, 'set_power')">
              {{ stateValue(device, 'power') === true ? t('home.devices.powerOff') : t('home.devices.powerOn') }}
            </button>
            <button v-if="primaryHomeBinding(device)!.capabilities.includes('level')" :disabled="!canWrite || busy"
              data-test="home-command-level" @click="openAction(device, primaryHomeBinding(device)!, 'set_level')">{{ t('home.devices.setLevel') }}</button>
            <button v-if="primaryHomeBinding(device)!.capabilities.includes('temperature')" :disabled="!canWrite || busy"
              data-test="home-command-temperature" @click="openAction(device, primaryHomeBinding(device)!, 'set_temperature')">{{ t('home.devices.setTemperature') }}</button>
          </template>
        </div>
        <p v-else class="empty binding-empty">{{ t('home.devices.noBinding') }}</p>
      </article>
    </div>

    <div v-if="pending" class="confirmation-backdrop" @click.self="pending = null">
      <section class="confirmation-dialog" role="dialog" aria-modal="true" data-test="home-command-confirmation">
        <span class="warning-mark">!</span>
        <h3>{{ t('home.devices.confirmTitle') }}</h3>
        <p>{{ t('home.devices.confirmSummary') }}</p>
        <dl>
          <div><dt>{{ t('home.devices.target') }}</dt><dd>{{ pending.binding.externalId }}</dd></div>
          <div><dt>{{ t('home.devices.desired') }}</dt><dd>{{ desiredLabel(pending) }}</dd></div>
        </dl>
        <label v-if="pending.kind === 'set_level'">
          {{ t('home.devices.setLevel') }}
          <input v-model.number="pending.value" type="number" min="0" max="100" data-test="home-command-value">
        </label>
        <label v-if="pending.kind === 'set_temperature'">
          {{ t('home.devices.setTemperature') }}
          <input v-model.number="pending.value" type="number" min="5" max="35" step="0.5" data-test="home-command-value">
        </label>
        <p v-if="pending.kind === 'activate_scene'" class="scene-warning">{{ t('home.devices.sceneSafety') }}</p>
        <div class="dialog-actions">
          <button @click="pending = null">{{ t('home.devices.cancel') }}</button>
          <button class="primary" :disabled="busy || !pendingValid" data-test="home-command-confirm" @click="confirmAction">{{ t('home.devices.confirm') }}</button>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped lang="scss">
.home-panel { padding: 18px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-color); }
header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
h2, h3 { margin: 0; }
header span { color: var(--text-color-3); }
.empty { color: var(--text-color-3); }
.device-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.device-card { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--border-color); border-radius: 9px; }
.device-heading, .device-meta, .device-actions, .dialog-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.device-class { color: var(--primary-color); font-size: 11px; font-weight: 700; text-transform: uppercase; }
.device-heading h3 { margin-top: 2px; font-size: 16px; }
.availability, .freshness { padding: 3px 8px; border-radius: 999px; background: var(--action-color); font-size: 11px; }
.availability.unavailable, .freshness.stale { color: var(--error-color); }
.freshness.aging { color: var(--warning-color); }
.freshness.fresh, .availability.available { color: var(--success-color); }
.device-meta { justify-content: flex-start; color: var(--text-color-3); font-size: 11px; flex-wrap: wrap; }
.state-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin: 0; }
.state-list div { padding: 7px 9px; border-radius: 6px; background: var(--action-color); }
dt { color: var(--text-color-3); font-size: 11px; }
dd { margin: 2px 0 0; font-weight: 650; overflow-wrap: anywhere; }
.device-actions { justify-content: flex-start; flex-wrap: wrap; }
button { border: 1px solid var(--border-color); border-radius: 7px; background: transparent; color: var(--text-color); padding: 7px 10px; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--primary-color); color: var(--primary-color); }
button:disabled { cursor: not-allowed; opacity: .45; }
.binding-empty { margin: 0; font-size: 12px; }
.confirmation-backdrop { position: fixed; inset: 0; z-index: 1200; display: grid; place-items: center; padding: 20px; background: rgba(0, 0, 0, .55); }
.confirmation-dialog { width: min(440px, 100%); padding: 22px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--modal-color, var(--card-color)); box-shadow: 0 20px 60px rgba(0, 0, 0, .25); }
.warning-mark { display: grid; place-items: center; width: 30px; height: 30px; margin-bottom: 10px; border-radius: 50%; background: color-mix(in srgb, var(--warning-color) 16%, transparent); color: var(--warning-color); font-weight: 800; }
.confirmation-dialog > p { color: var(--text-color-2); line-height: 1.5; }
.confirmation-dialog dl { display: grid; gap: 8px; margin: 16px 0; }
.confirmation-dialog dl div { padding: 10px; border-radius: 7px; background: var(--action-color); }
.confirmation-dialog label { display: grid; gap: 6px; margin: 14px 0; }
.confirmation-dialog input { padding: 8px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--input-color); color: var(--text-color); }
.scene-warning { color: var(--warning-color) !important; }
.dialog-actions { justify-content: flex-end; margin-top: 18px; }
.dialog-actions .primary { border-color: var(--primary-color); background: var(--primary-color); color: white; }
@media (max-width: 760px) { .device-grid { grid-template-columns: 1fr; } }
</style>
