<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NDataTable, NEmpty, NModal, NPopconfirm, NSpin, NTabPane, NTabs, NTag, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import {
  createLanAppAuthorization,
  createCloudAppAuthorization,
  deleteAppConnection,
  fetchAppConnections,
  type AppConnection,
  type CloudAppAuthorizationResponse,
  type LanAppAuthorizationResponse,
} from '@/api/hermes/app-connections'

const { t } = useI18n()
const message = useMessage()
const loading = ref(false)
const connections = ref<AppConnection[]>([])
const showScanModal = ref(false)
const connectionTab = ref<'lan' | 'cloud'>('lan')
const authorizationLoading = ref(false)
const deletingConnectionId = ref<number | null>(null)
const lanAuthorization = ref<LanAppAuthorizationResponse | null>(null)
const cloudAuthorization = ref<CloudAppAuthorizationResponse | null>(null)
const qrCodeDataUrls = ref<Record<'lan' | 'cloud', string>>({ lan: '', cloud: '' })
const currentTimestamp = ref(Math.floor(Date.now() / 1000))
let countdownTimer: ReturnType<typeof setInterval> | null = null
let connectionPollTimer: ReturnType<typeof setInterval> | null = null
let scanConnectionVersions = new Map<string, number>()
let connectionsRequestInFlight = false

const CONNECTION_POLL_INTERVAL_MS = 3_000

const activeAuthorization = computed(() => connectionTab.value === 'lan'
  ? lanAuthorization.value
  : cloudAuthorization.value)
