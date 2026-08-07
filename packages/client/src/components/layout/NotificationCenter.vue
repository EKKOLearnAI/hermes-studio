<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NSpin, useNotification } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { disconnectNotificationSocket, onNotificationCreated } from '@/api/hermes/notification-socket'
import {
  deleteNotification,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationRecord,
} from '@/api/hermes/notifications'

const { t } = useI18n()
const router = useRouter()
const profilesStore = useProfilesStore()
const toast = useNotification()
const open = ref(false)
const loading = ref(false)
const error = ref('')
const notifications = ref<NotificationRecord[]>([])
const unreadCount = ref(0)
const loaded = ref(false)
const badge = computed(() => unreadCount.value > 99 ? '99+' : String(unreadCount.value || ''))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await fetchNotifications({ limit: 50 })
    if (loaded.value) {
      const existingIds = new Set(notifications.value.map(item => item.id))
      for (const item of [...result.notifications].reverse()) {
        if (!existingIds.has(item.id)) handleCreated(new CustomEvent('hermes:notification-created', { detail: item }))
      }
      notifications.value = result.notifications
    } else {
      notifications.value = result.notifications
    }
    unreadCount.value = result.unreadCount
    loaded.value = true
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function toggle() {
  open.value = !open.value
  if (open.value && !loaded.value && !loading.value && !error.value) void load()
}

async function openNotification(item: NotificationRecord) {
  if (item.unread) {
    await markNotificationRead(item.id)
    item.unread = false
    unreadCount.value = Math.max(0, unreadCount.value - 1)
  }
  if (item.source.route) await router.push(item.source.route)
}

async function readAll() {
  await markAllNotificationsRead()
  notifications.value = notifications.value.map(item => ({ ...item, unread: false }))
  unreadCount.value = 0
}

