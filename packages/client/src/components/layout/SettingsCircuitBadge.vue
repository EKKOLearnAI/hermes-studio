<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { NButton, NDataTable, NForm, NFormItem, NInput, NModal, NSpace, NTag, NTooltip, useDialog, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { connectMcuDeviceRemote, createMcuDevice, deleteMcuDevice, disconnectMcuDeviceRemote, fetchMcuDevices, updateMcuDeviceName, type McuDevice } from '@/api/hermes/mcu-devices'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const purchaseUrl = 'https://hermes-studio.ai/docs/hermes-esp32-intro/index.html'
const showModal = ref(false)
const showAddModal = ref(false)
const loading = ref(false)
const saving = ref(false)
const connectingDeviceId = ref(0)
const editing = ref(false)
const devices = ref<McuDevice[]>([])
const form = ref({
  name: '',
  device_code: '',
})
const editForm = ref({
  id: 0,
  name: '',
})

function renderConnectionStatus(connected: boolean | undefined) {
  return h(NTag, {
    size: 'small',
    type: connected ? 'success' : 'default',
    bordered: false,
  }, { default: () => connected ? t('mcuDevices.connected') : t('mcuDevices.disconnected') })
}

const columns = computed<DataTableColumns<McuDevice>>(() => [
  {
    title: t('mcuDevices.name'),
    key: 'name',
    ellipsis: { tooltip: true },
  },
  {
    title: t('mcuDevices.deviceCode'),
    key: 'device_code',
    ellipsis: { tooltip: true },
  },
  {
    title: t('mcuDevices.channel'),
    key: 'is_official',
    width: 96,
    render(row) {
      return h(NTag, {
        size: 'small',
        type: row.is_official ? 'success' : 'warning',
        bordered: false,
      }, { default: () => row.is_official ? t('mcuDevices.official') : t('mcuDevices.unofficial') })
    },
  },
  {
    title: t('mcuDevices.lanStatus'),
    key: 'lan_connected',
    width: 96,
    render(row) {
      return renderConnectionStatus(row.lan_connected)
    },
  },
  {
    title: t('mcuDevices.remoteStatus'),
    key: 'remote_connected',
    width: 96,
    render(row) {
      return renderConnectionStatus(row.remote_connected)
    },
  },
  {
    title: t('mcuDevices.actions'),
    key: 'actions',
    width: 220,
    render(row) {
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, {
            size: 'tiny',
            quaternary: true,
            onClick: () => openEditModal(row),
          }, { default: () => t('mcuDevices.edit') }),
          h(NButton, {
            size: 'tiny',
            quaternary: true,
            type: row.remote_connected ? 'warning' : 'primary',
            loading: connectingDeviceId.value === row.id,
            disabled: connectingDeviceId.value !== 0 || (!row.is_official && !row.remote_connected),
            onClick: () => toggleRemoteDevice(row),
          }, { default: () => row.remote_connected ? t('mcuDevices.remoteDisconnect') : t('mcuDevices.remoteConnect') }),
          h(NButton, {
            size: 'tiny',
            quaternary: true,
            type: 'error',
            onClick: () => confirmDeleteDevice(row),
          }, { default: () => t('mcuDevices.delete') }),
        ],
      })
    },
  },
])

async function loadDevices() {
  loading.value = true
  try {
    const response = await fetchMcuDevices()
    devices.value = response.devices
  } catch (error: any) {
    message.error(error?.message || t('mcuDevices.loadFailed'))
  } finally {
    loading.value = false
  }
}

function openModal() {
  showModal.value = true
  void loadDevices()
}

function openAddModal() {
  form.value = { name: '', device_code: '' }
  showAddModal.value = true
}

function openPurchasePage() {
  window.open(purchaseUrl, '_blank', 'noopener,noreferrer')
}

async function submitDevice(): Promise<boolean | void> {
  const deviceCode = form.value.device_code.trim()
  if (!deviceCode) {
    message.warning(t('mcuDevices.deviceCodeRequired'))
    return false
  }

  saving.value = true
  try {
    const response = await createMcuDevice({
      name: form.value.name.trim(),
      device_code: deviceCode,
    })
    devices.value = response.devices
    form.value = { name: '', device_code: '' }
    showAddModal.value = false
    message.success(t('mcuDevices.added'))
  } catch (error: any) {
    message.error(error?.message || t('mcuDevices.addFailed'))
    return false
  } finally {
    saving.value = false
  }
}

