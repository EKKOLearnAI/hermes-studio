<script setup lang="ts">
import { ref, computed } from 'vue'
import { NButton, NCheckbox, NCheckboxGroup, NModal, NInput, useMessage, useDialog } from 'naive-ui'
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

const showAliasListModal = ref(false)
const showAliasModal = ref(false)
const aliasProvider = ref('')
const aliasModel = ref('')
const aliasInput = ref('')

const showVisibilityModal = ref(false)
const visibilitySaving = ref(false)
const selectedVisibleModels = ref<string[]>([])

const sourceProvider = computed(() => modelsStore.allProviders.find(g => g.provider === props.provider.provider))
const allModels = computed(() => props.provider.available_models?.length ? props.provider.available_models : (sourceProvider.value?.models?.length ? sourceProvider.value.models : props.provider.models))
const visibilityRule = computed(() => appStore.getProviderVisibility(props.provider.provider))
const isFiltered = computed(() => visibilityRule.value.mode === 'include')
const visibleCountLabel = computed(() => `${props.provider.models.length}/${allModels.value.length}`)

function modelAlias(model: string) {
  return appStore.getModelAlias(model, props.provider.provider)
}

function modelDisplayName(model: string) {
  return appStore.displayModelName(model, props.provider.provider)
}

function openAliasEditor(model: string) {
  aliasProvider.value = props.provider.provider
  aliasModel.value = model
  aliasInput.value = appStore.getModelAlias(model, props.provider.provider)
  showAliasModal.value = true
}

async function saveAlias() {
  if (!aliasModel.value || !aliasProvider.value) return
  try {
    await appStore.setModelAlias(aliasModel.value, aliasProvider.value, aliasInput.value)
    showAliasModal.value = false
  } catch (e: any) {
    message.error(e.message || t('models.aliasSaveFailed'))
  }
}

async function clearAlias() {
  aliasInput.value = ''
  await saveAlias()
}

function openVisibilityModal() {
  const rule = appStore.getProviderVisibility(props.provider.provider)
  selectedVisibleModels.value = rule.mode === 'include' ? allModels.value.filter(m => rule.models.includes(m)) : [...allModels.value]
  showVisibilityModal.value = true
}

async function handleVisibilitySave() {
  if (selectedVisibleModels.value.length === 0) {
    message.error(t('models.visibilitySelectOne'))
    return
  }
  visibilitySaving.value = true
  try {
    const selected = selectedVisibleModels.value.filter(m => allModels.value.includes(m))
    const mode = selected.length === allModels.value.length ? 'all' : 'include'
    await appStore.setModelVisibility(props.provider.provider, { mode, models: selected })
    await modelsStore.fetchProviders()
    showVisibilityModal.value = false
    message.success(t('models.visibilitySaved'))
  } catch (e: any) {
    message.error(e.message || t('models.visibilitySaveFailed'))
  } finally {
    visibilitySaving.value = false
  }
}

function resetVisibility() {
  selectedVisibleModels.value = [...allModels.value]
}