async function remove(item: NotificationRecord, event: Event) {
  event.stopPropagation()
  await deleteNotification(item.id)
  notifications.value = notifications.value.filter(candidate => candidate.id !== item.id)
  if (item.unread) unreadCount.value = Math.max(0, unreadCount.value - 1)
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return t('notifications.justNow')
  if (seconds < 3600) return t('notifications.minutesAgo', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('notifications.hoursAgo', { count: Math.floor(seconds / 3600) })
  return new Date(timestamp).toLocaleString()
}

function showToast(item: NotificationRecord) {
  const n = toast.create({
    title: item.title,
    content: item.body,
    meta: relativeTime(item.createdAt),
    type: item.severity,
    duration: item.severity === 'warning' || item.severity === 'error' ? 0 : 8000,
    action: item.source.route ? () => h(NButton, {
      text: true,
      type: 'primary',
      onClick: () => { void openNotification(item); n.destroy() },
    }, { default: () => t('notifications.view') }) : undefined,
  })
}

function handleCreated(event: Event) {
  const item = (event as CustomEvent<NotificationRecord>).detail
  if (!item || notifications.value.some(existing => existing.id === item.id)) return
  notifications.value = [item, ...notifications.value]
  if (item.unread) unreadCount.value += 1
  showToast(item)
}

let removeSocketListener: (() => void) | null = null
let refreshTimer: number | null = null
function subscribeSocket() {
  removeSocketListener?.()
  disconnectNotificationSocket()
  removeSocketListener = onNotificationCreated(item => handleCreated(new CustomEvent('hermes:notification-created', { detail: item })))
}

watch(() => profilesStore.activeProfileName, (next, previous) => {
  if (!previous || next === previous) return
  notifications.value = []
  unreadCount.value = 0
  loaded.value = false
  error.value = ''
  subscribeSocket()
  void load()
})

onMounted(() => {
  window.addEventListener('hermes:notification-created', handleCreated)
  subscribeSocket()
  refreshTimer = window.setInterval(() => void load(), 30000)
  void load()
})
onUnmounted(() => {
  window.removeEventListener('hermes:notification-created', handleCreated)
  if (refreshTimer !== null) window.clearInterval(refreshTimer)
  removeSocketListener?.()
  disconnectNotificationSocket()
})
</script>

<template>
  <div class="notification-center">
    <button data-testid="notification-bell" class="notification-bell" :aria-label="t('notifications.title')" @click="toggle">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
      <span v-if="badge" class="notification-badge">{{ badge }}</span>
    </button>
    <div v-if="open" class="notification-panel" role="dialog" :aria-label="t('notifications.title')">
      <header>
        <strong>{{ t('notifications.title') }}</strong>
        <NButton data-testid="notification-read-all" text :disabled="unreadCount === 0" @click="readAll">{{ t('notifications.readAll') }}</NButton>
      </header>
      <NSpin v-if="loading" size="small" />
      <div v-else-if="error" class="notification-state">
        <span>{{ t('notifications.loadFailed') }}</span>
        <NButton data-testid="notification-retry" size="small" @click="load">{{ t('common.retry') }}</NButton>
      </div>
      <div v-else-if="notifications.length === 0" class="notification-state">{{ t('notifications.empty') }}</div>
      <div v-else class="notification-list">
        <div v-for="item in notifications" :key="item.id" :data-testid="`notification-item-${item.id}`" class="notification-item" :class="{ unread: item.unread }" role="button" tabindex="0" @click="openNotification(item)" @keydown.enter="openNotification(item)">
          <span class="severity" :class="item.severity" />
          <span class="content"><strong>{{ item.title }}</strong><span>{{ item.body }}</span><small>{{ relativeTime(item.createdAt) }}</small></span>
          <button :data-testid="`notification-delete-${item.id}`" class="delete" :aria-label="t('notifications.delete')" @click="remove(item, $event)">×</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.notification-center { position: fixed; top: 14px; inset-inline-end: 18px; z-index: 2500; }
.notification-bell { position: relative; width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid $border-color; border-radius: 10px; color: $text-secondary; background: $bg-card; cursor: pointer; }
.notification-bell svg { width: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.notification-badge { position: absolute; top: -6px; inset-inline-end: -6px; min-width: 18px; height: 18px; padding: 0 4px; display: grid; place-items: center; border-radius: 9px; background: #ef4444; color: #fff; font-size: 10px; font-weight: 700; }
.notification-panel { position: absolute; top: 44px; inset-inline-end: 0; width: min(390px, calc(100vw - 28px)); max-height: min(620px, calc(100vh - 80px)); overflow: hidden; border: 1px solid $border-color; border-radius: 14px; background: $bg-card; box-shadow: 0 20px 50px rgba(0,0,0,.2); }
.notification-panel header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid $border-color; }
.notification-list { max-height: 520px; overflow: auto; }
.notification-item { width: 100%; display: flex; gap: 10px; align-items: flex-start; padding: 13px 14px; border: 0; border-bottom: 1px solid $border-color; background: transparent; color: $text-primary; text-align: start; cursor: pointer; }
.notification-item.unread { background: rgba(37, 99, 235, .07); }
.notification-item:hover { background: $bg-card-hover; }
.severity { flex: 0 0 auto; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: #64748b; }
.severity.success { background: #16a34a; } .severity.warning { background: #d97706; } .severity.error { background: #dc2626; }
.content { min-width: 0; flex: 1; display: grid; gap: 4px; }
.content strong, .content span { overflow: hidden; text-overflow: ellipsis; }
.content span { color: $text-secondary; font-size: 12px; white-space: nowrap; }
.content small { color: $text-muted; }
.delete { flex: 0 0 auto; border: 0; background: transparent; color: $text-muted; font-size: 18px; cursor: pointer; }
.notification-state { min-height: 120px; display: flex; gap: 12px; align-items: center; justify-content: center; color: $text-secondary; }
@media (max-width: 768px) { .notification-center { top: 12px; inset-inline-end: 12px; } }
</style>