const activeQrCodeDataUrl = computed(() => qrCodeDataUrls.value[connectionTab.value])
const remainingSeconds = computed(() => Math.max(
  0,
  (activeAuthorization.value?.expires_at || 0) - currentTimestamp.value,
))
const authorizationExpired = computed(() => Boolean(activeAuthorization.value) && remainingSeconds.value === 0)
const remainingTime = computed(() => {
  const minutes = Math.floor(remainingSeconds.value / 60).toString().padStart(2, '0')
  const seconds = (remainingSeconds.value % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
})

const columns = computed<DataTableColumns<AppConnection>>(() => [
  {
    title: t('connections.app.deviceName'),
    key: 'device_name',
    minWidth: 160,
    ellipsis: { tooltip: true },
  },
  {
    title: t('connections.app.deviceCode'),
    key: 'device_code',
    minWidth: 200,
    ellipsis: { tooltip: true },
  },
  {
    title: t('connections.app.deviceBrand'),
    key: 'device_brand',
    minWidth: 120,
    ellipsis: { tooltip: true },
    render(row) {
      return row.device_brand || '-'
    },
  },
  {
    title: t('connections.app.deviceModel'),
    key: 'device_model',
    minWidth: 160,
    ellipsis: { tooltip: true },
    render(row) {
      return row.device_model || '-'
    },
  },
  {
    title: t('connections.app.connectionType'),
    key: 'connection_type',
    width: 140,
    render(row) {
      return t(`connections.app.connectionTypes.${row.connection_type}`)
    },
  },
  {
    title: t('connections.app.authorizedUser'),
    key: 'username',
    minWidth: 140,
    ellipsis: { tooltip: true },
    render(row) {
      return row.username || '-'
    },
  },
  {
    title: t('connections.app.connectionStatus'),
    key: 'online',
    width: 120,
    render(row) {
      if (row.online == null) return '-'
      return h(NTag, {
        size: 'small',
        type: row.online ? 'success' : 'default',
        bordered: false,
      }, { default: () => t(row.online ? 'connections.app.online' : 'connections.app.offline') })
    },
  },
  {
    title: t('connections.app.authorizationStatus'),
    key: 'active',
    width: 110,
    render(row) {
      return h(NTag, {
        size: 'small',
        type: row.active ? 'success' : 'default',
        bordered: false,
      }, { default: () => t(row.active ? 'connections.app.active' : 'connections.app.expired') })
    },
  },
  {
    title: t('connections.app.actions'),
    key: 'actions',
    width: 100,
    fixed: 'right',
    render(row) {
      return h(NPopconfirm, {
        positiveText: t('connections.app.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: () => deleteConnection(row),
      }, {
        default: () => t('connections.app.deleteConfirm', { name: row.device_name || row.device_code }),
        trigger: () => h(NButton, {
          size: 'small',
          type: 'error',
          quaternary: true,
          loading: deletingConnectionId.value === row.id,
        }, { default: () => t('connections.app.delete') }),
      })
    },
  },
])

function connectionIdentity(connection: AppConnection): string {
  return `${connection.device_code}:${connection.connection_type}`
}

async function loadConnections(options: { silent?: boolean; detectScanConnection?: boolean } = {}) {
  if (connectionsRequestInFlight) return
  connectionsRequestInFlight = true
  if (!options.silent) loading.value = true
  try {
    const response = await fetchAppConnections()
    connections.value = response.connections
    if (options.detectScanConnection && showScanModal.value) {
      const connected = response.connections.some(connection => (
        connection.active
        && connection.updated_at > (scanConnectionVersions.get(connectionIdentity(connection)) || 0)
      ))
      if (connected) {
        showScanModal.value = false
        lanAuthorization.value = null
        cloudAuthorization.value = null
        qrCodeDataUrls.value = { lan: '', cloud: '' }
        message.success(t('connections.app.connectionDetected'))
      }
    }
  } catch (error: any) {
    if (!options.silent) message.error(error?.message || t('connections.app.loadFailed'))
  } finally {
    connectionsRequestInFlight = false
    if (!options.silent) loading.value = false
  }
}

function authorizationErrorMessage(error: any): string {
  const code = String(error?.message || '')
  if (code === 'preconnection_refresh_rate_limited') return t('connections.app.refreshTooSoon')
  if (code === 'preconnection_refresh_limit_reached') return t('connections.app.refreshLimitReached')
  if (code === 'preconnection_expired') return t('connections.app.preconnectionExpired')
  if (code === 'app_relay_unavailable') return t('connections.app.cloudUnavailable')
  return error?.message || t('connections.app.authorizationFailed')
}

async function generateAuthorization(type: 'lan' | 'cloud', refresh = false) {
  if (authorizationLoading.value) return
  authorizationLoading.value = true
  try {
    const response = type === 'lan'
      ? await createLanAppAuthorization()
      : await createCloudAppAuthorization(refresh)
    const dataUrl = await QRCode.toDataURL(response.qr_payload, {
      width: 320,
      margin: 4,
      errorCorrectionLevel: 'L',
      color: { dark: '#111111', light: '#ffffff' },
    })
    currentTimestamp.value = Math.floor(Date.now() / 1000)
    if (type === 'lan') lanAuthorization.value = response as LanAppAuthorizationResponse
    else cloudAuthorization.value = response as CloudAppAuthorizationResponse
    qrCodeDataUrls.value = { ...qrCodeDataUrls.value, [type]: dataUrl }
  } catch (error: any) {
    message.error(authorizationErrorMessage(error))
  } finally {
    authorizationLoading.value = false
  }
}

async function deleteConnection(connection: AppConnection) {
  if (deletingConnectionId.value != null) return
  deletingConnectionId.value = connection.id
  try {
    await deleteAppConnection(connection.id)
    connections.value = connections.value.filter(item => item.id !== connection.id)
    message.success(t('connections.app.deleted'))
  } catch (error: any) {
    message.error(error?.message || t('connections.app.deleteFailed'))
  } finally {
    deletingConnectionId.value = null
  }
}

function openScanModal() {
  currentTimestamp.value = Math.floor(Date.now() / 1000)
  connectionTab.value = 'lan'
  scanConnectionVersions = new Map(
    connections.value.map(connection => [connectionIdentity(connection), connection.updated_at]),
  )
  showScanModal.value = true
  if (!lanAuthorization.value) {
    void generateAuthorization('lan')
  }
}

watch(connectionTab, (type) => {
  currentTimestamp.value = Math.floor(Date.now() / 1000)
  const authorization = type === 'lan' ? lanAuthorization.value : cloudAuthorization.value
  if (!authorization) {
    void generateAuthorization(type)
  }
})

onMounted(() => {
  void loadConnections()
  countdownTimer = setInterval(() => {
    currentTimestamp.value = Math.floor(Date.now() / 1000)
  }, 1000)
  connectionPollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    void loadConnections({ silent: true, detectScanConnection: true })
  }, CONNECTION_POLL_INTERVAL_MS)
})

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer)
  if (connectionPollTimer) clearInterval(connectionPollTimer)
})
</script>

