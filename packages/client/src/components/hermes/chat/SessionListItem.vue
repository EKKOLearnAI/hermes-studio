<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import { NPopconfirm, NCheckbox, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Session } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { formatTimestampMs } from '@/shared/session-display'

const props = withDefaults(defineProps<{
  session: Session
  active: boolean
  pinned: boolean
  canDelete: boolean
  streaming?: boolean
  pendingInteraction?: 'approval' | 'clarify' | null
  selectable?: boolean
  selected?: boolean
  showProfile?: boolean
  to?: string
}>(), {
  showProfile: true,
})

const emit = defineEmits<{
  select: []
  contextmenu: [event: MouseEvent]
  delete: []
  'toggle-select': []
}>()

const { t } = useI18n()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const sessionModelName = computed(() =>
  props.session.model
    ? appStore.displayModelName(props.session.model, props.session.provider)
    : '',
)
const profileName = computed(() => props.session.profile || 'default')
const profileAvatar = computed(() => profilesStore.profiles.find(profile => profile.name === profileName.value)?.avatar)
const profileHasModels = computed(() => {
  const profileModels = appStore.profileModelGroups.find(profile => profile.profile === profileName.value)
  return !!profileModels?.groups?.some(group => group.models.length > 0)
})
const profileModelsMissing = computed(() =>
  appStore.profileModelGroups.length > 0 && !profileHasModels.value,
)
const pendingInteractionLabel = computed(() => {
  if (props.pendingInteraction === 'approval') return t('chat.sessionNeedsApproval')
  if (props.pendingInteraction === 'clarify') return t('chat.sessionNeedsClarify')
  return ''
})

let longPressTimer: ReturnType<typeof setTimeout> | null = null
const longPressTriggered = ref(false)

function onTouchStart(e: TouchEvent) {
  longPressTriggered.value = false
  longPressTimer = setTimeout(() => {
    longPressTriggered.value = true
    const touch = e.touches[0]
    const syntheticEvent = new MouseEvent('contextmenu', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      bubbles: true,
    })
    emit('contextmenu', syntheticEvent)
  }, 500)
}

function onTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function onTouchMove() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function isModifiedNavigation(event?: MouseEvent) {
  return !!event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
}

function onClick(event?: MouseEvent) {
  if (longPressTriggered.value) {
    longPressTriggered.value = false
    event?.preventDefault()
    return
  }
  if (isModifiedNavigation(event)) return
  if (props.to && !props.selectable) event?.preventDefault()
  emit('select')
}

onUnmounted(() => {
  if (longPressTimer) clearTimeout(longPressTimer)
})
</script>

<template>
  <component
    :is="selectable || !to ? 'button' : 'a'"
    class="session-item"
    :class="{ active, 'batch-mode': selectable, 'missing-models': profileModelsMissing }"
    :aria-current="active ? 'page' : undefined"
    :href="!selectable ? to : undefined"
    :type="selectable || !to ? 'button' : undefined"
    @click="onClick"
    @contextmenu="emit('contextmenu', $event)"
    @touchstart="onTouchStart"
    @touchend="onTouchEnd"
    @touchmove="onTouchMove"
  >
    <div v-if="selectable" class="session-item-checkbox">
      <NCheckbox :checked="selected" @click.stop="emit('toggle-select')" />
    </div>
    <div class="session-item-content">
      <span class="session-item-title-row">
        <span v-if="pinned" class="session-item-pin" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 17v5" />
            <path d="M5 8l14 0" />
            <path d="M8 3l8 0 0 5 3 5-14 0 3-5z" />
          </svg>
        </span>
        <span class="session-item-title">
          <svg v-if="streaming" class="session-item-streaming" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
          {{ session.title }}
        </span>
        <NTooltip v-if="profileModelsMissing" trigger="click" placement="top">
          <template #trigger>
            <button class="session-item-warning" type="button" @click.stop.prevent>
              !
            </button>
          </template>
          {{ t('chat.profileMissingModelsTip', { profile: profileName }) }}
        </NTooltip>
        <span
          v-if="pendingInteraction"
          class="session-interaction-badge"
          :class="`session-interaction-badge--${pendingInteraction}`"
        >
          {{ pendingInteractionLabel }}
        </span>
      </span>
      <span class="session-item-meta">
        <span v-if="sessionModelName" class="session-item-model" :title="session.model">{{ sessionModelName }}</span>
        <span class="session-item-time">{{ formatTimestampMs(session.createdAt) }}</span>
      </span>
      <span v-if="props.showProfile" class="session-item-profile">
        <ProfileAvatar class="session-item-profile-avatar" :name="profileName" :avatar="profileAvatar" :size="16" />
        <span class="session-item-profile-name">{{ profileName }}</span>
      </span>
    </div>
    <NPopconfirm v-if="canDelete && !selectable" @positive-click="emit('delete')">
      <template #trigger>
        <button class="session-item-delete" @click.stop.prevent>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </template>
      {{ t('chat.deleteSession') }}
    </NPopconfirm>
  </component>
</template>

<style scoped>
.session-item-profile {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  margin-top: 4px;
}

.session-item-profile-avatar {
  background: var(--bg-secondary);
}

.session-item-profile-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 16px;
  color: var(--text-muted);
}

.session-item-warning {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border: 1px solid rgba(180, 35, 24, 0.35);
  border-radius: 50%;
  background: rgba(220, 38, 38, 0.1);
  color: #b42318;
  font-size: 11px;
  font-weight: 700;
  line-height: 14px;
  cursor: pointer;
}

.session-interaction-badge {
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.session-interaction-badge--approval {
  color: var(--warning);
  background: rgba(var(--warning-rgb), 0.16);
  border: 1px solid rgba(var(--warning-rgb), 0.28);
}

.session-interaction-badge--clarify {
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.16);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.28);
}
</style>
