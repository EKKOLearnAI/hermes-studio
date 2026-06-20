<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useSessionSearch } from '@/composables/useSessionSearch'

type ActiveSection = 'chat' | 'history' | 'group' | 'global'

const props = defineProps<{
  active: ActiveSection
  primaryLabel?: string
  hideModeSwitch?: boolean
}>()

const emit = defineEmits<{
  primary: []
}>()

const { t } = useI18n()
const router = useRouter()
const { openSessionSearch } = useSessionSearch()

const primaryText = computed(() => props.primaryLabel || t('chat.newChat'))
const showModeSwitch = computed(() => !props.hideModeSwitch)
const historyButtonLabel = computed(() =>
  props.active === 'history' ? t('chat.sessions') : t('sidebar.history'),
)

function openChat() {
  if (props.active === 'chat') return
  void router.push({ name: 'hermes.chat' })
}

function openHistory() {
  if (props.active === 'history') {
    void router.push({ name: 'hermes.chat' })
    return
  }
  void router.push({ name: 'hermes.history' })
}

function openGroupChat() {
  if (props.active === 'group') return
  void router.push({ name: 'hermes.groupChat' })
}

function openApiRelay() {
  if (typeof window === 'undefined') return
  window.open('https://apikey.fun/register?aff=LIBAPI', '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <div class="page-sidebar-nav">
    <div class="page-sidebar-tabs" role="tablist" aria-label="Chat actions">
      <button
        class="page-sidebar-tab"
        type="button"
        @click="emit('primary')"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>{{ primaryText }}</span>
      </button>
      <button class="page-sidebar-tab" type="button" @click="openSessionSearch">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span>{{ t('sidebar.search') }}</span>
      </button>
      <button
        class="page-sidebar-tab"
        type="button"
        @click="openHistory"
      >
        <svg
          v-if="active === 'history'"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <svg
          v-else
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span>{{ historyButtonLabel }}</span>
      </button>
      <button class="page-sidebar-tab" type="button" @click="openApiRelay">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
        <span>{{ t('sidebar.apiRelay') }}</span>
      </button>
    </div>
    <div v-if="showModeSwitch" class="conversation-switch" role="tablist" aria-label="Conversation type">
      <button
        class="conversation-switch-tab"
        :class="{ active: active === 'chat' || active === 'history' }"
        type="button"
        role="tab"
        :aria-selected="active === 'chat' || active === 'history'"
        @click="openChat"
      >
        {{ t('sidebar.singleChat') }}
      </button>
      <button
        class="conversation-switch-tab"
        :class="{ active: active === 'group' }"
        type="button"
        role="tab"
        :aria-selected="active === 'group'"
        @click="openGroupChat"
      >
        {{ t('sidebar.groupChat') }}
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.page-sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.page-sidebar-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-sidebar-tab {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  svg {
    flex-shrink: 0;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 18px;
  }

  &:hover,
  &.active {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.conversation-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.05);
}

.conversation-switch--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.conversation-switch-tab {
  min-width: 0;
  height: 28px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    color: $text-primary;
  }

  &.active {
    background: $bg-card;
    color: $text-primary;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
}
</style>