<template>
  <section class="app-connections-panel">
    <header class="panel-header">
      <div class="panel-heading">
        <h2>{{ t('connections.tabs.app') }}</h2>
        <p>{{ t('connections.app.subtitle') }}</p>
      </div>
      <NButton size="small" type="primary" @click="openScanModal">
        {{ t('connections.app.scanToAdd') }}
      </NButton>
    </header>

    <div class="app-connections-table">
      <NDataTable
        size="small"
        :columns="columns"
        :data="connections"
        :loading="loading"
        bordered
        :single-line="false"
        :row-key="(row: AppConnection) => row.id"
        :scroll-x="1370"
        flex-height
      >
        <template #empty>
          <NEmpty size="small" :description="t('connections.app.empty')" />
        </template>
      </NDataTable>
    </div>
  </section>

  <NModal
    v-model:show="showScanModal"
    preset="card"
    style="width: 560px; max-width: calc(100vw - 32px)"
    :title="t('connections.app.scanModalTitle')"
    :bordered="false"
  >
    <NTabs v-model:value="connectionTab" type="line" animated>
      <NTabPane name="lan" :tab="t('connections.app.lanConnection')">
        <div class="connection-pane">
          <NSpin v-if="authorizationLoading && !lanAuthorization" size="small" />

          <template v-else-if="lanAuthorization">
            <div class="connection-qr" :class="{ 'connection-qr--expired': authorizationExpired }">
              <img :src="activeQrCodeDataUrl" :alt="t('connections.app.scanModalTitle')">
              <div v-if="authorizationExpired" class="connection-qr-expired">
                {{ t('connections.app.authorizationExpired') }}
              </div>
            </div>

            <div class="connection-meta">
              <div class="connection-countdown" :class="{ expired: authorizationExpired }">
                {{ authorizationExpired
                  ? t('connections.app.authorizationExpired')
                  : t('connections.app.remainingTime', { time: remainingTime }) }}
              </div>
              <NButton
                class="refresh-qr-button"
                size="small"
                quaternary
                :loading="authorizationLoading"
                @click="generateAuthorization('lan')"
              >
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                    <path d="M20 6v5h-5" />
                    <path d="M4 18v-5h5" />
                    <path d="M6.1 9a7 7 0 0 1 11.6-2.6L20 9" />
                    <path d="M17.9 15a7 7 0 0 1-11.6 2.6L4 15" />
                  </svg>
                </template>
                {{ t('connections.app.refreshQr') }}
              </NButton>
            </div>
          </template>
        </div>
      </NTabPane>

      <NTabPane name="cloud" :tab="t('connections.app.cloudConnection')">
        <div class="connection-pane">
          <NSpin v-if="authorizationLoading && !cloudAuthorization" size="small" />

          <template v-else-if="cloudAuthorization">
            <div class="connection-qr" :class="{ 'connection-qr--expired': authorizationExpired }">
              <img :src="activeQrCodeDataUrl" :alt="t('connections.app.scanModalTitle')">
              <div v-if="authorizationExpired" class="connection-qr-expired">
                {{ t('connections.app.authorizationExpired') }}
              </div>
            </div>

            <div class="connection-meta">
              <div class="connection-countdown" :class="{ expired: authorizationExpired }">
                {{ authorizationExpired
                  ? t('connections.app.authorizationExpired')
                  : t('connections.app.remainingTime', { time: remainingTime }) }}
              </div>
              <NButton
                class="refresh-qr-button"
                size="small"
                quaternary
                :loading="authorizationLoading"
                @click="generateAuthorization('cloud', true)"
              >
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                    <path d="M20 6v5h-5" />
                    <path d="M4 18v-5h5" />
                    <path d="M6.1 9a7 7 0 0 1 11.6-2.6L20 9" />
                    <path d="M17.9 15a7 7 0 0 1-11.6 2.6L4 15" />
                  </svg>
                </template>
                {{ t('connections.app.refreshQr') }}
              </NButton>
            </div>
          </template>
        </div>
      </NTabPane>
    </NTabs>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.app-connections-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.panel-header {
  flex: 0 0 auto;
  min-height: 68px;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid $border-color;
}

.panel-heading {
  min-width: 0;

  h2 {
    margin: 0;
    color: $text-primary;
    font-size: 16px;
    font-weight: 650;
    line-height: 22px;
  }

  p {
    margin: 2px 0 0;
    color: $text-muted;
    font-size: 12px;
    line-height: 18px;
  }
}

.app-connections-table {
  flex: 1 1 auto;
  height: 0;
  min-height: 0;
  padding: 16px 20px 20px;
  overflow: hidden;

  :deep(.n-data-table) {
    height: 100%;
    --n-td-color: var(--bg-card);
    --n-th-color: var(--bg-secondary);
    --n-border-color: var(--border-color);
    --n-td-text-color: var(--text-primary);
    --n-th-text-color: var(--text-secondary);
  }

  :deep(.n-data-table-base-table),
  :deep(.n-data-table-base-table-body) {
    height: 100%;
  }
}

.connection-pane {
  min-height: 374px;
  padding: 8px 0 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.connection-qr {
  position: relative;
  width: 320px;
  height: 320px;
  padding: 8px;
  border-radius: $radius-md;
  background: #ffffff;

  img {
    display: block;
    width: 100%;
    height: 100%;
  }

  &--expired img {
    filter: grayscale(1);
    opacity: 0.2;
  }
}

.connection-qr-expired {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.72);
}

.connection-countdown {
  color: $text-secondary;
  font-size: 13px;

  &.expired {
    color: $error;
  }
}

.connection-meta {
  width: 320px;
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.refresh-qr-button {
  flex: 0 0 auto;
}

@media (max-width: $breakpoint-mobile) {
  .panel-header {
    align-items: flex-start;
    flex-direction: column;
    padding: 12px;
  }

  .app-connections-table {
    padding: 12px;
  }

  .connection-qr {
    width: 240px;
    height: 240px;
  }

  .connection-pane {
    min-height: 294px;
  }

  .connection-meta {
    width: 240px;
  }

}
</style>
