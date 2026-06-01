import { computed, onUnmounted, ref, watch } from 'vue'
import { fetchConfig, type AppConfig } from '@/api/hermes/config'
import { listRooms, type RoomInfo } from '@/api/hermes/group-chat'
import { getLifeOsState, type LifeOsState } from '@/api/hermes/life-os'
import { getQuantLabSnapshot, type QuantLabSnapshot } from '@/api/hermes/quant-lab'
import { useAuroraAppWindowStore, type AuroraAppKind } from '@/stores/hermes/aurora-app-window'

export interface AuroraAppBriefMetric {
  label: string
  value: string
}

export interface AuroraAppBrief {
  eyebrow: string
  title: string
  summary: string
  metrics: AuroraAppBriefMetric[]
}

type NativeBriefAppKind = Extract<AuroraAppKind, 'quant-lab' | 'life-os' | 'group-chat' | 'channels'>
type BriefLoadMode = 'initial' | 'manual' | 'auto'

const BRIEF_TIMEOUT_MS = 6500
const BRIEF_AUTO_REFRESH_MS = 90_000

const channelPlatformKeys = [
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'matrix',
  'weixin',
  'wecom',
  'feishu',
  'dingtalk',
  'qqbot',
] as const

const appBriefs: Record<NativeBriefAppKind, AuroraAppBrief> = {
  'quant-lab': {
    eyebrow: 'Aurora Native Brief',
    title: 'Quant Lab command center',
    summary: 'Market signals open in a focused Aurora shell while the full legacy lab stays available below.',
    metrics: [
      { label: 'Top 10', value: 'Live' },
      { label: 'Paper', value: 'Guarded' },
      { label: 'Risk', value: 'Visible' },
    ],
  },
  'life-os': {
    eyebrow: 'Aurora Native Brief',
    title: 'LifeOS financial cockpit',
    summary: 'FIRE, cashflow, and net-worth work now launch as an immersive app instead of exposing the legacy sidebar.',
    metrics: [
      { label: 'Net Worth', value: 'Tracked' },
      { label: 'FIRE', value: 'On' },
      { label: 'Cashflow', value: 'Ready' },
    ],
  },
  'group-chat': {
    eyebrow: 'Aurora Native Brief',
    title: 'Group Chat command center',
    summary: 'Multi-agent rooms now open as an Aurora workspace with room state visible before you dive in.',
    metrics: [
      { label: 'Rooms', value: 'Loading' },
      { label: 'Active', value: 'Checking' },
      { label: 'Context', value: 'Ready' },
    ],
  },
  channels: {
    eyebrow: 'Aurora Native Brief',
    title: 'Platform Bridge control rail',
    summary: 'Telegram, Discord, and other platform bridges stay governed while opening without the legacy sidebar.',
    metrics: [
      { label: 'Enabled', value: 'Loading' },
      { label: 'Primary', value: 'Checking' },
      { label: 'Mode', value: 'Safe' },
    ],
  },
}

function isNativeBriefAppKind(kind: AuroraAppKind | undefined): kind is NativeBriefAppKind {
  return kind === 'quant-lab' || kind === 'life-os' || kind === 'group-chat' || kind === 'channels'
}

function formatCurrency(value: number, currency = 'TWD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value)
}