function openEditModal(device: McuDevice) {
  editForm.value = {
    id: device.id,
    name: device.name,
  }
  editing.value = true
}

async function submitEdit() {
  if (!editForm.value.id) return
  saving.value = true
  try {
    const response = await updateMcuDeviceName(editForm.value.id, editForm.value.name)
    devices.value = response.devices
    editing.value = false
    message.success(t('mcuDevices.nameUpdated'))
  } catch (error: any) {
    message.error(error?.message || t('mcuDevices.nameUpdateFailed'))
  } finally {
    saving.value = false
  }
}

async function toggleRemoteDevice(device: McuDevice) {
  connectingDeviceId.value = device.id
  try {
    const response = device.remote_connected
      ? await disconnectMcuDeviceRemote(device.id)
      : await connectMcuDeviceRemote(device.id)
    devices.value = response.devices
    message.success(t(device.remote_connected ? 'mcuDevices.remoteDisconnected' : 'mcuDevices.remoteConnected'))
  } catch (error: any) {
    message.error(error?.message || t(device.remote_connected ? 'mcuDevices.remoteDisconnectFailed' : 'mcuDevices.remoteConnectFailed'))
  } finally {
    connectingDeviceId.value = 0
  }
}

function confirmDeleteDevice(device: McuDevice) {
  dialog.warning({
    title: t('mcuDevices.deleteTitle'),
    content: t('mcuDevices.deleteConfirm', { name: device.name || device.device_code }),
    positiveText: t('mcuDevices.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      saving.value = true
      try {
        const response = await deleteMcuDevice(device.id)
        devices.value = response.devices
        message.success(t('mcuDevices.deleted'))
      } catch (error: any) {
        message.error(error?.message || t('mcuDevices.deleteFailed'))
        return false
      } finally {
        saving.value = false
      }
    },
  })
}
</script>

