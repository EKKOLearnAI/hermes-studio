<script setup lang="ts">
import { computed, ref } from 'vue'
import { NInput, NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/hermes/app'
import type { AvailableModelGroup, ProviderApiMode } from '@/api/hermes/system'

const props = defineProps<{
  provider: string
  model: string
  groups: AvailableModelGroup[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  select: [value: { provider: string; model: string; apiMode?: ProviderApiMode }]
}>()

const { t } = useI18n()
const appStore = useAppStore()
const showModal = ref(false)
const searchQuery = ref('')
const collapsedGroups = ref<Record<string, boolean>>({})

const groupsWithCustom = computed(() =>
  props.groups.map(group => ({
    ...group,
    models: [
      ...group.models,
      ...(appStore.customModels[group.provider] || []).filter(model => !group.models.includes(model)),
    ],
  })),
)

const selectedGroup = computed(() =>
  groupsWithCustom.value.find(group => group.provider === props.provider && group.models.includes(props.model)),
)

const selectedDisplayName = computed(() => {
  if (!props.model) return ''
  return selectedGroup.value
    ? appStore.displayModelName(props.model, props.provider)
    : props.model
})

const filteredGroups = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return groupsWithCustom.value
  return groupsWithCustom.value
    .map(group => ({
      ...group,
      models: group.models.filter(model => {
        const displayName = appStore.displayModelName(model, group.provider)
        return model.toLowerCase().includes(q) || displayName.toLowerCase().includes(q)
      }),
    }))
    .filter(group => group.models.length > 0 || group.label.toLowerCase().includes(q))
})

function openModal() {
  if (props.disabled) return
  collapsedGroups.value = {}
  searchQuery.value = ''
  showModal.value = true
}

function toggleGroup(provider: string) {
  collapsedGroups.value[provider] = !collapsedGroups.value[provider]
}

function isGroupCollapsed(provider: string) {
  return !!collapsedGroups.value[provider]
}

function isCustomModel(model: string, provider: string) {
  return (appStore.customModels[provider] || []).includes(model)
}

function modelAlias(model: string, provider: string) {
  return appStore.getModelAlias(model, provider)
}

function handleSelect(group: AvailableModelGroup, model: string) {
  if (group.model_meta?.[model]?.disabled) return
  emit('select', { provider: group.provider, model, apiMode: group.api_mode })
  showModal.value = false
}
</script>

<template>
  <div class="workflow-model-selector">
    <button class="model-trigger" type="button" :disabled="props.disabled" @click="openModal">
      <span class="model-name" :title="props.model">{{ selectedDisplayName || t('models.selectModel') }}</span>
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
            <span class="model-group-label">{{ group.label || group.provider }}</span>
            <span class="model-group-count">{{ group.models.length }}</span>
          </div>

          <div v-show="!isGroupCollapsed(group.provider)" class="model-group-items">
            <div
              v-for="model in group.models"
              :key="`${group.provider}:${model}`"
              class="model-item"
              :class="{
                active: model === props.model && group.provider === props.provider,
                disabled: !!group.model_meta?.[model]?.disabled,
              }"
              :title="group.model_meta?.[model]?.disabled ? t('models.disabledTooltip') : ''"
              @click="handleSelect(group, model)"
            >
              <span class="model-item-label">
                <span class="model-item-name">{{ appStore.displayModelName(model, group.provider) }}</span>
                <span v-if="modelAlias(model, group.provider)" class="model-item-id">
                  {{ t('models.aliasCanonical', { model }) }}
                </span>
              </span>
              <span v-if="group.model_meta?.[model]?.preview" class="model-badge-preview">{{ t('models.previewBadge') }}</span>
              <span v-if="group.model_meta?.[model]?.disabled" class="model-badge-disabled">{{ t('models.disabledBadge') }}</span>
              <span v-if="isCustomModel(model, group.provider)" class="model-badge-custom">{{ t('models.customBadge') }}</span>
              <svg v-if="model === props.model && group.provider === props.provider" class="model-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
        </div>

        <div v-if="filteredGroups.length === 0" class="model-empty">
          {{ searchQuery ? t('models.noResults') : t('models.noModels') }}
        </div>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workflow-model-selector {
  min-width: 0;
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

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
}

.model-name {
  flex: 1;
  min-width: 0;
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
  padding: 8px;
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

.model-item-label {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model-item-name,
.model-item-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: $font-code;
}

.model-item-name {
  font-size: 12px;
}

.model-item-id {
  color: $text-muted;
  font-size: 10px;
  font-weight: 400;
}

.model-check {
  flex-shrink: 0;
  color: $accent-primary;
}

.model-badge-preview,
.model-badge-custom,
.model-badge-disabled {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  letter-spacing: 0.03em;
}

.model-badge-preview {
  color: #fff;
  background: #d97706;
}

.model-badge-custom {
  color: #fff;
  background: $accent-primary;
}

.model-badge-disabled {
  color: $text-muted;
  background: transparent;
  border: 1px solid $border-color;
}

.model-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: $text-muted;
}
</style>