function formatPercent(value: number): string {
  return `${Number.isFinite(value) ? value.toFixed(1) : '0.0'}%`
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

function platformLabel(key: string): string {
  if (key === 'qqbot') return 'QQBot'
  if (key === 'wecom') return 'WeCom'
  if (key === 'weixin') return 'Weixin'
  return key.charAt(0).toUpperCase() + key.slice(1)
}

function isPlatformConfigured(config: AppConfig | null, key: string): boolean {
  if (!config) return false
  const direct = (config[key] || {}) as Record<string, any>
  const scoped = (config.platforms?.[key] || {}) as Record<string, any>
  return Boolean(
    direct.enabled === true ||
    scoped.enabled === true ||
    direct.token ||
    scoped.token ||
    direct.bot_token ||
    scoped.bot_token ||
    direct.account_id ||
    scoped.account_id ||
    direct.webhook_url ||
    scoped.webhook_url,
  )
}

function configuredChannelPlatforms(config: AppConfig | null): string[] {
  return channelPlatformKeys
    .filter(key => isPlatformConfigured(config, key))
    .map(platformLabel)
}

export function useAuroraAppBrief() {
  const appWindowStore = useAuroraAppWindowStore()
  const quantBriefSnapshot = ref<QuantLabSnapshot | null>(null)
  const lifeOsBriefState = ref<LifeOsState | null>(null)
  const groupChatBriefRooms = ref<RoomInfo[]>([])
  const channelsBriefConfig = ref<AppConfig | null>(null)
  const briefLoading = ref(false)
  const briefError = ref('')
  const briefUpdatedAt = ref('')
  let briefRefreshTimer: number | null = null
  let activeBriefController: AbortController | null = null

  function formatBriefUpdatedAt(value: string): string {
    if (!value) return 'Not refreshed yet'
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  }

  function abortActiveBriefRequest() {
    activeBriefController?.abort()
    activeBriefController = null
  }

  function withBriefTimeout<T>(promise: Promise<T>, label: string, controller: AbortController): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort()
        reject(new Error(`${label} is still preparing. Aurora is showing the app shell while the live brief catches up.`))
      }, BRIEF_TIMEOUT_MS)
    })

    return Promise.race([promise, timeout]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId)
    })
  }

  const activeBrief = computed<AuroraAppBrief | null>(() => {
    const kind = appWindowStore.activeApp?.kind
    if (kind === 'quant-lab') {
      const snapshot = quantBriefSnapshot.value
      if (!snapshot && !briefLoading.value && briefError.value) return appBriefs[kind]
      const topPick = snapshot?.topPicks?.[0]
      return {
        ...appBriefs[kind],
        summary: snapshot?.decision?.conclusion || appBriefs[kind].summary,
        metrics: [
          { label: 'Top Pick', value: topPick ? `${topPick.ticker} ${Math.round(topPick.score)}` : 'Loading' },
          { label: 'Action', value: topPick?.action || 'Ready' },
          { label: 'Coverage', value: snapshot?.dataHealth?.quoteCoverage || 'Checking' },
        ],
      }
    }
    if (kind === 'life-os') {
      const metrics = lifeOsBriefState.value?.computedMetrics
      if (!metrics && !briefLoading.value && briefError.value) return appBriefs[kind]
      return {
        ...appBriefs[kind],
        metrics: [
          { label: 'Net Worth', value: metrics ? formatCurrency(metrics.netWorth) : 'Loading' },
          { label: 'FIRE', value: metrics ? formatPercent(metrics.fireProgress) : 'Checking' },
          { label: 'Cashflow', value: metrics ? formatCurrency(metrics.netMonthlyCashFlow) : 'Ready' },
        ],
      }
    }
    if (kind === 'group-chat') {
      const rooms = groupChatBriefRooms.value
      const totalTokens = rooms.reduce((sum, room) => sum + (room.totalTokens || 0), 0)
      const firstRoom = rooms[0]?.name || 'No rooms'
      return {
        ...appBriefs[kind],
        summary: rooms.length > 0
          ? `${firstRoom} is ready for multi-agent collaboration inside Aurora.`
          : 'Create or join a room to begin multi-agent collaboration inside Aurora.',
        metrics: [
          { label: 'Rooms', value: String(rooms.length) },
          { label: 'Active', value: firstRoom },
          { label: 'Context', value: totalTokens > 0 ? formatCompactNumber(totalTokens) : 'Clean' },
        ],
      }
    }
    if (kind === 'channels') {
      const configured = configuredChannelPlatforms(channelsBriefConfig.value)
      const mentionSafe = channelPlatformKeys.some((key) => {
        const section = (channelsBriefConfig.value?.[key] || {}) as Record<string, any>
        return section.require_mention === true
      })
      return {
        ...appBriefs[kind],
        summary: configured.length > 0
          ? `${configured.slice(0, 3).join(', ')} ${configured.length > 3 ? 'and more ' : ''}are visible to Aurora without opening the legacy sidebar.`
          : 'No platform bridge credentials are visible yet. Configure them from this Aurora app surface.',
        metrics: [
          { label: 'Enabled', value: `${configured.length}/${channelPlatformKeys.length}` },
          { label: 'Primary', value: configured[0] || 'None' },
          { label: 'Mode', value: mentionSafe ? 'Mention Safe' : 'Manual' },
        ],
      }
    }
    return null
  })

  function clearBriefRefreshTimer() {
    if (!briefRefreshTimer) return
    window.clearInterval(briefRefreshTimer)
    briefRefreshTimer = null
  }

  function startBriefRefreshTimer(kind = appWindowStore.activeApp?.kind) {
    clearBriefRefreshTimer()
    if (!isNativeBriefAppKind(kind)) return
    briefRefreshTimer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || briefLoading.value) return
      void loadAppBrief(kind, 'auto')
    }, BRIEF_AUTO_REFRESH_MS)
  }

  async function loadAppBrief(kind = appWindowStore.activeApp?.kind, mode: BriefLoadMode = 'manual') {
    if (!isNativeBriefAppKind(kind)) return
    if (briefLoading.value) return
    briefLoading.value = true
    briefError.value = ''
    const requestKind = kind
    abortActiveBriefRequest()
    const controller = new AbortController()
    activeBriefController = controller
    try {
      if (kind === 'quant-lab') {
        const snapshot = await withBriefTimeout(
          getQuantLabSnapshot({ signal: controller.signal, fresh: mode === 'manual' }),
          'Quant Lab brief',
          controller,
        )
        if (appWindowStore.activeApp?.kind !== requestKind) return
        quantBriefSnapshot.value = snapshot
        briefUpdatedAt.value = snapshot.generatedAt || new Date().toISOString()
      } else if (kind === 'life-os') {
        const state = await withBriefTimeout(getLifeOsState({ signal: controller.signal }), 'LifeOS brief', controller)
        if (appWindowStore.activeApp?.kind !== requestKind) return
        lifeOsBriefState.value = state
        briefUpdatedAt.value = state.marketSettings?.updatedAt || new Date().toISOString()
      } else if (kind === 'group-chat') {
        const response = await withBriefTimeout(listRooms(), 'Group Chat brief', controller)
        if (appWindowStore.activeApp?.kind !== requestKind) return
        groupChatBriefRooms.value = response.rooms || []
        briefUpdatedAt.value = new Date().toISOString()
      } else {
        const config = await withBriefTimeout(fetchConfig([
          'telegram',
          'discord',
          'slack',
          'whatsapp',
          'matrix',
          'weixin',
          'wecom',
          'feishu',
          'dingtalk',
          'qqbot',
          'platforms',
        ]), 'Channels brief', controller)
        if (appWindowStore.activeApp?.kind !== requestKind) return
        channelsBriefConfig.value = config
        briefUpdatedAt.value = new Date().toISOString()
      }
    } catch (error: any) {
      if (appWindowStore.activeApp?.kind !== requestKind) return
      briefUpdatedAt.value = briefUpdatedAt.value || new Date().toISOString()
      briefError.value = error?.message || 'Aurora brief failed to load.'
    } finally {
      if (activeBriefController === controller) activeBriefController = null
      if (appWindowStore.activeApp?.kind === requestKind) {
        briefLoading.value = false
        if (mode === 'manual') startBriefRefreshTimer(requestKind)
      }
    }
  }

  watch(() => appWindowStore.activeApp?.kind, (kind) => {
    clearBriefRefreshTimer()
    abortActiveBriefRequest()
    briefLoading.value = false
    briefError.value = ''
    briefUpdatedAt.value = ''
    void loadAppBrief(kind, 'initial')
    startBriefRefreshTimer(kind)
  }, { immediate: true })

  onUnmounted(() => {
    clearBriefRefreshTimer()
    abortActiveBriefRequest()
  })

  return {
    activeBrief,
    briefLoading,
    briefError,
    briefUpdatedAt,
    formatBriefUpdatedAt,
    loadAppBrief,
  }
}