<template>
  <!-- Style 1: chip badge
  <svg class="settings-circuit-badge settings-circuit-badge--chip" viewBox="0 0 34 22" fill="none" aria-hidden="true">
    <rect class="settings-circuit-badge-shell" x="4.5" y="3.5" width="25" height="15" rx="4" />
    <path class="settings-circuit-pin" d="M2.5 7h3M2.5 11h3M2.5 15h3M28.5 7h3M28.5 11h3M28.5 15h3" />
    <path class="settings-circuit-pin" d="M11 1.8v2M17 1.8v2M23 1.8v2M11 18.2v2M17 18.2v2M23 18.2v2" />
    <rect class="settings-circuit-chip" x="12" y="6" width="10" height="10" rx="2" />
    <path class="settings-circuit-track" d="M17 11H7" />
    <path class="settings-circuit-track" d="M17 11h10" />
    <path class="settings-circuit-track" d="M17 11V5" />
    <path class="settings-circuit-track" d="M17 11v6" />
    <path class="settings-circuit-track" d="M14 8h-4V6H7" />
    <path class="settings-circuit-track" d="M20 8h4V6h3" />
    <path class="settings-circuit-track" d="M14 14h-4v2H7" />
    <path class="settings-circuit-track" d="M20 14h4v2h3" />
    <path class="settings-circuit-pulse settings-circuit-pulse-main" d="M17 11H7" pathLength="1" />
    <path class="settings-circuit-pulse settings-circuit-pulse-main settings-circuit-pulse-late" d="M17 11h10" pathLength="1" />
    <path class="settings-circuit-pulse settings-circuit-pulse-branch" d="M17 11V5" pathLength="1" />
    <path class="settings-circuit-pulse settings-circuit-pulse-branch settings-circuit-pulse-late" d="M17 11v6" pathLength="1" />
    <path class="settings-circuit-pulse settings-circuit-pulse-branch" d="M14 8h-4V6H7" pathLength="1" />
    <path class="settings-circuit-pulse settings-circuit-pulse-branch settings-circuit-pulse-late" d="M20 14h4v2h3" pathLength="1" />
    <circle class="settings-circuit-core" cx="17" cy="11" r="1.35" />
    <circle class="settings-circuit-node" cx="7" cy="6" r="0.9" />
    <circle class="settings-circuit-node" cx="27" cy="6" r="0.9" />
    <circle class="settings-circuit-node" cx="7" cy="16" r="0.9" />
    <circle class="settings-circuit-node" cx="27" cy="16" r="0.9" />
  </svg>
  -->
  <NTooltip trigger="hover" placement="top">
    <template #trigger>
      <button class="settings-circuit-link" type="button" :aria-label="t('mcuDevices.title')" @click.stop="openModal">
        <svg class="settings-circuit-badge settings-circuit-badge--pcb" viewBox="0 0 36 22" fill="none" aria-hidden="true">
          <rect class="settings-pcb-board" x="3" y="3" width="30" height="16" rx="3" />
          <path class="settings-pcb-copper" d="M7 7h6v4h7v-3h9" />
          <path class="settings-pcb-copper" d="M7 15h5v-3h5v4h12" />
          <path class="settings-pcb-copper" d="M12 7v-2h8" />
          <path class="settings-pcb-copper" d="M24 15v2h5" />
          <path class="settings-pcb-current settings-pcb-current-main" d="M7 7h6v4h7v-3h9" />
          <path class="settings-pcb-current settings-pcb-current-main settings-pcb-current-late" d="M7 15h5v-3h5v4h12" />
          <path class="settings-pcb-current settings-pcb-current-branch" d="M12 7v-2h8" />
          <path class="settings-pcb-current settings-pcb-current-branch settings-pcb-current-late" d="M24 15v2h5" />
          <circle class="settings-pcb-pad settings-pcb-pad-live" cx="7" cy="7" r="1.2" />
          <circle class="settings-pcb-pad" cx="13" cy="11" r="1" />
          <circle class="settings-pcb-pad settings-pcb-pad-live" cx="20" cy="11" r="1.2" />
          <circle class="settings-pcb-pad" cx="29" cy="8" r="1" />
          <circle class="settings-pcb-pad settings-pcb-pad-live settings-pcb-pad-late" cx="17" cy="12" r="1.2" />
          <circle class="settings-pcb-pad" cx="29" cy="15" r="1" />
          <circle class="settings-pcb-via" cx="20" cy="5" r="0.8" />
          <circle class="settings-pcb-via" cx="29" cy="17" r="0.8" />
        </svg>
      </button>
    </template>
    {{ t('mcuDevices.title') }}
  </NTooltip>
  <NModal v-model:show="showModal" :show-icon="false">
    <div class="mcu-device-dialog">
      <div class="mcu-device-header">
        <div>
          <div class="mcu-device-title">{{ t('mcuDevices.title') }}</div>
          <div class="mcu-device-subtitle">{{ t('mcuDevices.subtitle') }}</div>
        </div>
        <button class="mcu-device-close" type="button" :aria-label="t('mcuDevices.close')" @click="showModal = false">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
      <div class="mcu-device-table">
        <NDataTable
          style="height: 100%;"
          size="small"
          :columns="columns"
          :data="devices"
          :loading="loading"
          :bordered="false"
          :single-line="false"
          :row-key="(row: McuDevice) => row.id"
          flex-height
        />
      </div>
      <div class="mcu-device-actions">
        <NButton type="primary" @click="openAddModal">{{ t('mcuDevices.add') }}</NButton>
        <NButton secondary @click="openPurchasePage">{{ t('mcuDevices.purchase') }}</NButton>
      </div>
    </div>
  </NModal>
  <NModal
    v-model:show="showAddModal"
    preset="dialog"
    :title="t('mcuDevices.addTitle')"
    :positive-text="t('mcuDevices.add')"
    :negative-text="t('common.cancel')"
    :positive-button-props="{ loading: saving }"
    @positive-click="submitDevice"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('mcuDevices.name')">
        <NInput v-model:value="form.name" :placeholder="t('mcuDevices.nameOptional')" :disabled="saving" />
      </NFormItem>
      <NFormItem :label="t('mcuDevices.deviceCode')" required>
        <NInput
          v-model:value="form.device_code"
          :placeholder="t('mcuDevices.deviceCodePlaceholder')"
          :disabled="saving"
          @keydown.enter.prevent="submitDevice"
        />
      </NFormItem>
    </NForm>
  </NModal>
  <NModal
    v-model:show="editing"
    preset="dialog"
    :title="t('mcuDevices.editNameTitle')"
    :positive-text="t('common.save')"
    :negative-text="t('common.cancel')"
    :positive-button-props="{ loading: saving }"
    @positive-click="submitEdit"
  >
    <NInput
      v-model:value="editForm.name"
      :placeholder="t('mcuDevices.nameOptional')"
      :disabled="saving"
      @keydown.enter.prevent="submitEdit"
    />
  </NModal>
  <!-- Style 3: current scan line
  <svg class="settings-circuit-badge settings-circuit-badge--scan" viewBox="0 0 36 20" fill="none" aria-hidden="true">
    <path class="settings-scan-track" d="M3 10h6l3-5h7l3 10h5l3-5h3" />
    <path class="settings-scan-track settings-scan-branch" d="M12 5V3h6" />
    <path class="settings-scan-track settings-scan-branch" d="M22 15v2h7" />
    <path class="settings-scan-glow" d="M3 10h6l3-5h7l3 10h5l3-5h3" pathLength="1" />
    <path class="settings-scan-glow settings-scan-glow-branch" d="M12 5V3h6" pathLength="1" />
    <path class="settings-scan-glow settings-scan-glow-branch settings-scan-glow-late" d="M22 15v2h7" pathLength="1" />
    <circle class="settings-scan-node settings-scan-node-live" cx="12" cy="5" r="1.2" />
    <circle class="settings-scan-node" cx="19" cy="5" r="0.9" />
    <circle class="settings-scan-node settings-scan-node-live settings-scan-node-late" cx="22" cy="15" r="1.2" />
    <circle class="settings-scan-node" cx="30" cy="10" r="0.9" />
  </svg>
  -->
