<script setup lang="ts">
import { ref, computed } from 'vue'
import { NModal, NInput, NSelect } from 'naive-ui'
import { useAppStore } from '@/stores/hermes/app'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const appStore = useAppStore()

const showModal = ref(false)
const searchQuery = ref('')
const collapsedGroups = ref<Record<string, boolean>>({})
const customInput = ref('')
const customProvider = ref('')

const providerOptions = computed(() => {
  const current = appStore.selectedProvider
  customProvider.value = current
  return appStore.modelGroups.map(g => ({ label: g.label, value: g.provider }))
})

const modelGroupsWithCustom = computed(() =>
  appStore.modelGroups.map(g => ({
    ...g,
    models: [
      ...g.models,
      ...(appStore.customModels[g.provider] || []).filter(m => !g.models.includes(m)),
    ],
  }))
)

const customModelSet = computed(() => {
  const set = new Set<string>()
  for (const models of Object.values(appStore.customModels)) {
    models.forEach(m => set.add(m))
  }
  return set
})

const filteredGroups = computed(() => {
  const q = searchQuery.value.toLowerCase().trim()
  if (!q) return modelGroupsWithCustom.value
  return modelGroupsWithCustom.value
    .map(g => ({
      ...g,
      models: g.models.filter(m => m.toLowerCase().includes(q)),
    }))
    .filter(g => g.models.length > 0 || g.label.toLowerCase().includes(q))
})

function toggleGroup(provider: string) {
  collapsedGroups.value[provider] = !collapsedGroups.value[provider]
}

function isGroupCollapsed(provider: string) {
  return !!collapsedGroups.value[provider]
}

function handleSelect(model: string, provider: string) {
  const meta = appStore.modelGroups.find(g => g.provider === provider)?.model_meta?.[model]
  if (meta?.disabled) return
  appStore.switchModel(model, provider)
  showModal.value = false
  searchQuery.value = ''
}

function handleCustomSubmit() {
  const model = customInput.value.trim()
  if (!model || !customProvider.value) return
  // 拦截 disabled 模型，避免 custom input 绕过列表里的灰显限制
  const meta = appStore.modelGroups.find(g => g.provider === customProvider.value)?.model_meta?.[model]
  if (meta?.disabled) return
  appStore.switchModel(model, customProvider.value)
  showModal.value = false
  searchQuery.value = ''
  customInput.value = ''
}

function openModal() {
  collapsedGroups.value = {}
  searchQuery.value = ''
  customInput.value = ''
  customProvider.value = appStore.selectedProvider
  showModal.value = true
}
</script>