function clearVisibility() {
  selectedVisibleModels.value = []
}

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
        <span class="info-value models-count">
          {{ isFiltered ? visibleCountLabel : provider.models.length }} {{ t('models.count') }}
        </span>
      </div>
      <div class="models-list">
        <button
          v-for="model in provider.models.slice(0, 20)"
          :key="model"
          class="model-tag model-tag-button"
          type="button"
          :title="t('models.aliasTitleFor', { model })"
          @click="openAliasEditor(model)"
        >
          <span class="model-tag-name">{{ modelDisplayName(model) }}</span>
          <span v-if="modelAlias(model)" class="model-tag-id">{{ model }}</span>
        </button>
        <span v-if="provider.models.length > 20" class="model-tag model-tag-more">
          +{{ provider.models.length - 20 }} {{ t('models.more') }}
        </span>
      </div>
    </div>

    <div class="card-actions">
      <NButton size="tiny" quaternary @click="showAliasListModal = true">{{ t('models.aliasManage') }}</NButton>
      <NButton size="tiny" quaternary @click="openVisibilityModal">{{ t('models.manageVisibleModels') }}</NButton>
      <NButton size="tiny" quaternary type="error" :loading="deleting" @click="handleDelete">{{ t('common.delete') }}</NButton>
    </div>

    <NModal
      v-model:show="showAliasListModal"
      preset="card"
      :title="t('models.aliasManageFor', { provider: displayName })"
      :style="{ width: 'min(560px, calc(100vw - 32px))' }"
      :mask-closable="true"
    >
      <div class="alias-list-hint">{{ t('models.aliasHint') }}</div>
      <div class="alias-list">
        <div v-for="model in provider.models" :key="model" class="alias-row">
          <div class="alias-row-text">
            <span class="alias-row-name">{{ modelDisplayName(model) }}</span>
            <code class="alias-row-id">{{ model }}</code>
          </div>
          <NButton size="tiny" quaternary @click="openAliasEditor(model)">{{ t('models.aliasEdit') }}</NButton>
        </div>
      </div>
    </NModal>

    <NModal
      v-model:show="showAliasModal"
      preset="card"
      :title="aliasModel ? t('models.aliasTitleFor', { model: aliasModel }) : t('models.aliasTitle')"
      :style="{ width: 'min(420px, calc(100vw - 32px))' }"
      :mask-closable="true"
    >
      <NInput
        v-model:value="aliasInput"
        :placeholder="t('models.aliasPlaceholder')"
        clearable
        @keydown.enter="saveAlias"
      />
      <div v-if="aliasModel" class="model-alias-canonical">
        {{ t('models.aliasCanonical', { model: aliasModel }) }}
      </div>
      <div class="model-alias-hint">{{ t('models.aliasHint') }}</div>
      <template #footer>
        <div class="model-alias-actions">
          <NButton quaternary :disabled="!appStore.getModelAlias(aliasModel, aliasProvider)" @click="clearAlias">
            {{ t('models.aliasUseOriginal') }}
          </NButton>
          <div class="model-alias-spacer" />
          <NButton @click="showAliasModal = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" @click="saveAlias">{{ t('common.save') }}</NButton>
        </div>
      </template>
    </NModal>

    <NModal
      v-model:show="showVisibilityModal"
      preset="card"
      :title="t('models.manageVisibleModelsFor', { name: displayName })"
      :style="{ width: 'min(560px, calc(100vw - 32px))' }"
      :mask-closable="!visibilitySaving"
    >
      <p class="visibility-hint">{{ t('models.visibilityHint') }}</p>
      <div class="visibility-count">
        {{ selectedVisibleModels.length }}/{{ allModels.length }} {{ t('models.count') }}
      </div>
      <div class="visibility-list">
        <NCheckboxGroup v-model:value="selectedVisibleModels">
          <NCheckbox
            v-for="model in allModels"
            :key="model"
            :value="model"
            class="visibility-model"
          >
            <code>{{ modelDisplayName(model) }}</code>
            <code v-if="modelAlias(model)" class="visibility-model-id">{{ model }}</code>
          </NCheckbox>
        </NCheckboxGroup>
      </div>
      <div class="visibility-actions">
        <NButton size="small" quaternary :disabled="visibilitySaving" @click="resetVisibility">
          {{ t('models.showAllModels') }}
        </NButton>
        <NButton size="small" quaternary :disabled="visibilitySaving" @click="clearVisibility">
          {{ t('models.clearVisibleModels') }}
        </NButton>
        <div class="visibility-action-spacer" />
        <NButton size="small" :disabled="visibilitySaving" @click="showVisibilityModal = false">
          {{ t('common.cancel') }}
        </NButton>
        <NButton size="small" type="primary" :loading="visibilitySaving" @click="handleVisibilitySave">
          {{ t('common.save') }}
        </NButton>
      </div>
    </NModal>
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
  gap: 5px;
  min-height: 22px;
  font-size: 10px;
  font-family: $font-code;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: $text-secondary;
  white-space: nowrap;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;

  &-more {
    background: rgba(var(--accent-primary-rgb), 0.15);
    color: $accent-primary;
    font-weight: 500;
  }
}

.model-tag-button {
  border: 0;
  cursor: pointer;
  text-align: left;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.16);
    color: $text-primary;
  }
}

.model-tag-name,
.model-tag-id {
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-tag-id {
  color: $text-muted;
  font-size: 9px;
}

.card-actions {
  display: flex;
  gap: 8px;
  border-top: 1px solid $border-light;
  padding-top: 10px;
}

.alias-list-hint,
.model-alias-hint {
  color: $text-muted;
  font-size: 12px;
}

.alias-list-hint {
  margin-bottom: 12px;
}

.alias-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 45vh;
  overflow-y: auto;
}

.alias-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
}

.alias-row-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.alias-row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-primary;
  font-family: $font-code;
  font-size: 12px;
}

.alias-row-id,
.model-alias-canonical {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-muted;
  font-family: $font-code;
  font-size: 11px;
}

.model-alias-canonical {
  margin-top: 8px;
}

.model-alias-hint {
  margin-top: 6px;
}

.model-alias-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-alias-spacer {
  flex: 1;
}

.visibility-hint {
  margin: 0 0 10px;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.5;
}

.visibility-count {
  color: $text-muted;
  font-size: 12px;
  margin-bottom: 10px;
}

.visibility-list {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  padding: 8px;
}

.visibility-model {
  display: flex;
  width: 100%;
  padding: 4px 2px;

  code {
    font-family: $font-code;
    font-size: 12px;
    color: $text-secondary;
  }
}

.visibility-model-id {
  margin-left: 6px;
  color: $text-muted !important;
  font-size: 11px !important;
}

.visibility-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.visibility-action-spacer {
  flex: 1;
}
</style>
