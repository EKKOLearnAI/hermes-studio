<script setup lang="ts">
import { onMounted } from 'vue'
import { NSpin, NButton, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useGatewayStore } from '@/stores/hermes/gateways'

const { t } = useI18n()
const message = useMessage()
const gatewayStore = useGatewayStore()

onMounted(() => {
  gatewayStore.fetchStatus()
})

async function handleToggle(name: string, running: boolean) {
  try {
    if (running) {
      await gatewayStore.stop(name)
      message.success(`${t('gateways.stopped')}: ${name}`)
    } else {
      await gatewayStore.start(name)
      message.success(`${t('gateways.started')}: ${name}`)
    }
  } catch (err: any) {
    message.error(err.message)
  }
}
</script>

<template>
  <div class="gateways-view lg-page">
    <header class="lg-header lg-header-row">
      <h2 class="lg-title">{{ t('gateways.title') }}</h2>
    </header>

    <div class="gateways-content lg-body">
      <NSpin :show="gatewayStore.loading" size="large">
        <div v-if="gatewayStore.gateways.length === 0" class="empty-state">
          {{ t('common.noData') }}
        </div>

        <div v-else class="gateway-list">
          <div v-for="gw in gatewayStore.gateways" :key="gw.profile" class="gateway-card">
            <div class="gateway-info">
              <div class="gateway-name">{{ gw.profile }}</div>
              <div class="gateway-meta">
                <span class="meta-item">{{ gw.host }}:{{ gw.port }}</span>
                <span v-if="gw.pid" class="meta-item">PID: {{ gw.pid }}</span>
              </div>
            </div>
            <div class="gateway-actions">
              <NTag :type="gw.running ? 'success' : 'default'" size="small" round>
                {{ gw.running ? t('gateways.running') : t('gateways.stopped') }}
              </NTag>
              <NButton
                size="small"
                :type="gw.running ? 'warning' : 'primary'"
                round
                @click="handleToggle(gw.profile, gw.running)"
              >
                {{ gw.running ? t('common.stop') : t('common.start') }}
              </NButton>
            </div>
          </div>
        </div>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.gateways-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.gateways-content {
  flex: 1;
  overflow-y: auto;
}

.empty-state {
  text-align: center;
  color: $text-muted;
  padding: 40px 0;
}

.gateway-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lg-title {
  font-size: 22px;
  font-weight: 700;
  color: $text-primary;
  letter-spacing: -0.3px;
}

.gateway-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.5);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  border: 1px solid rgba(var(--border-color-rgb, 224, 224, 224), 0.2);
  border-radius: $radius-md;
  transition: all 0.25s ease;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.3);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  }

  .dark & {
    background: rgba(var(--bg-card-rgb, 51, 51, 51), 0.4);
  }
}

.gateway-meta {
  display: flex;
  gap: 12px;
}

.meta-item {
  font-size: 12px;
  color: $text-muted;
}

.gateway-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
