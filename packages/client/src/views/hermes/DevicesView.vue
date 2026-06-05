<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchLanDevices,
  scanLanDevices,
  type LanDeviceInfo,
  type LanDiscoveryState,
  type LanEndpointKind,
} from '@/api/hermes/devices'

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const scanning = ref(false)
const state = ref<LanDiscoveryState>({
  scanning: false,
  last_scanned_at: null,
  devices: [],
})

const devices = computed(() =>
  [...state.value.devices].sort((a, b) => {
    const kindOrder = endpointOrder(a.endpoint_kind) - endpointOrder(b.endpoint_kind)
    if (kindOrder !== 0) return kindOrder
    return a.id.localeCompare(b.id)
  }),
)

function endpointOrder(kind: LanEndpointKind): number {
  if (kind === 'web') return 0
  if (kind === 'desktop') return 1
  return 2
}

function endpointLabel(kind: LanEndpointKind): string {
  return t(`devices.endpoint.${kind}`)
}

function endpointTagType(kind: LanEndpointKind) {
  if (kind === 'desktop') return 'success'
  if (kind === 'web') return 'info'
  return 'default'
}

function formatOs(device: LanDeviceInfo): string {
  const parts = [device.os.type || device.os.platform, device.os.release, device.os.arch]
    .filter(Boolean)
  return parts.join(' ')
}

function formatTime(value: string | null): string {
  if (!value) return t('devices.never')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatVersion(value: string): string {
  return value || t('devices.unknown')
}

function openDevice(device: LanDeviceInfo) {
  window.open(device.url, '_blank', 'noopener,noreferrer')
}

async function loadDevices() {
  loading.value = true
  try {
    state.value = await fetchLanDevices()
  } catch (err: any) {
    message.error(err?.message || t('devices.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function refreshDevices() {
  scanning.value = true
  try {
    state.value = await scanLanDevices()
  } catch (err: any) {
    message.error(err?.message || t('devices.scanFailed'))
  } finally {
    scanning.value = false
  }
}

onMounted(() => {
  void loadDevices()
})
</script>

<template>
  <div class="devices-view">
    <header class="page-header">
      <div>
        <h2 class="header-title">{{ t('devices.title') }}</h2>
        <div class="header-meta">
          <span>{{ t('devices.count', { count: devices.length }) }}</span>
          <span>{{ t('devices.lastScanned', { time: formatTime(state.last_scanned_at) }) }}</span>
        </div>
      </div>
      <NButton size="small" type="primary" :loading="scanning || state.scanning" @click="refreshDevices">
        {{ t('devices.refresh') }}
      </NButton>
    </header>

    <NSpin :show="loading" class="devices-spin">
      <div class="devices-content">
        <div v-if="devices.length === 0 && !loading" class="empty-state">
          <div class="empty-title">{{ t('devices.empty') }}</div>
          <NButton size="small" :loading="scanning || state.scanning" @click="refreshDevices">
            {{ t('devices.refresh') }}
          </NButton>
        </div>

        <div v-else class="devices-table-wrap">
          <table class="devices-table">
            <thead>
              <tr>
                <th>{{ t('devices.computer') }}</th>
                <th>{{ t('devices.endpointLabel') }}</th>
                <th>{{ t('devices.address') }}</th>
                <th>{{ t('devices.os') }}</th>
                <th>{{ t('devices.agentVersion') }}</th>
                <th>{{ t('devices.webUiVersion') }}</th>
                <th>{{ t('devices.responseMs') }}</th>
                <th>{{ t('devices.lastSeen') }}</th>
                <th class="actions-col"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="device in devices" :key="device.id">
                <td class="primary-cell">{{ device.computer_name || device.ip }}</td>
                <td>
                  <NTag size="small" :type="endpointTagType(device.endpoint_kind)" round>
                    {{ endpointLabel(device.endpoint_kind) }}
                  </NTag>
                </td>
                <td>
                  <a class="device-link" :href="device.url" target="_blank" rel="noopener noreferrer">
                    {{ device.ip }}:{{ device.http_port }}
                  </a>
                </td>
                <td>{{ formatOs(device) || t('devices.unknown') }}</td>
                <td>{{ formatVersion(device.hermes_agent_version) }}</td>
                <td>{{ formatVersion(device.hermes_web_ui_version) }}</td>
                <td>{{ device.response_ms }}ms</td>
                <td>{{ formatTime(device.last_seen_at) }}</td>
                <td class="actions-col">
                  <NButton size="tiny" quaternary @click="openDevice(device)">
                    {{ t('devices.open') }}
                  </NButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.devices-view {
  height: 100%;
  display: flex;
  flex-direction: column;
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

.header-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 6px;
  color: $text-muted;
  font-size: 12px;
}

.devices-spin {
  flex: 1;
  min-height: 0;

  :deep(.n-spin-container),
  :deep(.n-spin-content) {
    height: 100%;
  }
}

.devices-content {
  height: 100%;
  overflow: auto;
  padding: 20px;
}

.empty-state {
  height: 100%;
  min-height: 280px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: $text-muted;
}

.empty-title {
  font-size: 14px;
}

.devices-table-wrap {
  overflow-x: auto;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-card;
}

.devices-table {
  width: 100%;
  min-width: 980px;
  border-collapse: collapse;
  font-size: 13px;

  th,
  td {
    padding: 12px 14px;
    border-bottom: 1px solid $border-color;
    color: $text-secondary;
    text-align: left;
    white-space: nowrap;
  }

  th {
    background: $bg-secondary;
    color: $text-muted;
    font-weight: 600;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  tbody tr:hover td {
    background: rgba(var(--accent-primary-rgb), 0.04);
  }
}

.primary-cell {
  color: $text-primary;
  font-weight: 600;
}

.device-link {
  color: $accent-primary;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.actions-col {
  width: 72px;
  text-align: right;
}

@media (max-width: $breakpoint-mobile) {
  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .devices-content {
    padding: 12px;
  }
}
</style>
