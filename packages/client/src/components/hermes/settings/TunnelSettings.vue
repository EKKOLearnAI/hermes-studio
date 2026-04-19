<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { NButton, NCard, NSpin, useMessage, NAlert } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getTunnelStatus, startTunnel, stopTunnel, type TunnelStatus } from '@/api/hermes/tunnel'

const { t } = useI18n()
const message = useMessage()

const status = ref<TunnelStatus>({ running: false, url: null })
const loading = ref(false)
const polling = ref<number | null>(null)

async function fetchStatus() {
  try {
    status.value = await getTunnelStatus()
  } catch (err) {
    console.error('Failed to fetch tunnel status:', err)
  }
}

async function handleStart() {
  loading.value = true
  try {
    const res = await startTunnel()
    if (res.success) {
      message.success(t('settings.tunnel.started'))
      await fetchStatus()
    } else {
      message.error(res.message || 'Failed to start tunnel')
    }
  } catch (err: any) {
    message.error(err.message || 'Failed to start tunnel')
  } finally {
    loading.value = false
  }
}

async function handleStop() {
  loading.value = true
  try {
    const res = await stopTunnel()
    if (res.success) {
      message.success(t('settings.tunnel.stoppedMsg'))
      await fetchStatus()
    }
  } catch (err: any) {
    message.error(err.message || 'Failed to stop tunnel')
  } finally {
    loading.value = false
  }
}

function copyUrl() {
  if (status.value.url) {
    navigator.clipboard.writeText(status.value.url)
    message.success(t('settings.tunnel.copied'))
  }
}

onMounted(() => {
  fetchStatus()
  polling.value = window.setInterval(fetchStatus, 5000)
})

onUnmounted(() => {
  if (polling.value) {
    clearInterval(polling.value)
  }
})
</script>

<template>
  <section class="settings-section">
    <NCard :title="t('settings.tunnel.title')">
      <template #header-extra>
        <NSpin v-if="loading" size="small" />
      </template>

      <NAlert v-if="!status.running && !status.url" type="info" :title="t('settings.tunnel.hintTitle')">
        {{ t('settings.tunnel.hint') }}
      </NAlert>

      <div v-if="status.running || status.url" class="tunnel-status">
        <div class="status-row">
          <span class="label">{{ t('settings.tunnel.status') }}:</span>
          <span :class="['value', status.running ? 'running' : 'stopped']">
            {{ status.running ? t('settings.tunnel.running') : t('settings.tunnel.stopped') }}
          </span>
        </div>

        <div v-if="status.url" class="url-row">
          <span class="label">{{ t('settings.tunnel.url') }}:</span>
          <div class="url-value">
            <code>{{ status.url }}</code>
            <NButton size="small" quaternary @click="copyUrl">
              {{ t('settings.tunnel.copy') }}
            </NButton>
          </div>
        </div>
      </div>

      <template #action>
        <NButton v-if="status.running" type="error" @click="handleStop" :disabled="loading">
          {{ t('settings.tunnel.stop') }}
        </NButton>
        <NButton v-else type="primary" @click="handleStart" :disabled="loading">
          {{ t('settings.tunnel.start') }}
        </NButton>
      </template>
    </NCard>
  </section>
</template>

<style scoped lang="scss">
.settings-section {
  margin-top: 16px;
}

.tunnel-status {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.status-row,
.url-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.label {
  font-weight: 500;
  color: var(--n-text-color-3);
}

.value.running {
  color: #18a058;
}

.value.stopped {
  color: #d03050;
}

.url-value {
  display: flex;
  align-items: center;
  gap: 8px;

  code {
    background: var(--n-color-hover);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 14px;
  }
}
</style>