<script setup lang="ts">
import { computed, onMounted, ref, nextTick } from 'vue'
import { NButton, NTooltip, NDropdown, NModal, NInput, NEmpty, useMessage } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useChatStore } from '@/stores/hermes/chat'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  (e: 'switch', name: string): void
}>()

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()
const chatStore = useChatStore()

// ─── Create modal state ──────────────────────────────────────
const showCreateModal = ref(false)
const newProfileName = ref('')
const creating = ref(false)

// ─── Rename modal state ──────────────────────────────────────
const showRenameModal = ref(false)
const renameTarget = ref('')
const renameNewName = ref('')
const renaming = ref(false)

// ─── Computed ────────────────────────────────────────────────
const activeName = computed(() => profilesStore.activeProfileName ?? '')

// ─── Context menu options ────────────────────────────────────
function contextMenuOptions(profileName: string) {
  return [
    {
      label: t('gatewayTabs.rename', 'Rename'),
      key: 'rename',
      props: {
        onClick: () => openRenameModal(profileName),
      },
    },
    {
      label: t('gatewayTabs.export', 'Export'),
      key: 'export',
      props: {
        onClick: () => handleExport(profileName),
      },
    },
    {
      type: 'divider',
      key: 'd1',
    },
    {
      label: t('gatewayTabs.delete', 'Delete'),
      key: 'delete',
      props: {
        style: { color: 'var(--error)' },
        onClick: () => handleDelete(profileName),
      },
    },
  ]
}

// ─── Switch profile (smooth, no reload) ─────────────────────
async function handleSwitch(name: string) {
  if (name === activeName.value || profilesStore.switching) return
  const ok = await profilesStore.switchProfileSmooth(name)
  if (ok) {
    // Smooth switch: save current chat state, load new profile's state
    await chatStore.switchChatProfile(name)
    message.success(t('profiles.switchSuccess', { name }))
    emit('switch', name)
  }
}

// ─── Create profile ─────────────────────────────────────────
function openCreateModal() {
  newProfileName.value = ''
  showCreateModal.value = true
  nextTick(() => {
    const input = document.querySelector('.create-profile-input input') as HTMLInputElement
    input?.focus()
  })
}

async function handleCreate() {
  const name = newProfileName.value.trim()
  if (!name) {
    message.warning(t('gatewayTabs.nameRequired', 'Profile name is required'))
    return
  }
  creating.value = true
  try {
    const ok = await profilesStore.createProfile(name)
    if (ok) {
      message.success(t('gatewayTabs.created', { name }))
      showCreateModal.value = false
    } else {
      message.error(t('gatewayTabs.createFailed', 'Failed to create profile'))
    }
  } finally {
    creating.value = false
  }
}

// ─── Rename profile ─────────────────────────────────────────
function openRenameModal(profileName: string) {
  renameTarget.value = profileName
  renameNewName.value = profileName
  showRenameModal.value = true
  nextTick(() => {
    const input = document.querySelector('.rename-profile-input input') as HTMLInputElement
    input?.focus()
    input?.select()
  })
}

async function handleRename() {
  const newName = renameNewName.value.trim()
  if (!newName) {
    message.warning(t('gatewayTabs.nameRequired', 'Profile name is required'))
    return
  }
  if (newName === renameTarget.value) {
    showRenameModal.value = false
    return
  }
  renaming.value = true
  try {
    const ok = await profilesStore.renameProfile(renameTarget.value, newName)
    if (ok) {
      message.success(t('gatewayTabs.renamed', { from: renameTarget.value, to: newName }))
      showRenameModal.value = false
    } else {
      message.error(t('gatewayTabs.renameFailed', 'Failed to rename profile'))
    }
  } finally {
    renaming.value = false
  }
}

// ─── Delete profile ─────────────────────────────────────────
async function handleDelete(name: string) {
  if (name === activeName.value) {
    message.warning(t('gatewayTabs.cannotDeleteActive', 'Cannot delete the active profile'))
    return
  }
  const ok = await profilesStore.deleteProfile(name)
  if (ok) {
    message.success(t('gatewayTabs.deleted', { name }))
  } else {
    message.error(t('gatewayTabs.deleteFailed', 'Failed to delete profile'))
  }
}

// ─── Export profile ─────────────────────────────────────────
async function handleExport(name: string) {
  try {
    const ok = await profilesStore.exportProfile(name)
    if (!ok) {
      message.error(t('gatewayTabs.exportFailed', 'Failed to export profile'))
      return
    }
    message.success(t('gatewayTabs.exported', { name }))
  } catch {
    message.error(t('gatewayTabs.exportFailed', 'Failed to export profile'))
  }
}

// ─── Init ───────────────────────────────────────────────────
onMounted(() => {
  if (profilesStore.profiles.length === 0) {
    profilesStore.fetchProfiles()
  }
})
</script>