<template>
  <div class="model-selector">
    <div class="model-label">{{ t('models.title') }}</div>
    <button class="model-trigger" @click="openModal">
      <span class="model-name" :title="appStore.selectedModel">{{ appStore.selectedModel || '—' }}</span>
      <svg class="model-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>

    <NModal
      v-model:show="showModal"
      preset="card"
      :title="t('models.title')"
      :style="{ width: 'min(480px, calc(100vw - 32px))' }"
      :mask-closable="true"
    >
      <NInput
        v-model:value="searchQuery"
        :placeholder="t('models.searchPlaceholder')"
        clearable
        size="small"
        class="model-search"
      />
      <div class="model-list">
        <div v-for="group in filteredGroups" :key="group.provider" class="model-group">
          <div class="model-group-header" @click="toggleGroup(group.provider)">
            <svg
              class="model-group-arrow"
              :class="{ collapsed: isGroupCollapsed(group.provider) }"
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span class="model-group-label">{{ group.label }}</span>
            <span class="model-group-count">{{ group.models.length }}</span>
          </div>
          <div v-show="!isGroupCollapsed(group.provider)" class="model-group-items">
            <div
              v-for="model in group.models"
              :key="model"
              class="model-item"
              :class="{
                active: model === appStore.selectedModel && group.provider === appStore.selectedProvider,
                disabled: !!group.model_meta?.[model]?.disabled,
              }"
              :title="group.model_meta?.[model]?.disabled ? t('models.disabledTooltip') : ''"
              @click="handleSelect(model, group.provider)"
            >
              <span class="model-item-name">{{ model }}</span>
              <span v-if="group.model_meta?.[model]?.preview" class="model-badge-preview">{{ t('models.previewBadge') }}</span>
              <span v-if="group.model_meta?.[model]?.disabled" class="model-badge-disabled">{{ t('models.disabledBadge') }}</span>
              <span v-if="customModelSet.has(model)" class="model-badge-custom">{{ t('models.customBadge') }}</span>
              <svg v-if="model === appStore.selectedModel && group.provider === appStore.selectedProvider" class="model-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
        </div>
        <div v-if="filteredGroups.length === 0" class="model-empty">
          {{ searchQuery ? 'No results' : 'No models' }}
        </div>
        <div class="model-custom">
          <div class="model-custom-row">
            <NSelect
              v-model:value="customProvider"
              :options="providerOptions"
              size="small"
              class="model-custom-provider"
            />
            <NInput
              v-model:value="customInput"
              :placeholder="t('models.customModelPlaceholder')"
              size="small"
              class="model-custom-input"
              @keydown.enter="handleCustomSubmit"
            />
          </div>
          <div class="model-custom-hint">
            {{ t('models.customModelHint') }}
          </div>
        </div>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.model-selector {
  padding: 0 12px;
  margin-bottom: 8px;
}

.model-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.model-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  background: $bg-input;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  color: $text-primary;
  font-size: 13px;
  cursor: pointer;
  transition: border-color $transition-fast;

  &:hover {
    border-color: $accent-muted;
  }
}

.model-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.model-arrow {
  flex-shrink: 0;
  color: $text-muted;
}

.model-search {
  margin-bottom: 12px;
}

.model-list {
  max-height: 50vh;
  overflow-y: auto;
  scrollbar-width: thin;
}

.model-group {
  margin-bottom: 4px;
}

.model-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px;
  font-size: 12px;
  font-weight: 600;
  color: $text-secondary;
  cursor: pointer;
  border-radius: $radius-sm;
  user-select: none;
  transition: background-color $transition-fast;

  &:hover {
    background-color: $bg-secondary;
  }
}

.model-group-arrow {
  flex-shrink: 0;
  transition: transform $transition-fast;

  &.collapsed {
    transform: rotate(-90deg);
  }
}

.model-group-label {
  flex: 1;
}

.model-group-count {
  font-size: 11px;
  color: $text-muted;
  font-weight: 400;
}

.model-group-items {
  padding-left: 8px;
}

.model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 13px;
  color: $text-secondary;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &.active {
    color: $accent-primary;
    font-weight: 500;
  }

  &.disabled {
    opacity: 0.45;
    cursor: not-allowed;

    &:hover {
      background-color: transparent;
      color: $text-secondary;
    }
  }
}

.model-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: $font-code;
  font-size: 12px;
}

.model-check {
  flex-shrink: 0;
  color: $accent-primary;
}

.model-badge-custom {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  color: #fff;
  background: $accent-primary;
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 4px;
  letter-spacing: 0.03em;
}

.model-badge-preview {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  color: #fff;
  background: #d97706;
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 4px;
  letter-spacing: 0.03em;
}

.model-badge-disabled {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  color: $text-muted;
  background: transparent;
  border: 1px solid $border-color;
  padding: 0 5px;
  border-radius: 3px;
  margin-right: 4px;
  letter-spacing: 0.03em;
}

.model-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: $text-muted;
}

.model-custom {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid $border-color;
}

.model-custom-row {
  display: flex;
  gap: 8px;
}

.model-custom-provider {
  width: 160px;
  flex-shrink: 0;
}

.model-custom-input {
  flex: 1;
}

.model-custom-hint {
  margin-top: 6px;
  font-size: 11px;
  color: $text-muted;
}
</style>
