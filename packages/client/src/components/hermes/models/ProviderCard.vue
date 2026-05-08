<script setup lang="ts">
import { ref, computed } from 'vue'
import { NButton, useMessage, useDialog } from 'naive-ui'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { useModelsStore } from '@/stores/hermes/models'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { checkCopilotToken, disableCopilot } from '@/api/hermes/copilot-auth'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ provider: AvailableModelGroup }>()

const { t } = useI18n()
const modelsStore = useModelsStore()
const appStore = useAppStore()
const chatStore = useChatStore()
const message = useMessage()
const dialog = useDialog()

const isCustom = computed(() => !props.provider.builtin && props.provider.provider.startsWith('custom:'))
const isCopilot = computed(() => props.provider.provider === 'copilot')
const displayName = computed(() => props.provider.label)
const deleting = ref(false)

async function handleDelete() {
  let copilotMsg = ''
  if (isCopilot.value) {
    // 提前查 source，让用户清楚移除会不会影响 VS Code/gh CLI 等其他工具的登录态
    try {
      const status = await checkCopilotToken()
      if (status.source === 'env') copilotMsg = t('models.copilotDeleteHintEnv')
      else if (status.source === 'gh-cli') copilotMsg = t('models.copilotDeleteHintGhCli')
      else if (status.source === 'apps-json') copilotMsg = t('models.copilotDeleteHintAppsJson')
    } catch { /* ignore — fall back to generic confirm copy */ }
  }
  dialog.warning({
    title: t('models.deleteProvider'),
    content: isCopilot.value && copilotMsg
      ? `${t('models.deleteConfirm', { name: displayName.value })}\n\n${copilotMsg}`
      : t('models.deleteConfirm', { name: displayName.value }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      deleting.value = true
      try {
        if (isCopilot.value) {
          // Copilot 走显式 opt-in 模型：disable 把 enabled 置 false，
          // 仅当 token 来自 ~/.hermes/.env 时才清掉，gh-cli / apps.json 不动。
          await disableCopilot()
          // 服务端会在默认模型属于 copilot 时清掉 model.default，这里再清理本地
          // 会话级 model/provider，避免 Chat 页继续显示已下架的 copilot 模型。
          chatStore.clearProviderFromSessions('copilot')
          await Promise.all([modelsStore.fetchProviders(), appStore.loadModels()])
        } else {
          await modelsStore.removeProvider(props.provider.provider)
        }
        // 删完之后若已没有默认模型，自动从剩余 provider 里挑一个，避免 chat 页
        // "无默认模型"的尴尬态。与 hermes CLI `model` 子命令的隐含行为对齐。
        if (!appStore.selectedModel && appStore.modelGroups.length > 0) {
          const first = appStore.modelGroups.find(g => g.models.length > 0)
          if (first) {
            await appStore.switchModel(first.models[0], first.provider)
          }
        }
        message.success(t('models.providerDeleted'))
      } catch (e: any) {
        message.error(e.message)
      } finally {
        deleting.value = false
      }
    },
  })
}
</script>

<template>
  <div class="provider-card">
    <div class="card-header">
      <h3 class="provider-name">{{ displayName }}</h3>
      <span class="type-badge" :class="isCustom ? 'custom' : 'builtin'">
        {{ isCustom ? t('models.customType') : t('models.builtIn') }}
      </span>
    </div>

    <div class="card-body">
      <div class="info-row">
        <span class="info-label">{{ t('models.provider') }}</span>
        <code class="info-value mono">{{ provider.provider }}</code>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('models.baseUrl') }}</span>
        <code class="info-value mono">{{ provider.base_url }}</code>
      </div>
      <div class="info-row models-row">
        <span class="info-label">{{ t('models.models') }}</span>
        <span class="info-value models-count">{{ provider.models.length }} {{ t('models.count') }}</span>
      </div>
      <div class="models-list">
        <span
          v-for="model in provider.models.slice(0, 20)"
          :key="model"
          class="model-tag"
        >{{ model }}</span>
        <span v-if="provider.models.length > 20" class="model-tag model-tag-more">
          +{{ provider.models.length - 20 }} {{ t('models.more') }}
        </span>
      </div>
    </div>

    <div class="card-actions">
      <NButton size="tiny" quaternary type="error" :loading="deleting" @click="handleDelete">{{ t('common.delete') }}</NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.provider-card {
  background-color: $bg-card;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 16px;
  transition: border-color $transition-fast;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.3);
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.provider-name {
  font-size: 15px;
  font-weight: 600;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70%;
}

.type-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;

  &.builtin {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.custom {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.info-label {
  font-size: 12px;
  color: $text-muted;
}

.info-value {
  font-size: 12px;
  color: $text-secondary;
}

.mono {
  font-family: $font-code;
  font-size: 12px;
}

.models-row {
  margin-top: 4px;
}

.models-count {
  color: $text-muted;
  font-size: 12px;
}

.models-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 6px;
  height: 100px;
  overflow-y: auto;
  align-content: flex-start;
}

.model-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  font-size: 10px;
  font-family: $font-code;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: $text-secondary;
  white-space: nowrap;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;

  &-more {
    background: rgba(var(--accent-primary-rgb), 0.15);
    color: $accent-primary;
    font-weight: 500;
  }
}

.card-actions {
  display: flex;
  gap: 8px;
  border-top: 1px solid $border-light;
  padding-top: 10px;
}
</style>