</template>

<style scoped lang="scss">
.settings-circuit-badge {
  flex: 0 0 auto;
  width: 34px;
  height: 20px;
  color: #d6a019;
  overflow: visible;
  filter: drop-shadow(0 0 4px rgba(214, 160, 25, 0.45));
}

.settings-circuit-link {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 36px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  align-items: center;
  margin-left: auto;
  color: inherit;
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;

  &:hover {
    background: rgba(214, 160, 25, 0.08);
  }
}

.mcu-device-dialog {
  width: min(880px, calc(100vw - 48px));
  height: min(680px, calc(100vh - 72px));
  background: var(--bg-card);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.mcu-device-header {
  flex: 0 0 auto;
  min-height: 68px;
  padding: 16px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.mcu-device-title {
  font-size: 16px;
  font-weight: 650;
  line-height: 22px;
  color: var(--text-primary);
}

.mcu-device-subtitle {
  margin-top: 2px;
  font-size: 12px;
  line-height: 18px;
  color: var(--text-muted);
}

.mcu-device-close {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  display: inline-grid;
  place-items: center;
  cursor: pointer;

  &:hover {
    background: rgba(var(--text-muted-rgb), 0.14);
    color: var(--text-primary);
  }
}

.mcu-device-actions {
  flex: 0 0 auto;
  padding: 12px 18px 16px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
}

.mcu-device-table {
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px 18px;
  overflow: hidden;

  :deep(.n-data-table) {
    height: 100%;
    --n-td-color: var(--bg-card);
    --n-th-color: var(--bg-secondary);
    --n-border-color: var(--border-color);
    --n-td-text-color: var(--text-primary);
    --n-th-text-color: var(--text-secondary);
  }

  :deep(.n-data-table-base-table) {
    height: 100%;
  }

  :deep(.n-data-table-base-table-body) {
    overflow-y: auto;
  }
}

@media (max-width: 640px) {
  .mcu-device-dialog {
    width: calc(100vw - 24px);
    height: calc(100vh - 32px);
  }

  .mcu-device-actions {
    justify-content: stretch;

    :deep(.n-button) {
      flex: 1;
    }
  }
}

.settings-circuit-badge--scan {
  height: 18px;
  color: #d6a019;
  filter:
    drop-shadow(0 0 3px rgba(214, 160, 25, 0.55))
    drop-shadow(0 0 8px rgba(214, 160, 25, 0.22));
}

.settings-scan-track,
.settings-scan-glow {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.settings-scan-track {
  stroke-width: 1.25;
  opacity: 0.24;
}

.settings-scan-branch {
  opacity: 0.18;
}

.settings-scan-glow {
  stroke-width: 1.85;
  stroke-dasharray: 4 18;
  animation: settings-circuit-flow 1.05s linear infinite;
}

.settings-scan-glow-branch {
  stroke-width: 1.55;
  animation-duration: 1.65s;
}

.settings-scan-glow-late {
  animation-delay: -0.55s;
}

.settings-scan-node {
  fill: rgba(214, 160, 25, 0.38);
  stroke: currentColor;
  stroke-width: 0.8;
}

.settings-scan-node-live {
  fill: currentColor;
  animation: settings-circuit-node 1.05s ease-in-out infinite;
}

.settings-scan-node-late {
  animation-delay: -0.55s;
}

.settings-pcb-board {
  fill: rgba(214, 160, 25, 0.045);
  stroke: rgba(214, 160, 25, 0.46);
  stroke-width: 1;
}

.settings-pcb-copper,
.settings-pcb-current {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.settings-pcb-copper {
  stroke-width: 1.15;
  opacity: 0.32;
}

.settings-pcb-current {
  stroke-width: 1.75;
  stroke-dasharray: 4 16;
  animation: settings-circuit-flow 1.35s linear infinite;
}

.settings-pcb-current-branch {
  stroke-dasharray: 3 13;
  animation-duration: 1.8s;
}

.settings-pcb-current-late {
  animation-delay: -0.65s;
}

.settings-pcb-pad,
.settings-pcb-via {
  fill: rgba(214, 160, 25, 0.34);
  stroke: currentColor;
  stroke-width: 0.9;
}

.settings-pcb-via {
  opacity: 0.55;
}

.settings-pcb-pad-live {
  fill: currentColor;
  animation: settings-circuit-node 1.35s ease-in-out infinite;
}

.settings-pcb-pad-late {
  animation-delay: -0.65s;
}

.settings-circuit-badge-shell {
  fill: rgba(214, 160, 25, 0.1);
  stroke: rgba(214, 160, 25, 0.55);
  stroke-width: 1;
}

.settings-circuit-chip {
  fill: rgba(214, 160, 25, 0.18);
  stroke: rgba(255, 220, 125, 0.75);
  stroke-width: 1;
}

.settings-circuit-pin,
.settings-circuit-track,
.settings-circuit-pulse {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.settings-circuit-pin {
  stroke-width: 1.1;
  opacity: 0.48;
}

.settings-circuit-track {
  stroke-width: 1;
  opacity: 0.32;
}

.settings-circuit-pulse {
  stroke-width: 1.6;
  stroke-dasharray: 4 16;
  animation: settings-circuit-flow 1.2s linear infinite;
}

.settings-circuit-pulse-branch {
  stroke-dasharray: 3 13;
  animation-duration: 1.9s;
}

.settings-circuit-pulse-late {
  animation-delay: -0.65s;
}

.settings-circuit-core,
.settings-circuit-node {
  fill: currentColor;
  opacity: 0.9;
  animation: settings-circuit-node 1.45s ease-in-out infinite;
}

.settings-circuit-core {
  filter: drop-shadow(0 0 4px rgba(255, 220, 125, 0.9));
}

@keyframes settings-circuit-flow {
  to {
    stroke-dashoffset: -20;
  }
}

@keyframes settings-circuit-node {
  0%,
  100% {
    opacity: 0.45;
  }

  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-scan-glow,
  .settings-scan-node-live,
  .settings-pcb-current,
  .settings-pcb-pad-live,
  .settings-circuit-pulse,
  .settings-circuit-node {
    animation: none;
  }
}
</style>
