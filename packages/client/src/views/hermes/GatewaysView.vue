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
  <div class="gateways-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('gateways.title') }}</h2>
    </header>

    <div class="gateways-content">
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
              <div v-if="gw.diagnostics" class="gateway-diagnostics">
                <span class="diag-item">{{ gw.diagnostics.reason }}</span>
                <span class="diag-item">PID: {{ gw.diagnostics.pid_path }}</span>
                <span class="diag-item">Config: {{ gw.diagnostics.config_path }}</span>
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
  padding: 20px;
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

.gateway-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  background-color: $bg-card;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  transition: border-color $transition-fast;

  &:hover {
    border-color: $text-muted;
  }
}

.gateway-info {
  min-width: 0;
  flex: 1;
}

.gateway-name {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  margin-bottom: 4px;
}

.gateway-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.gateway-diagnostics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}

.meta-item {
  font-size: 12px;
  color: $text-muted;
}

.diag-item {
  max-width: 100%;
  font-size: 12px;
  color: $text-muted;
  background: rgba(127, 127, 127, 0.08);
  padding: 2px 8px;
  border-radius: 999px;
  overflow-wrap: anywhere;
  line-height: 1.5;
}

.gateway-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 8px;
}

@media (max-width: 640px) {
  .gateways-content {
    padding: 16px;
  }

  .gateway-card {
    align-items: stretch;
    flex-direction: column;
    padding: 16px;
  }

  .gateway-diagnostics {
    flex-direction: column;
    gap: 6px;
  }

  .diag-item {
    border-radius: $radius-sm;
  }

  .gateway-actions {
    justify-content: flex-start;
  }
}
</style>