<template>
  <div class="gateway-tabs">
    <div class="tabs-label">{{ t('sidebar.profiles') }}</div>

    <div class="tabs-scroll">
      <div class="tabs-list">
        <NDropdown
          v-for="profile in profilesStore.profiles"
          :key="profile.name"
          :options="contextMenuOptions(profile.name)"
          :trigger="('contextmenu' as any)"
          placement="bottom-start"
        >
          <NTooltip :delay="400" placement="top">
            <template #trigger>
              <button
                class="tab-btn"
                :class="{
                  active: profile.name === activeName,
                  switching: profilesStore.switching && profile.name === activeName,
                }"
                :disabled="profilesStore.switching"
                @click="handleSwitch(profile.name)"
              >
                <span class="tab-dot" :class="profile.active ? 'running' : 'unknown'" />
                <span class="tab-name" :title="profile.alias || profile.name">
                  {{ profile.alias || profile.name }}
                </span>
              </button>
            </template>
            <div class="tab-tooltip">
              <div class="tooltip-name">{{ profile.name }}</div>
              <div class="tooltip-detail">{{ profile.model }}</div>
              <div class="tooltip-detail">{{ profile.gateway }}</div>
              <div v-if="profile.backend_url" class="tooltip-detail tooltip-backend">→ {{ profile.backend_url }}</div>
            </div>
          </NTooltip>
        </NDropdown>

        <NEmpty
          v-if="profilesStore.profiles.length === 0 && !profilesStore.loading"
          :description="t('gatewayTabs.noProfiles', 'No profiles')"
          size="small"
          class="tabs-empty"
        />
      </div>

      <NTooltip placement="top">
        <template #trigger>
          <NButton
            class="add-btn"
            size="tiny"
            quaternary
            circle
            @click="openCreateModal"
          >
            <template #icon>
              <span class="add-icon">+</span>
            </template>
          </NButton>
        </template>
        {{ t('gatewayTabs.newProfile', 'New Profile') }}
      </NTooltip>
    </div>

    <!-- Create modal -->
    <NModal
      v-model:show="showCreateModal"
      :title="t('gatewayTabs.createTitle', 'Create Profile')"
      preset="dialog"
      :positive-text="t('common.confirm', 'Confirm')"
      :negative-text="t('common.cancel', 'Cancel')"
      :loading="creating"
      @positive-click="handleCreate"
    >
      <NInput
        v-model:value="newProfileName"
        class="create-profile-input"
        :placeholder="t('gatewayTabs.namePlaceholder', 'Enter profile name')"
        @keydown.enter="handleCreate"
      />
    </NModal>

    <!-- Rename modal -->
    <NModal
      v-model:show="showRenameModal"
      :title="t('gatewayTabs.renameTitle', 'Rename Profile')"
      preset="dialog"
      :positive-text="t('common.confirm', 'Confirm')"
      :negative-text="t('common.cancel', 'Cancel')"
      :loading="renaming"
      @positive-click="handleRename"
    >
      <NInput
        v-model:value="renameNewName"
        class="rename-profile-input"
        :placeholder="t('gatewayTabs.namePlaceholder', 'Enter new name')"
        @keydown.enter="handleRename"
      />
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.gateway-tabs {
  padding: 0 12px;
  margin-bottom: 8px;
}

.tabs-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.tabs-scroll {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tabs-list {
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  flex: 1;
  min-width: 0;

  // Hide scrollbar but keep scrollable
  &::-webkit-scrollbar {
    display: none;
  }
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.tabs-empty {
  flex: 1;
  min-width: 0;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  font-family: $font-ui;
  cursor: pointer;
  white-space: nowrap;
  max-width: 130px;
  transition: all $transition-fast;
  flex-shrink: 0;

  &:hover:not(:disabled) {
    background: var(--bg-card-hover);
    color: $text-primary;
  }

  &.active {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);

    .tab-dot {
      border-color: var(--text-on-accent);
    }
  }

  &.switching {
    opacity: 0.6;
    pointer-events: none;
  }

  &:disabled {
    cursor: not-allowed;
  }
}

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  border: 1px solid var(--border-color);
  transition: background $transition-fast;

  &.running {
    background: var(--success);
  }

  &.starting {
    background: var(--warning);
  }

  &.stopped {
    background: var(--error);
  }

  &.unknown {
    background: var(--text-muted);
  }
}

.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  font-size: 16px;
  color: $text-muted;

  &:hover {
    color: $text-primary;
  }
}

.add-icon {
  line-height: 1;
}

.tab-tooltip {
  .tooltip-name {
    font-weight: 600;
    margin-bottom: 2px;
  }

  .tooltip-detail {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
  }
}
</style>
