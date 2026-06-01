<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { clearApiKey } from '@/api/client'
import { switchLocale } from '@/i18n'
import { useChatStore } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useMemoryQueueStore } from '@/stores/hermes/memory-queue'
import { useAuroraCommanderStore } from '@/stores/hermes/aurora-commander'
import { useAuroraAppWindowStore, type AuroraAppKind } from '@/stores/hermes/aurora-app-window'
import { useAuroraIntentAuditStore } from '@/stores/hermes/aurora-intent-audit'
import {
  AURORA_DEFAULT_PINNED_APP_KINDS,
  AURORA_DESKTOP_PRESETS,
  AURORA_LAUNCHER_APPS,
  type AuroraDesktopPreset,
  type AuroraLauncherApp,
} from '@/services/hermes/aurora/capability-manifest'
import { fetchAuroraProfilePreferences, updateAuroraProfilePreferences } from '@/api/hermes/profiles'
import { getQuantLabMiroFishMemoryRecords, type QuantLabMiroFishMemoryRecord } from '@/api/hermes/quant-lab'
import { fetchAuroraComputeLoad, type AuroraComputeLoadTelemetry } from '@/api/aurora/compute-load'
import '@/services/hermes/aurora/aurora-event-bus'
import ResultOverlay from '@/components/hermes/aurora/ResultOverlay.vue'
import AppWindowOverlay from '@/components/hermes/aurora/AppWindowOverlay.vue'
import AuroraRibbonLogo from '@/components/hermes/aurora/AuroraRibbonLogo.vue'
import VibeCodingOverlay from '@/components/hermes/vibe-coding/VibeCodingOverlay.vue'

const chatStore = useChatStore()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const memoryQueueStore = useMemoryQueueStore()
const commanderStore = useAuroraCommanderStore()
const appWindowStore = useAuroraAppWindowStore()
const intentAuditStore = useAuroraIntentAuditStore()
const router = useRouter()
const { t, locale } = useI18n()
const appMenuOpen = ref(false)
const modelMenuOpen = ref(false)
const userMenuOpen = ref(false)
const desktopConfigInput = ref<HTMLInputElement | null>(null)
const desktopConfigMessage = ref('')
const desktopConfigSyncState = ref<'idle' | 'syncing' | 'synced' | 'local'>('idle')
const desktopConfigLastSyncedAt = ref('')
const memoryStreamRecords = ref<QuantLabMiroFishMemoryRecord[]>([])
const memoryStreamLoading = ref(false)
const memoryStreamError = ref('')
const computeLoad = ref<AuroraComputeLoadTelemetry | null>(null)
const isDockExpanded = ref(false)
let computeLoadTimer: number | null = null

type AuroraDockToolKind = 'files' | 'calendar' | 'mail' | 'memory' | 'chart' | 'sandbox'

interface AuroraDockTool {
  id: AuroraDockToolKind
  labelKey: string
  descriptionKey: string
  appKind: AuroraAppKind
}

const LEGACY_PINNED_APPS_STORAGE_KEY = 'aurora.launcher.pinned-apps.v1'
const PINNED_APPS_STORAGE_KEY_PREFIX = 'aurora.launcher.pinned-apps.v2.'
const defaultPinnedApps: AuroraAppKind[] = [...AURORA_DEFAULT_PINNED_APP_KINDS]
const baseAuroraLauncherApps: AuroraLauncherApp[] = [...AURORA_LAUNCHER_APPS]
const desktopPresets: AuroraDesktopPreset[] = [...AURORA_DESKTOP_PRESETS]
const auroraDockTools: AuroraDockTool[] = [
  {
    id: 'files',
    labelKey: 'aurora.dock.files',
    descriptionKey: 'aurora.dock.filesDesc',
    appKind: 'files',
  },
  {
    id: 'calendar',
    labelKey: 'aurora.dock.calendar',
    descriptionKey: 'aurora.dock.calendarDesc',
    appKind: 'jobs',
  },
  {
    id: 'mail',
    labelKey: 'aurora.dock.mail',
    descriptionKey: 'aurora.dock.mailDesc',
    appKind: 'channels',
  },
  {
    id: 'memory',
    labelKey: 'aurora.dock.memory',
    descriptionKey: 'aurora.dock.memoryDesc',
    appKind: 'memory',
  },
  {
    id: 'chart',
    labelKey: 'aurora.dock.chart',
    descriptionKey: 'aurora.dock.chartDesc',
    appKind: 'tradingview',
  },
  {
    id: 'sandbox',
    labelKey: 'aurora.dock.sandbox',
    descriptionKey: 'aurora.dock.sandboxDesc',
    appKind: 'mirofish',
  },
]

function currentProfileName(): string {
  return profilesStore.activeProfileName || localStorage.getItem('hermes_active_profile_name') || 'default'
}

function pinnedAppsStorageKey(profileName = currentProfileName()): string {
  return `${PINNED_APPS_STORAGE_KEY_PREFIX}${encodeURIComponent(profileName)}`
}

function localPinnedAppsSnapshot(profileName = currentProfileName()): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(pinnedAppsStorageKey(profileName))
    || window.localStorage.getItem(LEGACY_PINNED_APPS_STORAGE_KEY)
}

function readPinnedApps(profileName = currentProfileName()): AuroraAppKind[] {
  if (typeof window === 'undefined') return defaultPinnedApps
  try {
    const raw = localPinnedAppsSnapshot(profileName)
    const parsed = JSON.parse(raw || 'null')
    if (!Array.isArray(parsed)) return defaultPinnedApps
    const allowed = new Set(baseAuroraLauncherApps.map(app => app.kind))
    const normalized = parsed.filter((kind): kind is AuroraAppKind =>
      typeof kind === 'string' && allowed.has(kind as AuroraAppKind),
    )
    return normalized.length > 0 ? normalized : defaultPinnedApps
  } catch {
    return defaultPinnedApps
  }
}

const pinnedProfileName = ref(currentProfileName())
const pinnedAppKinds = ref<AuroraAppKind[]>(readPinnedApps(pinnedProfileName.value))

const isAuroraEnglish = computed(() => String(locale.value).toLowerCase().startsWith('en'))
const auroraLanguageLabel = computed(() =>
  isAuroraEnglish.value ? t('aurora.topbar.languageEn') : t('aurora.topbar.languageZh'),
)

function activeIntlLocale(): string {
  return isAuroraEnglish.value ? 'en-US' : String(locale.value || 'zh-TW')
}

function toggleAuroraLocale() {
  const nextLocale = isAuroraEnglish.value ? 'zh-TW' : 'en-US'
  switchLocale(nextLocale)
  localStorage.setItem('hermes_locale', nextLocale)
}

const desktopConfigSource = computed(() => {
  if (desktopConfigSyncState.value === 'synced') {
    return {
      label: t('aurora.topbar.profileSynced'),
      tone: 'synced',
      detail: t('aurora.topbar.profileSyncedDetail', { profile: pinnedProfileName.value }),
    }
  }
  if (desktopConfigSyncState.value === 'syncing') {
    return {
      label: t('aurora.topbar.syncing'),
      tone: 'syncing',
      detail: t('aurora.topbar.syncingDetail'),
    }
  }
  if (desktopConfigSyncState.value === 'local') {
    return {
      label: t('aurora.topbar.localFallback'),
      tone: 'local',
      detail: t('aurora.topbar.localFallbackDetail'),
    }
  }
  return {
    label: t('aurora.topbar.localReady'),
    tone: 'idle',
    detail: t('aurora.topbar.localReadyDetail'),
  }
})

const desktopConfigSourceDetail = computed(() => {
  const updated = desktopConfigLastSyncedAt.value
    ? t('aurora.topbar.lastSync', { time: new Intl.DateTimeFormat(activeIntlLocale(), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(desktopConfigLastSyncedAt.value)) })
    : ''
  return `${desktopConfigSource.value.detail}${updated}`
})

function isPinnedApp(kind: AuroraAppKind): boolean {
  return pinnedAppKinds.value.includes(kind)
}

function persistPinnedApps() {
  try {
    window.localStorage.setItem(pinnedAppsStorageKey(pinnedProfileName.value), JSON.stringify(pinnedAppKinds.value))
  } catch {
    // Pin preferences are cosmetic and should not block the shell.
  }
  void syncPinnedAppsToProfile()
}

async function syncPinnedAppsToProfile() {
  desktopConfigSyncState.value = 'syncing'
  try {
    await updateAuroraProfilePreferences(pinnedProfileName.value, {
      desktop: {
        pinnedApps: pinnedAppKinds.value,
      },
    })
    desktopConfigSyncState.value = 'synced'
    desktopConfigLastSyncedAt.value = new Date().toISOString()
  } catch {
    desktopConfigSyncState.value = 'local'
  }
}

async function hydratePinnedApps(profileName = currentProfileName()) {
  pinnedProfileName.value = profileName
  pinnedAppKinds.value = readPinnedApps(profileName)
  desktopConfigSyncState.value = 'syncing'
  try {
    const response = await fetchAuroraProfilePreferences(profileName)
    if (pinnedProfileName.value !== profileName) return
    if (response.storage === 'default' && localPinnedAppsSnapshot(profileName)) {
      desktopConfigSyncState.value = 'local'
      void syncPinnedAppsToProfile()
      return
    }
    const remotePins = normalizeDesktopPinnedApps({
      pinnedApps: response.preferences.desktop.pinnedApps,
    })
    pinnedAppKinds.value = remotePins.length ? remotePins : defaultPinnedApps
    window.localStorage.setItem(pinnedAppsStorageKey(profileName), JSON.stringify(pinnedAppKinds.value))
    desktopConfigSyncState.value = response.storage === 'profile' ? 'synced' : 'local'
    desktopConfigLastSyncedAt.value = response.preferences.desktop.updatedAt || response.preferences.updatedAt || ''
  } catch {
    desktopConfigSyncState.value = 'local'
  }
}

function togglePinnedApp(kind: AuroraAppKind) {
  const next = isPinnedApp(kind)
    ? pinnedAppKinds.value.filter(current => current !== kind)
    : [...pinnedAppKinds.value, kind]
  pinnedAppKinds.value = next.length > 0 ? next : defaultPinnedApps
  persistPinnedApps()
}

function exportAuroraDesktopConfig() {
  const profileName = pinnedProfileName.value
  const snapshot = {
    exportedAt: new Date().toISOString(),
    source: 'Aurora OS Desktop Config',
    schemaVersion: 1,
    profileName,
    pinnedApps: pinnedAppKinds.value,
    launcherApps: baseAuroraLauncherApps.map(app => ({
      kind: app.kind,
      label: app.label,
    })),
  }
  const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `aurora-desktop-${profileName}-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
  desktopConfigMessage.value = t('aurora.topbar.exportSuccess', { profile: profileName })
}

function normalizeDesktopPinnedApps(value: unknown): AuroraAppKind[] {
  const source = value && typeof value === 'object'
    ? (value as { pinnedApps?: unknown }).pinnedApps
    : null
  if (!Array.isArray(source)) return []
  const allowed = new Set(baseAuroraLauncherApps.map(app => app.kind))
  return source.filter((kind): kind is AuroraAppKind =>
    typeof kind === 'string' && allowed.has(kind as AuroraAppKind),
  )
}

function openDesktopConfigImport() {
  desktopConfigMessage.value = ''
  desktopConfigInput.value?.click()
}

async function importAuroraDesktopConfig(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  try {
    const parsed = JSON.parse(await file.text())
    const importedPins = normalizeDesktopPinnedApps(parsed)
    if (importedPins.length === 0) {
      desktopConfigMessage.value = t('aurora.topbar.importInvalid')
      return
    }
    pinnedAppKinds.value = importedPins
    persistPinnedApps()
    desktopConfigMessage.value = t('aurora.topbar.importSuccess', {
      count: importedPins.length,
      profile: pinnedProfileName.value,
    })
  } catch {
    desktopConfigMessage.value = t('aurora.topbar.importFailed')
  }
}

function applyDesktopPreset(preset: AuroraDesktopPreset) {
  pinnedAppKinds.value = [...preset.pinnedApps]
  persistPinnedApps()
  desktopConfigMessage.value = t('aurora.topbar.presetApplied', { preset: preset.label })
  intentAuditStore.record({
    input: `desktop-preset:${preset.id}`,
    status: 'completed',
    summary: t('aurora.topbar.presetApplied', { preset: preset.label }),
    payload: {
      presetId: preset.id,
      profileName: pinnedProfileName.value,
      pinnedApps: preset.pinnedApps,
    },
  })
}

const auroraLauncherApps = computed(() => {
  const baseOrder = new Map(baseAuroraLauncherApps.map((app, index) => [app.kind, index]))
  const lastOpened = new Map<AuroraAppKind, number>()

  for (const record of intentAuditStore.records) {
    if (record.status !== 'app_opened' || !record.appKind || lastOpened.has(record.appKind)) continue
    lastOpened.set(record.appKind, Date.parse(record.timestamp) || 0)
  }

  return [...baseAuroraLauncherApps].sort((left, right) => {
    const leftPinned = isPinnedApp(left.kind)
    const rightPinned = isPinnedApp(right.kind)
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
    if (leftPinned && rightPinned) {
      return pinnedAppKinds.value.indexOf(left.kind) - pinnedAppKinds.value.indexOf(right.kind)
    }
    const recentDiff = (lastOpened.get(right.kind) || 0) - (lastOpened.get(left.kind) || 0)
    if (recentDiff !== 0) return recentDiff
    return (baseOrder.get(left.kind) || 0) - (baseOrder.get(right.kind) || 0)
  })
})

const expandedDockApps = computed(() =>
  auroraLauncherApps.value.filter(app => !['life-os', 'quant-lab'].includes(app.kind)),
)

const recentMemoryVerdicts = computed(() => memoryStreamRecords.value.slice(0, 4))

const sessionTitle = computed(() => chatStore.activeSession?.title || t('aurora.omnibar.newIntent'))
const runState = computed(() => (chatStore.isRunActive ? t('aurora.omnibar.processing') : t('aurora.topbar.ready')))
const selectedModelName = computed(() =>
  appStore.displayModelName(appStore.selectedModel, appStore.selectedProvider) || 'Select model',
)
const displayWebUiVersion = computed(() => '0.1')
const modelOptions = computed(() =>
  appStore.modelGroups.flatMap(group => [
    ...group.models,
    ...(appStore.customModels[group.provider] || []).filter(model => !group.models.includes(model)),
  ].map(model => ({
    id: `${group.provider}:${model}`,
    provider: group.provider,
    groupLabel: group.label,
    model,
    label: appStore.displayModelName(model, group.provider),
    disabled: !!group.model_meta?.[model]?.disabled,
  }))),
)
const totalTokens = computed(() =>
  (chatStore.activeSession?.inputTokens ?? 0) + (chatStore.activeSession?.outputTokens ?? 0),
)
const computeLoadLevel = computed(() => {
  const load = computeLoad.value
  if (!load) return 0
  return Math.min(1, (load.activeCount + load.queuedCount) / Math.max(load.maxConcurrency + 4, 1))
})
const computeLoadLabel = computed(() => {
  const load = computeLoad.value
  if (!load) return 'Compute idle'
  return `Compute ${load.activeCount}/${load.maxConcurrency}${load.queuedCount ? ` · Q${load.queuedCount}` : ''}`
})
const computeSparklineBars = computed(() => {
  const load = computeLoad.value
  const active = load?.activeCount || 0
  const queued = load?.queuedCount || 0
  return [0, 1, 2, 3].map(index => ({
    active: index < active,
    queued: index >= active && index < active + queued,
  }))
})
const hasChatHistory = computed(() =>
  chatStore.messages.length > 0 ||
  (chatStore.activeSession?.messageCount ?? 0) > 0 ||
  chatStore.isLoadingMessages,
)
const isAuroraIdle = computed(() =>
  !appStore.isAdvancedConsoleOpen &&
  !chatStore.isRunActive &&
  !commanderStore.isVisible &&
  !appWindowStore.isOpen &&
  !hasChatHistory.value,
)

function goHome() {
  returnToAuroraDesktop()
}

function returnToAuroraDesktop() {
  closeTopBarMenus()
  isDockExpanded.value = false
  appWindowStore.closeApp()
  appStore.requestAuroraDesktop()
  void router.push('/aurora')
}

function openHistory() {
  openAuroraApp('history', 'nav:history')
}

function closeTopBarMenus() {
  appMenuOpen.value = false
  modelMenuOpen.value = false
  userMenuOpen.value = false
}

function handleDocumentPointer(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.closest('.aurora-top-bar')) return
  closeTopBarMenus()
}

function selectModel(model: string, provider: string) {
  void appStore.switchModel(model, provider)
  appMenuOpen.value = false
  modelMenuOpen.value = false
}

function openAuroraApp(kind: AuroraAppKind, input?: string, payload: Record<string, unknown> | null = null) {
  closeTopBarMenus()
  isDockExpanded.value = false
  appWindowStore.openApp(kind, payload)
  intentAuditStore.record({
    input: input || `launcher:${kind}`,
    status: 'app_opened',
    appKind: kind,
    summary: 'Opened from Aurora App Launcher.',
    payload: {
      appKind: kind,
      source: input || 'launcher',
      profileName: pinnedProfileName.value,
      ...(payload ? { appPayload: payload } : {}),
    },
  })
}

function openDockTool(tool: AuroraDockTool) {
  isDockExpanded.value = false
  openAuroraApp(
    tool.appKind,
    `dock:${tool.id}`,
    tool.id === 'chart'
      ? { symbol: 'NASDAQ:NVDA', source: 'aurora-tools-dock' }
      : null,
  )
}

async function hydrateMemoryStream() {
  memoryStreamLoading.value = true
  memoryStreamError.value = ''
  try {
    const result = await getQuantLabMiroFishMemoryRecords(4)
    memoryStreamRecords.value = Array.isArray(result.records) ? result.records.slice(0, 4) : []
  } catch (err) {
    memoryStreamRecords.value = []
    memoryStreamError.value = err instanceof Error ? err.message : t('aurora.memoryStream.offline')
  } finally {
    memoryStreamLoading.value = false
  }
}

async function hydrateComputeLoad() {
  try {
    computeLoad.value = await fetchAuroraComputeLoad()
  } catch {
    computeLoad.value = null
  }
}

function memoryStreamTopic(record: QuantLabMiroFishMemoryRecord): string {
  return (record.question || record.title || record.fileName || 'Untitled verdict').replace(/\s+/g, ' ').trim()
}

function memoryStreamVerdict(record: QuantLabMiroFishMemoryRecord): string {
  const verdict = (record.finalVerdict || 'SYNTH HOLD').replace(/\s+/g, ' ').trim()
  const compact = verdict
    .replace(/\s+·\s+.+$/, '')
    .replace(/^(.{28}).+$/, '$1...')
  return compact || 'SYNTH HOLD'
}

function memoryStreamPreview(record: QuantLabMiroFishMemoryRecord): string {
  const summary = (record.summary || '').replace(/\s+/g, ' ').trim()
  if (summary) return summary.length > 126 ? `${summary.slice(0, 126)}...` : summary
  return t('aurora.memoryStream.fallbackPreview')
}

function memoryStreamTone(record: QuantLabMiroFishMemoryRecord): 'proceed' | 'hold' | 'risk' | 'watch' {
  const verdict = `${record.finalVerdict} ${record.summary}`.toUpperCase()
  if (/(BUY|PROCEED|PILOT|FAVORABLE)/.test(verdict)) return 'proceed'
  if (/(SELL|PAUSE|BEAR|RISK)/.test(verdict)) return 'risk'
  if (/(WATCH|REVIEW)/.test(verdict)) return 'watch'
  return 'hold'
}

function dockToolIconPath(kind: AuroraDockToolKind): string {
  const paths: Record<AuroraDockToolKind, string> = {
    files: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z',
    calendar: 'M7 3v3 M17 3v3 M4.5 8.5h15 M6.5 5h11A2.5 2.5 0 0 1 20 7.5v10A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-10A2.5 2.5 0 0 1 6.5 5z M8 12h2 M12 12h2 M16 12h.01 M8 16h2 M12 16h2',
    mail: 'M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z M5 8l7 5 7-5',
    memory: 'M8.5 7a3 3 0 0 1 5.8-1 3.2 3.2 0 0 1 3.2 3.2 3.1 3.1 0 0 1-1 2.3 3.4 3.4 0 0 1 .4 5.2 3.5 3.5 0 0 1-4.8.4 3.5 3.5 0 0 1-4.9-.3 3.4 3.4 0 0 1 .4-5.2A3.1 3.1 0 0 1 8.5 7z M9 12h6 M12 9v6',
    chart: 'M4 18.5h16 M6 16l3.3-4.2 3.4 2.7L18 7 M18 7v4.5 M18 7h-4.5',
    sandbox: 'M6 5h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M9 9h.01 M15 9h.01 M9 15h.01 M15 15h.01 M12 12h.01',
  }
  return paths[kind]
}

function formatMemoryStreamTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('aurora.memoryStream.recent')
  return new Intl.DateTimeFormat(activeIntlLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function openMemoryVerdict(record: QuantLabMiroFishMemoryRecord) {
  const topic = memoryStreamTopic(record)
  appWindowStore.openApp('mirofish', {
    projectId: 'preview-project',
    graphPath: '/process/preview-project',
    query: topic,
    initialView: 'graph',
    launchContext: {
      source: 'aurora-memory-stream',
      topic,
      memoryRecordId: record.id,
      memoryRecordPath: record.relativePath,
    },
  })
  intentAuditStore.record({
    input: `memory-stream:${topic}`,
    status: 'app_opened',
    appKind: 'mirofish',
    summary: 'Rehydrated MiroFish memory from Aurora homepage stream.',
    payload: {
      source: 'aurora-memory-stream',
      memoryRecordId: record.id,
      memoryRecordPath: record.relativePath,
      topic,
    },
  })
}

function logout() {
  closeTopBarMenus()
  clearApiKey()
  localStorage.removeItem('hermes_active_profile_name')
  void router.replace({ name: 'login' })
}

onMounted(() => {
  void hydratePinnedApps()
  void hydrateMemoryStream()
  void hydrateComputeLoad()
  computeLoadTimer = window.setInterval(() => {
    void hydrateComputeLoad()
  }, 5000)
  void intentAuditStore.syncFromServer()
  document.addEventListener('mousedown', handleDocumentPointer)
})

onUnmounted(() => {
  if (computeLoadTimer) {
    window.clearInterval(computeLoadTimer)
    computeLoadTimer = null
  }
  document.removeEventListener('mousedown', handleDocumentPointer)
})

watch(() => profilesStore.activeProfileName, (profileName) => {
  void hydratePinnedApps(profileName || 'default')
})
</script>

<template>
  <section
    class="aurora-operating-layer"
    :class="{ 'is-idle': isAuroraIdle }"
    :aria-label="t('aurora.brand.name')"
  >
    <Transition name="aurora-idle">
      <div v-if="isAuroraIdle" class="aurora-idle-layer" aria-hidden="false">
        <svg class="aurora-wave-layer" viewBox="0 0 1440 520" preserveAspectRatio="none" aria-hidden="true">
          <path d="M-40 380C160 250 280 250 460 342C640 434 720 470 910 344C1100 218 1240 196 1480 320" />
          <path d="M-60 430C130 300 290 286 500 392C710 498 800 482 980 334C1160 186 1300 174 1490 280" />
          <path d="M-80 470C160 360 320 340 560 430C800 520 930 466 1090 332C1250 198 1340 208 1480 250" />
        </svg>

        <nav class="aurora-floating-nav" :aria-label="t('aurora.nav.navigation')">
          <button
            class="aurora-nav-button primary"
            type="button"
            :aria-label="t('aurora.nav.system')"
            :title="t('aurora.nav.system')"
            @click="openAuroraApp('system-status', 'nav:system-status')"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
              <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
            </svg>
          </button>
          <button class="aurora-nav-button" type="button" :aria-label="t('aurora.nav.home')" :title="t('aurora.nav.home')" @click="goHome">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 11.5 12 4l9 7.5" />
              <path d="M5.5 10.5V20h13v-9.5" />
            </svg>
          </button>
          <button class="aurora-nav-button" type="button" :aria-label="t('aurora.nav.status')" :title="t('aurora.nav.status')" @click="appStore.toggleAuroraStatus">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2v4" />
              <path d="M12 18v4" />
              <path d="m4.93 4.93 2.83 2.83" />
              <path d="m16.24 16.24 2.83 2.83" />
              <path d="M2 12h4" />
              <path d="M18 12h4" />
              <path d="m4.93 19.07 2.83-2.83" />
              <path d="m16.24 7.76 2.83-2.83" />
            </svg>
          </button>
          <button class="aurora-nav-button" type="button" :aria-label="t('aurora.nav.memoryQueue')" :title="t('aurora.nav.memoryQueue')" @click="memoryQueueStore.toggleReviewQueue">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="m12 2 9 5-9 5-9-5 9-5z" />
              <path d="m3 12 9 5 9-5" />
              <path d="m3 17 9 5 9-5" />
            </svg>
            <span
              v-if="memoryQueueStore.pendingCount > 0"
              class="aurora-nav-badge"
            >
              {{ memoryQueueStore.pendingCount }}
            </span>
          </button>
          <button class="aurora-nav-button" type="button" :aria-label="t('aurora.nav.history')" :title="t('aurora.nav.history')" @click="openHistory">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
          </button>
        </nav>

        <div class="aurora-idle-brand">
          <AuroraRibbonLogo aria-hidden="true" />
          <div>
            <h1>{{ t('aurora.brand.name') }}</h1>
            <p>{{ t('aurora.brand.subtitle') }}</p>
          </div>
        </div>

        <section class="aurora-tools-panel" :aria-label="t('aurora.dock.label')">
          <div class="launcher-panel-header dock-header">
            <p>{{ t('aurora.dock.tools') }}</p>
            <span aria-hidden="true">×</span>
          </div>

          <div class="tool-grid">
            <button
              v-for="tool in auroraDockTools"
              :key="tool.id"
              class="tool-chip"
              type="button"
              :aria-label="t('aurora.dock.openTool', { tool: t(tool.labelKey) })"
              :title="t(tool.descriptionKey)"
              @click="openDockTool(tool)"
            >
              <span class="tool-chip-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">
                  <path :d="dockToolIconPath(tool.id)" />
                </svg>
              </span>
              <strong>{{ t(tool.labelKey) }}</strong>
            </button>
          </div>

          <div class="aurora-drag-dots" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <Transition name="dock-expand">
            <div
              v-if="isDockExpanded"
              class="aurora-expanded-dock"
              :aria-label="t('aurora.dock.expandedLabel')"
            >
              <button
                v-for="app in expandedDockApps"
                :key="app.kind"
                type="button"
                :aria-label="t('aurora.dock.openTool', { tool: app.label })"
                @click="openAuroraApp(app.kind, `dock-expanded:${app.kind}`)"
              >
                <span>{{ app.icon }}</span>
                <strong>{{ app.label }}</strong>
              </button>
            </div>
          </Transition>
          <button
            class="aurora-dock-handle"
            type="button"
            :aria-label="isDockExpanded ? t('aurora.dock.collapse') : t('aurora.dock.expand')"
            :aria-expanded="isDockExpanded"
            :title="t('aurora.dock.gridTitle')"
            @click="isDockExpanded = !isDockExpanded"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M7 7h.01M12 7h.01M17 7h.01M7 12h.01M12 12h.01M17 12h.01M7 17h.01M12 17h.01M17 17h.01" />
            </svg>
          </button>
        </section>

        <aside class="aurora-trust-rail memory-stream" :aria-label="t('aurora.memoryStream.aria')">
          <header class="memory-stream-header">
            <div>
              <p>{{ t('aurora.memoryStream.title') }}</p>
              <h2>{{ t('aurora.memoryStream.subtitle') }}</h2>
            </div>
            <button
              class="memory-stream-refresh"
              type="button"
              :aria-label="t('aurora.memoryStream.refresh')"
              :disabled="memoryStreamLoading"
              @click="hydrateMemoryStream"
            >
              ↻
            </button>
          </header>

          <div v-if="recentMemoryVerdicts.length > 0" class="memory-stream-list">
            <button
              v-for="record in recentMemoryVerdicts"
              :key="record.id"
              class="memory-stream-item"
              type="button"
              :class="`tone-${memoryStreamTone(record)}`"
              :aria-label="t('aurora.memoryStream.rehydrate', { topic: memoryStreamTopic(record) })"
              @click="openMemoryVerdict(record)"
            >
              <span class="memory-stream-dot" aria-hidden="true"></span>
              <span class="memory-stream-copy">
                <strong>{{ memoryStreamTopic(record) }}</strong>
                <small>{{ formatMemoryStreamTime(record.date || record.updatedAt) }}</small>
              </span>
              <em>{{ memoryStreamVerdict(record) }}</em>
              <span class="memory-stream-preview" role="tooltip">
                <strong>{{ memoryStreamVerdict(record) }}</strong>
                <small>{{ record.source || t('aurora.memoryStream.recordsSource') }}</small>
                <span>{{ memoryStreamPreview(record) }}</span>
              </span>
            </button>
          </div>

          <div v-else class="memory-stream-empty" :class="{ warn: memoryStreamError }">
            <strong>{{ memoryStreamLoading ? t('aurora.memoryStream.hydrating') : memoryStreamError ? t('aurora.memoryStream.offline') : t('aurora.memoryStream.empty') }}</strong>
            <p>{{ memoryStreamError || t('aurora.memoryStream.emptyHint') }}</p>
          </div>
        </aside>

        <div class="aurora-bottom-pill" aria-hidden="true">
          <span class="aurora-bottom-orb"></span>
          <span>
            <strong>{{ t('aurora.brand.bottomTitle') }}</strong>
            <small>{{ t('aurora.brand.bottomSubtitle') }}</small>
          </span>
        </div>

      </div>
    </Transition>

    <div
      class="aurora-shell"
      :class="{ 'console-closed': !appStore.isAdvancedConsoleOpen, 'idle-shell': isAuroraIdle }"
    >
      <div
        v-if="!appStore.isAdvancedConsoleOpen"
        class="tauri-drag-region"
        data-tauri-drag-region
        aria-hidden="true"
      ></div>

      <header
        v-if="!appStore.isAdvancedConsoleOpen && !appWindowStore.isOpen"
        class="aurora-top-bar"
        :aria-label="t('aurora.topbar.quickControls')"
      >
        <div class="top-bar-apps">
          <button
            class="top-bar-avatar top-bar-app-button"
            type="button"
            :aria-label="t('aurora.topbar.appMenu')"
            :aria-expanded="appMenuOpen"
            @click.stop="appMenuOpen = !appMenuOpen; modelMenuOpen = false; userMenuOpen = false"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="4" width="6" height="6" rx="1.5" />
              <rect x="14" y="4" width="6" height="6" rx="1.5" />
              <rect x="4" y="14" width="6" height="6" rx="1.5" />
              <rect x="14" y="14" width="6" height="6" rx="1.5" />
            </svg>
          </button>
          <Transition name="topbar-pop">
            <div v-if="appMenuOpen" class="top-bar-menu app-menu" :aria-label="t('aurora.topbar.appMenuList')">
              <div class="app-menu-header">
                <div>
                  <strong>{{ t('aurora.topbar.apps') }}</strong>
                  <span>{{ t('aurora.topbar.appsHint', { profile: pinnedProfileName }) }}</span>
                  <span
                    class="desktop-sync-pill"
                    :class="`is-${desktopConfigSource.tone}`"
                    :title="desktopConfigSourceDetail"
                  >
                    {{ desktopConfigSource.label }}
                    <small role="tooltip">{{ desktopConfigSourceDetail }}</small>
                  </span>
                </div>
                <div class="desktop-config-actions">
                  <button type="button" @click="exportAuroraDesktopConfig">{{ t('aurora.topbar.export') }}</button>
                  <button type="button" @click="openDesktopConfigImport">{{ t('aurora.topbar.import') }}</button>
                  <input
                    ref="desktopConfigInput"
                    class="desktop-config-file"
                    type="file"
                    accept="application/json,.json"
                    @change="importAuroraDesktopConfig"
                  />
                </div>
              </div>
              <p v-if="desktopConfigMessage" class="desktop-config-message">{{ desktopConfigMessage }}</p>
              <div class="desktop-presets" :aria-label="t('aurora.topbar.desktopPresets')">
                <button
                  v-for="preset in desktopPresets"
                  :key="preset.id"
                  type="button"
                  :aria-label="t('aurora.topbar.applyPreset', { preset: preset.label })"
                  @click="applyDesktopPreset(preset)"
                >
                  <strong>{{ preset.label }}</strong>
                  <span>{{ preset.description }}</span>
                </button>
              </div>
              <div class="top-bar-app-grid">
                <div
                  v-for="app in auroraLauncherApps"
                  :key="app.kind"
                  class="top-bar-app-row"
                >
                  <button
                    class="top-bar-app-item"
                    type="button"
                    :aria-label="t('aurora.topbar.openFromTopBar', { app: app.label })"
                    @click="openAuroraApp(app.kind, `topbar:${app.kind}`)"
                  >
                    <span class="app-menu-icon">{{ app.icon }}</span>
                    <span class="app-menu-copy">
                      <strong>
                        {{ app.label }}
                        <em v-if="isPinnedApp(app.kind)">{{ t('aurora.topbar.pinned') }}</em>
                      </strong>
                      <small>{{ app.description }}</small>
                    </span>
                  </button>
                  <button
                    class="app-pin-button"
                    type="button"
                    :aria-label="isPinnedApp(app.kind) ? t('aurora.topbar.unpinApp', { app: app.label }) : t('aurora.topbar.pinApp', { app: app.label })"
                    :class="{ active: isPinnedApp(app.kind) }"
                    @click.stop="togglePinnedApp(app.kind)"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 17v5" />
                      <path d="M5 17h14l-2-7 2-5H5l2 5-2 7z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </Transition>
        </div>

        <button
          class="top-bar-chip desktop-chip"
          type="button"
          :aria-label="t('aurora.topbar.returnDesktop')"
          :title="t('aurora.topbar.returnDesktop')"
          @click="returnToAuroraDesktop"
        >
          <span class="chip-dot desktop-dot" aria-hidden="true"></span>
          <span>{{ t('aurora.topbar.desktop') }}</span>
        </button>

        <div class="top-bar-model">
          <button
            class="top-bar-chip model-chip"
            type="button"
            :aria-label="t('aurora.topbar.modelSelector')"
            :aria-expanded="modelMenuOpen"
            @click.stop="modelMenuOpen = !modelMenuOpen; appMenuOpen = false; userMenuOpen = false"
          >
            <span class="chip-dot model-dot" aria-hidden="true"></span>
            <span>{{ selectedModelName }}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <Transition name="topbar-pop">
            <div v-if="modelMenuOpen" class="top-bar-menu model-menu">
              <button
                v-for="option in modelOptions"
                :key="option.id"
                class="top-bar-menu-item"
                :class="{ active: option.model === appStore.selectedModel && option.provider === appStore.selectedProvider }"
                type="button"
                :disabled="option.disabled"
                @click="selectModel(option.model, option.provider)"
              >
                <span>{{ option.label }}</span>
                <small>{{ option.groupLabel }}</small>
              </button>
              <p v-if="modelOptions.length === 0" class="top-bar-empty">{{ t('aurora.topbar.noModelsLoaded') }}</p>
            </div>
          </Transition>
        </div>

        <button
          class="top-bar-chip compute-chip"
          type="button"
          :aria-label="computeLoadLabel"
          :title="computeLoadLabel"
          @click="hydrateComputeLoad"
        >
          <span class="compute-sparkline" aria-hidden="true">
            <i
              v-for="(bar, index) in computeSparklineBars"
              :key="index"
              :class="{ active: bar.active, queued: bar.queued }"
              :style="{ height: `${8 + index * 3}px` }"
            ></i>
          </span>
          <span>{{ computeLoadLabel }}</span>
          <span class="compute-load-meter" aria-hidden="true">
            <i :style="{ width: `${Math.round(computeLoadLevel * 100)}%` }"></i>
          </span>
        </button>

        <button
          class="top-bar-chip status-chip"
          type="button"
          :aria-label="t('aurora.topbar.systemStatus')"
          @click="appStore.toggleAuroraStatus"
        >
          <span
            class="chip-dot"
            :class="{ connected: appStore.connected, disconnected: !appStore.connected }"
            aria-hidden="true"
          ></span>
          <span>{{ appStore.connected ? t('aurora.topbar.ready') : t('aurora.topbar.offline') }}</span>
          <div class="status-hover-card" role="tooltip">
            <strong>{{ appStore.connected ? t('aurora.topbar.systemConnected') : t('aurora.topbar.systemOffline') }}</strong>
            <span>{{ runState }} · {{ sessionTitle }}</span>
            <span>{{ t('aurora.topbar.usageTokens', { tokens: totalTokens.toLocaleString(activeIntlLocale()) }) }}</span>
            <span>{{ t('aurora.topbar.webUiVersion', { version: displayWebUiVersion }) }}</span>
          </div>
        </button>

        <button
          class="top-bar-chip language-chip"
          type="button"
          :aria-label="t('aurora.topbar.languageToggle')"
          :title="t('aurora.topbar.languageToggle')"
          @click="toggleAuroraLocale"
        >
          <span class="language-glyph">{{ auroraLanguageLabel }}</span>
        </button>

        <div class="top-bar-user">
          <button
            class="top-bar-avatar"
            type="button"
            :aria-label="t('aurora.topbar.userMenu')"
            :aria-expanded="userMenuOpen"
            @click.stop="userMenuOpen = !userMenuOpen; appMenuOpen = false; modelMenuOpen = false"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5z" />
              <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.76l.05.05a2 2 0 1 1-2.83 2.83l-.05-.05A1.6 1.6 0 0 0 15.13 19a1.6 1.6 0 0 0-.97 1.46V20.5a2 2 0 1 1-4 0v-.04A1.6 1.6 0 0 0 9.19 19a1.6 1.6 0 0 0-1.76.32l-.05.05a2 2 0 1 1-2.83-2.83l.05-.05A1.6 1.6 0 0 0 4.92 15a1.6 1.6 0 0 0-1.46-.97H3.5a2 2 0 1 1 0-4h.04A1.6 1.6 0 0 0 5 9.06a1.6 1.6 0 0 0-.32-1.76l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05A1.6 1.6 0 0 0 9.27 5a1.6 1.6 0 0 0 .97-1.46V3.5a2 2 0 1 1 4 0v.04A1.6 1.6 0 0 0 15.21 5a1.6 1.6 0 0 0 1.76-.32l.05-.05a2 2 0 1 1 2.83 2.83l-.05.05A1.6 1.6 0 0 0 19.28 9a1.6 1.6 0 0 0 1.46.97h.04a2 2 0 1 1 0 4h-.04A1.6 1.6 0 0 0 19.4 15z" />
            </svg>
          </button>
          <Transition name="topbar-pop">
            <div v-if="userMenuOpen" class="top-bar-menu user-menu">
              <button type="button" class="top-bar-menu-item" @click="openAuroraApp('settings', 'topbar:settings')">
                <span>{{ t('aurora.topbar.settings') }}</span>
                <small>{{ t('aurora.topbar.preferences') }}</small>
              </button>
              <button type="button" class="top-bar-menu-item" @click="openAuroraApp('gateways', 'topbar:gateways')">
                <span>{{ t('aurora.topbar.gateways') }}</span>
                <small>{{ t('aurora.topbar.providers') }}</small>
              </button>
              <button type="button" class="top-bar-menu-item danger" @click="logout">
                <span>{{ t('aurora.topbar.logout') }}</span>
                <small>{{ t('aurora.topbar.clearAccessKey') }}</small>
              </button>
            </div>
          </Transition>
        </div>
      </header>

      <header
        v-if="!appStore.legacyConsoleRetired && appStore.isAdvancedConsoleOpen"
        class="aurora-status-strip"
      >
        <div class="aurora-brand">
          <span class="aurora-mark" aria-hidden="true"></span>
          <span class="aurora-title">{{ t('aurora.brand.name') }}</span>
          <span class="aurora-divider" aria-hidden="true"></span>
          <span class="aurora-session">{{ sessionTitle }}</span>
        </div>

        <div class="aurora-state" :class="{ active: chatStore.isRunActive }">
          <span class="aurora-state-dot" aria-hidden="true"></span>
          <span>{{ runState }}</span>
        </div>
      </header>

      <main class="aurora-workbench">
        <slot />
      </main>

      <ResultOverlay v-if="!appWindowStore.isOpen" />
      <VibeCodingOverlay v-if="!appWindowStore.isOpen" />
      <AppWindowOverlay />
    </div>
  </section>
</template>

<style scoped lang="scss">
.aurora-operating-layer {
  --aurora-ease: 0.3s cubic-bezier(0.2, 0, 0, 1);
  --aurora-glass-bg: linear-gradient(135deg, rgba(255, 255, 255, 0.86), rgba(244, 250, 255, 0.68)), rgba(255, 255, 255, 0.76);
  --aurora-glass-bg-strong: linear-gradient(135deg, rgba(255, 255, 255, 0.9), rgba(247, 251, 255, 0.74)), rgba(255, 255, 255, 0.82);
  --aurora-glass-border: rgba(255, 255, 255, 0.62);
  --aurora-glass-shadow: 0 22px 70px rgba(66, 84, 117, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.78);
  --aurora-muted: rgba(21, 32, 51, 0.56);
  --aurora-text: #172033;
  --aurora-holo-bg: linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.035)), rgba(255, 255, 255, 0.06);
  --aurora-holo-bg-hover: linear-gradient(135deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.06)), rgba(255, 255, 255, 0.1);
  --aurora-holo-border: 1px solid rgba(255, 255, 255, 0.4);
  --aurora-holo-blur: blur(34px);
  --aurora-holo-shadow: 0 8px 32px rgba(139, 92, 246, 0.055), inset 0 1px 0 rgba(255, 255, 255, 0.38);

  position: relative;
  isolation: isolate;
  display: flex;
  min-height: 0;
  height: 100%;
  min-height: calc(var(--vh) * 100);
  padding: 14px;
  overflow: hidden;
  color: #182033;
  background:
    radial-gradient(980px 620px at 8% 10%, rgba(95, 169, 255, 0.38), transparent 64%),
    radial-gradient(920px 560px at 92% 8%, rgba(178, 132, 255, 0.34), transparent 66%),
    radial-gradient(780px 520px at 52% 98%, rgba(88, 205, 255, 0.22), transparent 70%),
    conic-gradient(from 218deg at 52% 58%, rgba(255, 255, 255, 0.44), rgba(177, 204, 255, 0.32), rgba(219, 179, 255, 0.28), rgba(255, 255, 255, 0.48)),
    linear-gradient(135deg, #e7f4ff 0%, #dfeaff 46%, #f0e7ff 100%);
  transition: background var(--aurora-ease);
}

.aurora-operating-layer::before,
.aurora-operating-layer::after {
  position: absolute;
  inset: -18%;
  z-index: 0;
  content: "";
  pointer-events: none;
  transition: opacity var(--aurora-ease), transform var(--aurora-ease);
}

.aurora-operating-layer::before {
  opacity: 0.92;
  background:
    linear-gradient(114deg, transparent 9%, rgba(154, 205, 255, 0.18) 24%, rgba(255, 255, 255, 0.45) 33%, transparent 47%),
    linear-gradient(146deg, transparent 30%, rgba(210, 183, 255, 0.24) 50%, rgba(255, 255, 255, 0.48) 57%, transparent 72%),
    linear-gradient(24deg, transparent 36%, rgba(255, 255, 255, 0.6) 49%, transparent 63%);
  filter: blur(34px);
  transform: rotate(-4deg) scale(1.04);
}

.aurora-operating-layer::after {
  opacity: 0.66;
  background:
    radial-gradient(640px 260px at 30% 74%, rgba(160, 212, 255, 0.28), transparent 70%),
    linear-gradient(152deg, transparent 21%, rgba(151, 173, 255, 0.12) 41%, transparent 59%),
    linear-gradient(28deg, transparent 39%, rgba(255, 255, 255, 0.62) 52%, transparent 68%);
  filter: blur(48px);
  transform: rotate(7deg) scale(1.08);
}

.aurora-operating-layer.is-idle {
  padding: 0;
  background:
    radial-gradient(1100px 640px at 13% 12%, rgba(89, 171, 255, 0.42), transparent 64%),
    radial-gradient(1050px 620px at 88% 10%, rgba(174, 116, 255, 0.38), transparent 65%),
    radial-gradient(980px 560px at 50% 104%, rgba(84, 209, 255, 0.25), transparent 70%),
    radial-gradient(760px 520px at 53% 52%, rgba(255, 255, 255, 0.54), transparent 72%),
    conic-gradient(from 238deg at 50% 72%, rgba(255, 255, 255, 0.58), rgba(169, 203, 255, 0.36), rgba(220, 183, 255, 0.34), rgba(255, 255, 255, 0.62)),
    linear-gradient(145deg, #d9efff 0%, #dfe8ff 44%, #efe3ff 100%);
}

.aurora-operating-layer.is-idle::before {
  opacity: 1;
  transform: rotate(-5deg) scale(1.1);
}

.aurora-operating-layer.is-idle::after {
  opacity: 0.82;
  transform: rotate(8deg) scale(1.14);
}

.aurora-shell {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.62);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.58);
  box-shadow:
    0 24px 70px rgba(80, 97, 138, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(26px);
}

.aurora-shell.console-closed {
  border-color: transparent;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
}

.aurora-shell.idle-shell {
  z-index: 4;
  pointer-events: none;
}

.aurora-shell.idle-shell .aurora-top-bar {
  pointer-events: auto;
}

.tauri-drag-region {
  position: absolute;
  top: 0;
  right: clamp(420px, 30vw, 560px);
  left: clamp(84px, 9vw, 160px);
  z-index: 11;
  height: 52px;
  pointer-events: auto;
}

.aurora-idle-layer {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
}

.aurora-wave-layer {
  position: absolute;
  right: -5%;
  bottom: -4%;
  left: -6%;
  z-index: 0;
  width: 112%;
  height: min(48vh, 520px);
  color: rgba(124, 148, 255, 0.3);
  filter: blur(0.2px);
  opacity: 0.92;
}

.aurora-wave-layer path {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  opacity: 0.28;
  filter: drop-shadow(0 0 12px rgba(255, 255, 255, 0.45));
}

.aurora-wave-layer path:nth-child(2) {
  color: rgba(255, 255, 255, 0.76);
  stroke-width: 1.4;
  opacity: 0.2;
}

.aurora-wave-layer path:nth-child(3) {
  color: rgba(117, 207, 255, 0.32);
  stroke-width: 1.2;
  opacity: 0.22;
}

.aurora-floating-nav,
.aurora-tools-panel,
.aurora-trust-rail {
  position: absolute;
  z-index: 2;
  pointer-events: auto;
  border: var(--aurora-holo-border);
  background: var(--aurora-holo-bg);
  box-shadow: var(--aurora-holo-shadow);
  backdrop-filter: var(--aurora-holo-blur);
}

.aurora-floating-nav {
  top: 50%;
  left: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: clamp(18px, 3vh, 30px);
  width: 58px;
  min-height: min(86vh, 800px);
  padding: 16px 8px;
  border-left: 0;
  border-radius: 0 999px 999px 0;
  transform: translateY(-50%);
}

.aurora-nav-button {
  position: relative;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: rgba(64, 76, 110, 0.58);
  background: rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: transform var(--aurora-ease), color var(--aurora-ease), background var(--aurora-ease), box-shadow var(--aurora-ease);
}

.aurora-nav-badge {
  position: absolute;
  top: -3px;
  right: -3px;
  display: grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border: 1px solid rgba(255, 255, 255, 0.78);
  border-radius: 999px;
  color: #fff;
  background: #16a34a;
  box-shadow: 0 8px 20px rgba(22, 163, 74, 0.24);
  font-size: 10px;
  font-weight: 900;
  line-height: 1;
}

.aurora-nav-button:hover,
.aurora-nav-button:focus-visible {
  color: #5b4ef5;
  background: rgba(255, 255, 255, 0.42);
  transform: translateY(-1px);
  outline: none;
}

.aurora-nav-button.primary {
  width: 50px;
  height: 50px;
  margin-bottom: clamp(6px, 2vh, 20px);
  color: #fff;
  border-radius: 16px;
  background:
    radial-gradient(circle at 28% 22%, rgba(255, 255, 255, 0.96), transparent 24%),
    linear-gradient(135deg, #5b8dff 0%, #8366ff 52%, #da6fff 100%);
  box-shadow:
    0 16px 34px rgba(116, 99, 255, 0.28),
    0 0 28px rgba(173, 112, 255, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.56);
}

.aurora-top-bar {
  position: absolute;
  top: 18px;
  right: clamp(18px, 3vw, 42px);
  z-index: 12;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 5px;
  pointer-events: auto;
  border: var(--aurora-holo-border);
  border-radius: 999px;
  background: var(--aurora-holo-bg);
  box-shadow: var(--aurora-holo-shadow);
  backdrop-filter: var(--aurora-holo-blur);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.top-bar-apps,
.top-bar-model,
.top-bar-user {
  position: relative;
  display: inline-flex;
}

.top-bar-chip,
.top-bar-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.38);
  color: rgba(31, 42, 70, 0.68);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.48);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.top-bar-chip {
  gap: 7px;
  max-width: min(300px, 32vw);
  padding: 0 11px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 850;
  line-height: 1;
}

.top-bar-chip span:not(.chip-dot) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.top-bar-avatar {
  width: 32px;
  padding: 0;
  border-radius: 999px;
}

.top-bar-app-button {
  color: #6b4cff;
}

.top-bar-chip:hover,
.top-bar-avatar:hover {
  color: #6b4cff;
  border-color: rgba(255, 255, 255, 0.66);
  background: rgba(255, 255, 255, 0.16);
  transform: translateY(-1px);
}

.desktop-chip {
  color: rgba(67, 56, 202, 0.76);
}

.language-chip {
  min-width: 42px;
  max-width: 48px;
  padding: 0 10px;
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(24px);
}

.language-glyph {
  color: rgba(79, 70, 229, 0.88);
  font-size: 11px;
  font-weight: 950;
  letter-spacing: 0.02em;
}

.desktop-dot {
  background: linear-gradient(135deg, #60a5fa, #a78bfa);
  box-shadow: 0 0 14px rgba(129, 140, 248, 0.42);
}

.compute-chip {
  color: rgba(14, 116, 144, 0.82);
}

.compute-sparkline {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  width: 22px;
  height: 18px;
  overflow: visible !important;
}

.compute-sparkline i {
  display: block;
  width: 3px;
  border-radius: 999px;
  background: rgba(14, 116, 144, 0.18);
  transition: all 0.2s ease;
}

.compute-sparkline i.active {
  background: #22d3ee;
  box-shadow: 0 0 10px rgba(34, 211, 238, 0.5);
}

.compute-sparkline i.queued {
  background: #a78bfa;
  box-shadow: 0 0 10px rgba(167, 139, 250, 0.42);
}

.compute-load-meter {
  position: relative;
  display: inline-flex;
  width: 30px;
  height: 4px;
  overflow: hidden !important;
  border-radius: 999px;
  background: rgba(14, 116, 144, 0.12);
}

.compute-load-meter i {
  display: block;
  border-radius: inherit;
  background: linear-gradient(90deg, #22d3ee, #a78bfa);
  transition: width 0.24s ease;
}

.chip-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: rgba(121, 99, 255, 0.62);
  box-shadow: 0 0 12px rgba(121, 99, 255, 0.42);
}

.chip-dot.connected {
  background: #48c78e;
  box-shadow: 0 0 12px rgba(72, 199, 142, 0.52);
}

.chip-dot.disconnected {
  background: #ff6b6b;
  box-shadow: 0 0 12px rgba(255, 107, 107, 0.46);
}

.status-chip {
  position: relative;
}

.status-hover-card {
  position: absolute;
  top: calc(100% + 12px);
  right: 0;
  display: grid;
  gap: 6px;
  width: 244px;
  padding: 12px;
  pointer-events: none;
  opacity: 0;
  border: 1px solid rgba(255, 255, 255, 0.46);
  border-radius: 16px;
  color: rgba(24, 32, 51, 0.68);
  background: rgba(255, 255, 255, 0.74);
  box-shadow: 0 18px 46px rgba(66, 84, 117, 0.16);
  backdrop-filter: blur(16px);
  font-size: 11px;
  line-height: 1.25;
  transform: translateY(-4px);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.status-hover-card strong {
  color: rgba(24, 32, 51, 0.86);
  font-size: 12px;
}

.status-chip:hover .status-hover-card,
.status-chip:focus-visible .status-hover-card {
  opacity: 1;
  transform: translateY(0);
}

.top-bar-menu {
  position: absolute;
  top: calc(100% + 12px);
  right: 0;
  display: grid;
  gap: 4px;
  min-width: 220px;
  max-height: min(360px, calc((var(--vh) * 100) - 96px));
  overflow: auto;
  padding: 6px;
  border: 1px solid rgba(255, 255, 255, 0.46);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.74);
  box-shadow: 0 18px 46px rgba(66, 84, 117, 0.16);
  backdrop-filter: blur(16px);
}

.model-menu {
  right: auto;
  left: 0;
  width: min(340px, calc(100vw - 36px));
}

.user-menu {
  width: 220px;
}

.app-menu {
  right: auto;
  left: 0;
  width: min(390px, calc(100vw - 36px));
  padding: 10px;
}

.app-menu-header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px 10px;
}

.app-menu-header > div:first-child {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.app-menu-header strong {
  color: rgba(24, 32, 51, 0.84);
  font-size: 12px;
  font-weight: 900;
  line-height: 1.1;
}

.app-menu-header span {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(24, 32, 51, 0.48);
  font-size: 10px;
  font-weight: 750;
  line-height: 1.2;
}

.desktop-sync-pill {
  position: relative;
  width: max-content;
  max-width: 100%;
  margin-top: 4px;
  padding: 4px 8px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(121, 99, 255, 0.08);
  overflow: visible;
  font-size: 9px;
  font-weight: 950;
  text-transform: uppercase;
  cursor: help;
}

.desktop-sync-pill.is-synced {
  border-color: rgba(52, 211, 153, 0.24);
  color: #047857;
  background: rgba(52, 211, 153, 0.1);
}

.desktop-sync-pill.is-syncing {
  border-color: rgba(99, 102, 241, 0.22);
  color: #4f46e5;
  background: rgba(99, 102, 241, 0.1);
}

.desktop-sync-pill.is-local,
.desktop-sync-pill.is-idle {
  border-color: rgba(245, 158, 11, 0.24);
  color: #9a5b00;
  background: rgba(245, 158, 11, 0.1);
}

.desktop-sync-pill small {
  position: absolute;
  top: calc(100% + 7px);
  left: 0;
  z-index: 3;
  display: block;
  width: min(260px, calc(100vw - 80px));
  padding: 9px 10px;
  border: 1px solid rgba(255, 255, 255, 0.54);
  border-radius: 10px;
  color: rgba(21, 32, 51, 0.72);
  background: rgba(255, 255, 255, 0.86);
  box-shadow: 0 16px 38px rgba(52, 67, 104, 0.14);
  backdrop-filter: blur(16px);
  font-size: 10px;
  font-weight: 750;
  line-height: 1.35;
  opacity: 0;
  pointer-events: none;
  text-transform: none;
  transform: translateY(-4px);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  white-space: normal;
}

.desktop-sync-pill:hover small,
.desktop-sync-pill:focus-within small {
  opacity: 1;
  transform: translateY(0);
}

.desktop-config-actions {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 4px;
}

.desktop-config-actions button {
  min-height: 24px;
  padding: 0 8px;
  border: 1px solid rgba(121, 99, 255, 0.13);
  border-radius: 999px;
  color: #6758f5;
  background: rgba(255, 255, 255, 0.46);
  cursor: pointer;
  font-size: 10px;
  font-weight: 900;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.desktop-config-actions button:hover,
.desktop-config-actions button:focus-visible {
  border-color: rgba(121, 99, 255, 0.28);
  background: rgba(255, 255, 255, 0.76);
  outline: none;
  transform: translateY(-1px);
}

.desktop-config-file {
  display: none;
}

.desktop-config-message {
  margin: -4px 8px 8px;
  color: rgba(24, 32, 51, 0.48);
  font-size: 10px;
  font-weight: 800;
  line-height: 1.25;
}

.desktop-presets {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin: 0 0 9px;
}

.desktop-presets button {
  display: grid;
  min-width: 0;
  min-height: 52px;
  gap: 4px;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 14px;
  color: rgba(24, 32, 51, 0.68);
  background: rgba(255, 255, 255, 0.34);
  cursor: pointer;
  text-align: left;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.desktop-presets button:hover,
.desktop-presets button:focus-visible {
  border-color: rgba(121, 99, 255, 0.24);
  color: #6150dc;
  background: rgba(121, 99, 255, 0.1);
  outline: none;
  transform: translateY(-1px);
}

.desktop-presets strong,
.desktop-presets span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-presets strong {
  font-size: 11px;
  font-weight: 900;
  line-height: 1.05;
}

.desktop-presets span {
  color: rgba(24, 32, 51, 0.44);
  font-size: 9px;
  font-weight: 750;
  line-height: 1.15;
}

.top-bar-app-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.top-bar-app-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 28px;
  align-items: stretch;
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.38);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.34);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.top-bar-app-row:hover,
.top-bar-app-row:focus-within {
  border-color: rgba(121, 99, 255, 0.2);
  background: rgba(121, 99, 255, 0.1);
  transform: translateY(-1px);
}

.top-bar-app-item {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  min-width: 0;
  min-height: 62px;
  padding: 9px;
  border: 0;
  border-radius: 16px 0 0 16px;
  color: rgba(24, 32, 51, 0.7);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.top-bar-app-item:hover,
.top-bar-app-item:focus-visible {
  color: #6150dc;
  outline: none;
}

.app-pin-button {
  display: grid;
  place-items: center;
  width: 28px;
  min-height: 62px;
  border: 0;
  border-radius: 0 16px 16px 0;
  color: rgba(24, 32, 51, 0.3);
  background: transparent;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.app-pin-button:hover,
.app-pin-button:focus-visible,
.app-pin-button.active {
  color: #6758f5;
  background: rgba(255, 255, 255, 0.28);
  outline: none;
}

.app-menu-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 13px;
  color: #7059f7;
  background: rgba(255, 255, 255, 0.58);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5);
  font-size: 10px;
  font-weight: 950;
  line-height: 1;
}

.app-menu-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.app-menu-copy strong,
.app-menu-copy small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-menu-copy strong {
  display: flex;
  align-items: center;
  gap: 5px;
  color: rgba(24, 32, 51, 0.78);
  font-size: 12px;
  font-weight: 900;
  line-height: 1.05;
}

.app-menu-copy em {
  flex: 0 0 auto;
  padding: 2px 5px;
  border-radius: 999px;
  color: #6758f5;
  background: rgba(121, 99, 255, 0.1);
  font-size: 8px;
  font-style: normal;
  font-weight: 900;
  letter-spacing: 0;
  text-transform: uppercase;
}

.app-menu-copy small {
  color: rgba(24, 32, 51, 0.44);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.15;
}

.top-bar-menu-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
  min-height: 46px;
  padding: 9px 10px;
  border: 0;
  border-radius: 13px;
  color: rgba(24, 32, 51, 0.72);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.top-bar-menu-item span,
.top-bar-menu-item small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.top-bar-menu-item span {
  font-size: 12px;
  font-weight: 900;
}

.top-bar-menu-item small {
  color: rgba(24, 32, 51, 0.46);
  font-size: 10px;
  font-weight: 700;
}

.top-bar-menu-item:hover,
.top-bar-menu-item.active {
  color: #6150dc;
  background: rgba(121, 99, 255, 0.1);
}

.top-bar-menu-item.danger:hover {
  color: #9f2d2d;
  background: rgba(239, 68, 68, 0.1);
}

.top-bar-menu-item:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.top-bar-empty {
  margin: 0;
  padding: 12px;
  color: rgba(24, 32, 51, 0.5);
  font-size: 12px;
  font-weight: 750;
}

.topbar-pop-enter-active,
.topbar-pop-leave-active {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.topbar-pop-enter-from,
.topbar-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.aurora-idle-brand {
  position: absolute;
  z-index: 2;
  top: clamp(70px, 18vh, 160px);
  left: 50%;
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: min(640px, calc(100vw - 260px));
  justify-content: center;
  color: #182033;
  text-align: left;
  transform: translateX(-50%);
}

.aurora-idle-brand h1 {
  margin: 0;
  color: rgba(56, 61, 170, 0.9);
  font-size: clamp(32px, 4.4vw, 54px);
  font-weight: 860;
  letter-spacing: 0;
  line-height: 0.96;
}

.aurora-idle-brand p {
  margin: 7px 0 0;
  color: rgba(77, 87, 124, 0.54);
  font-size: 13px;
  font-weight: 750;
  letter-spacing: 0;
  text-transform: uppercase;
}

.aurora-tools-panel {
  left: 50%;
  top: calc(50% + 136px);
  display: grid;
  gap: 10px;
  width: min(500px, calc(100vw - 460px));
  min-width: 430px;
  padding: 12px 14px 18px;
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.035)),
    rgba(255, 255, 255, 0.07);
  transform: translateX(-50%);
}

.aurora-tools-panel::after {
  position: absolute;
  bottom: -11px;
  left: 50%;
  width: 42px;
  height: 20px;
  content: "";
  border: 1px solid rgba(255, 255, 255, 0.48);
  border-top: 0;
  border-radius: 0 0 999px 999px;
  background: rgba(255, 255, 255, 0.07);
  box-shadow: 0 14px 28px rgba(139, 92, 246, 0.08);
  backdrop-filter: blur(24px);
  transform: translateX(-50%);
}

.launcher-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.launcher-panel-header.dock-header {
  min-height: 16px;
}

.launcher-panel-header p,
.launcher-panel-header h2 {
  margin: 0;
}

.launcher-panel-header p {
  color: rgba(74, 80, 130, 0.54);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0;
  text-transform: uppercase;
}

.launcher-panel-header.dock-header > span {
  color: rgba(74, 80, 130, 0.38);
  font-size: 13px;
  font-weight: 900;
  line-height: 1;
}

.launcher-panel-header h2 {
  margin-top: 3px;
  color: rgba(48, 55, 96, 0.68);
  font-size: 13px;
  font-weight: 900;
  line-height: 1.2;
}

.launcher-console-link {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid rgba(255, 255, 255, 0.48);
  border-radius: 999px;
  color: #5948d8;
  background: rgba(255, 255, 255, 0.22);
  cursor: pointer;
  font-size: 11px;
  font-weight: 850;
  transition: all var(--aurora-ease);
}

.launcher-console-link:hover {
  border-color: rgba(117, 93, 255, 0.28);
  background: rgba(255, 255, 255, 0.42);
  transform: translateY(-1px);
}

.tool-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.recent-app-strip {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  overflow: hidden;
}

.recent-app-strip > span {
  flex: 0 0 auto;
  color: rgba(74, 80, 130, 0.48);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0;
  text-transform: uppercase;
}

.recent-app-strip button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 150px;
  height: 30px;
  padding: 0 10px 0 6px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 999px;
  color: rgba(48, 55, 96, 0.64);
  background: rgba(255, 255, 255, 0.18);
  cursor: pointer;
  font-size: 11px;
  font-weight: 850;
  transition: all var(--aurora-ease);
}

.recent-app-strip button:hover,
.recent-app-strip button:focus-visible {
  color: #5748dc;
  background: rgba(255, 255, 255, 0.38);
  outline: none;
  transform: translateY(-1px);
}

.recent-app-strip strong {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  border-radius: 8px;
  color: #4f7cff;
  background: rgba(255, 255, 255, 0.3);
  font-size: 8px;
  font-weight: 950;
}

.tool-chip {
  display: grid;
  place-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 58px;
  padding: 7px 5px;
  border: 1px solid rgba(255, 255, 255, 0.42);
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.035);
  color: rgba(63, 91, 170, 0.76);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.38);
  cursor: pointer;
  transition: all var(--aurora-ease);
}

.tool-chip:hover,
.tool-chip:focus-visible {
  border-color: rgba(106, 133, 255, 0.32);
  background: rgba(255, 255, 255, 0.12);
  box-shadow:
    0 12px 30px rgba(91, 123, 255, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.5);
  outline: none;
  transform: translateY(-2px);
}

.tool-chip-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid rgba(99, 132, 255, 0.16);
  border-radius: 10px;
  color: #4f7dff;
  background: rgba(255, 255, 255, 0.045);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.42);
}

.tool-chip-icon svg {
  width: 17px;
  height: 17px;
}

.tool-chip strong {
  overflow: hidden;
  max-width: 100%;
  color: rgba(46, 55, 100, 0.64);
  font-size: 9px;
  font-weight: 800;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-chip em {
  padding: 2px 6px;
  border-radius: 999px;
  color: #5f50dd;
  background: rgba(121, 99, 255, 0.08);
  font-size: 8px;
  font-style: normal;
  font-weight: 900;
  line-height: 1;
  letter-spacing: 0;
  text-transform: uppercase;
}

.aurora-drag-dots {
  display: inline-flex;
  justify-content: center;
  gap: 5px;
  height: 8px;
}

.aurora-drag-dots span {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: rgba(80, 92, 128, 0.22);
}

.aurora-expanded-dock {
  position: absolute;
  top: calc(100% + 16px);
  left: 50%;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
  width: min(430px, calc(100vw - 420px));
  max-height: 188px;
  padding: 10px;
  overflow: auto;
  border: var(--aurora-holo-border);
  border-radius: 18px;
  background: var(--aurora-holo-bg);
  box-shadow: var(--aurora-holo-shadow);
  backdrop-filter: var(--aurora-holo-blur);
  transform: translateX(-50%);
}

.aurora-expanded-dock button {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 42px;
  padding: 7px;
  border: 1px solid rgba(255, 255, 255, 0.34);
  border-radius: 13px;
  color: rgba(46, 55, 100, 0.68);
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  text-align: left;
  transition: all var(--aurora-ease);
}

.aurora-expanded-dock button:hover,
.aurora-expanded-dock button:focus-visible {
  color: #5748dc;
  background: rgba(255, 255, 255, 0.12);
  outline: none;
  transform: translateY(-1px);
}

.aurora-expanded-dock span {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 11px;
  color: #4f7dff;
  background: rgba(255, 255, 255, 0.06);
  font-size: 9px;
  font-weight: 950;
}

.aurora-expanded-dock strong {
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  font-weight: 850;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aurora-dock-handle {
  position: absolute;
  bottom: -23px;
  left: 50%;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.58);
  border-radius: 999px;
  color: #4f63ff;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.035)),
    rgba(255, 255, 255, 0.06);
  box-shadow:
    0 12px 28px rgba(101, 103, 255, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.58);
  backdrop-filter: blur(24px);
  cursor: pointer;
  transform: translateX(-50%);
  transition: all var(--aurora-ease);
}

.aurora-dock-handle:hover,
.aurora-dock-handle:focus-visible {
  color: #fff;
  background: linear-gradient(135deg, #5f8dff, #8d6cff 58%, #c663ff);
  outline: none;
  transform: translateX(-50%) translateY(-1px);
}

.aurora-dock-handle svg {
  width: 18px;
  height: 18px;
}

.dock-expand-enter-active,
.dock-expand-leave-active {
  transition: all var(--aurora-ease);
}

.dock-expand-enter-from,
.dock-expand-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px) scale(0.98);
}

.aurora-trust-rail {
  position: absolute;
  top: 50%;
  right: clamp(18px, 3vw, 42px);
  display: grid;
  gap: 10px;
  width: min(250px, 22vw);
  padding: 16px;
  border-radius: 26px;
  transform: translateY(-50%);
}

.aurora-trust-rail article {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  min-height: 58px;
}

.aurora-trust-rail article > span {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 14px;
  color: #6758f5;
  background: rgba(255, 255, 255, 0.58);
  font-size: 13px;
  font-weight: 900;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.aurora-trust-rail strong {
  display: block;
  color: rgba(24, 32, 51, 0.78);
  font-size: 13px;
  font-weight: 850;
  line-height: 1.15;
}

.aurora-trust-rail p {
  margin: 4px 0 0;
  color: rgba(24, 32, 51, 0.48);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.25;
}

.aurora-trust-rail.memory-stream {
  gap: 12px;
  width: min(310px, 24vw);
  padding: 14px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.035)),
    rgba(255, 255, 255, 0.06);
}

.memory-stream-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.memory-stream-header p {
  margin: 0 0 4px;
  color: rgba(103, 88, 245, 0.76);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.12em;
  line-height: 1;
  text-transform: uppercase;
}

.memory-stream-header h2 {
  margin: 0;
  color: rgba(24, 32, 51, 0.84);
  font-size: 15px;
  font-weight: 900;
  line-height: 1.08;
  letter-spacing: 0;
}

.aurora-bottom-pill {
  position: absolute;
  bottom: clamp(18px, 4vh, 42px);
  left: clamp(18px, 3vw, 42px);
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 210px;
  padding: 9px 13px 9px 10px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 999px;
  color: rgba(45, 55, 96, 0.68);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.04)),
    rgba(255, 255, 255, 0.06);
  box-shadow:
    0 10px 32px rgba(92, 99, 255, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.56);
  backdrop-filter: blur(34px);
  pointer-events: auto;
}

.aurora-bottom-orb {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 999px;
  background:
    radial-gradient(circle at 34% 28%, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.14) 24%, transparent 32%),
    linear-gradient(135deg, rgba(62, 180, 255, 0.82), rgba(139, 92, 246, 0.72) 55%, rgba(217, 70, 239, 0.55));
  box-shadow:
    0 10px 24px rgba(111, 100, 255, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.56);
}

.aurora-bottom-pill strong,
.aurora-bottom-pill small {
  display: block;
}

.aurora-bottom-pill strong {
  color: rgba(50, 57, 110, 0.82);
  font-size: 12px;
  font-weight: 900;
  line-height: 1.05;
}

.aurora-bottom-pill small {
  margin-top: 2px;
  color: rgba(71, 80, 122, 0.5);
  font-size: 10px;
  font-weight: 750;
  line-height: 1.1;
}

.memory-stream-refresh {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.44);
  border-radius: 999px;
  color: rgba(82, 91, 132, 0.72);
  background: rgba(255, 255, 255, 0.055);
  font-size: 14px;
  font-weight: 900;
  line-height: 1;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.52);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.memory-stream-refresh:hover:not(:disabled) {
  color: #6758f5;
  transform: translateY(-1px) rotate(12deg);
}

.memory-stream-refresh:disabled {
  cursor: wait;
  opacity: 0.56;
}

.memory-stream-list {
  display: grid;
  gap: 8px;
}

.memory-stream-item {
  position: relative;
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr);
  gap: 9px 10px;
  align-items: center;
  width: 100%;
  min-width: 0;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.36);
  border-radius: 18px;
  color: rgba(24, 32, 51, 0.78);
  background: rgba(255, 255, 255, 0.045);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28);
  text-align: left;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.memory-stream-item:hover {
  border-color: rgba(103, 88, 245, 0.34);
  background: rgba(255, 255, 255, 0.11);
  box-shadow: 0 14px 34px rgba(89, 80, 190, 0.09), inset 0 1px 0 rgba(255, 255, 255, 0.38);
  transform: translateY(-1px);
}

.memory-stream-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.58);
  box-shadow: 0 0 14px rgba(99, 102, 241, 0.34);
}

.memory-stream-copy {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.memory-stream-copy strong {
  display: block;
  overflow: hidden;
  color: rgba(24, 32, 51, 0.84);
  font-size: 12px;
  font-weight: 850;
  line-height: 1.22;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.memory-stream-copy small {
  color: rgba(24, 32, 51, 0.42);
  font-size: 10px;
  font-weight: 750;
  line-height: 1;
}

.memory-stream-item em {
  grid-column: 2;
  justify-self: start;
  max-width: 100%;
  overflow: hidden;
  padding: 4px 8px;
  border: 1px solid rgba(99, 102, 241, 0.18);
  border-radius: 999px;
  color: rgba(79, 70, 229, 0.82);
  background: rgba(255, 255, 255, 0.08);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 9px;
  font-style: normal;
  font-weight: 850;
  letter-spacing: 0.03em;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.memory-stream-item.tone-proceed .memory-stream-dot {
  background: rgba(16, 185, 129, 0.62);
  box-shadow: 0 0 14px rgba(16, 185, 129, 0.34);
}

.memory-stream-item.tone-proceed em {
  color: rgba(4, 120, 87, 0.86);
  border-color: rgba(16, 185, 129, 0.2);
}

.memory-stream-item.tone-risk .memory-stream-dot {
  background: rgba(244, 63, 94, 0.56);
  box-shadow: 0 0 14px rgba(244, 63, 94, 0.3);
}

.memory-stream-item.tone-risk em {
  color: rgba(190, 18, 60, 0.82);
  border-color: rgba(244, 63, 94, 0.2);
}

.memory-stream-item.tone-watch .memory-stream-dot {
  background: rgba(168, 85, 247, 0.54);
  box-shadow: 0 0 14px rgba(168, 85, 247, 0.3);
}

.memory-stream-preview {
  position: absolute;
  right: calc(100% + 12px);
  top: 50%;
  z-index: 5;
  display: grid;
  gap: 6px;
  width: 250px;
  padding: 12px;
  border: var(--aurora-holo-border);
  border-radius: 18px;
  color: rgba(24, 32, 51, 0.72);
  background: var(--aurora-holo-bg);
  box-shadow:
    0 20px 54px rgba(80, 91, 160, 0.14),
    inset 0 1px 0 rgba(255, 255, 255, 0.34);
  backdrop-filter: var(--aurora-holo-blur);
  opacity: 0;
  pointer-events: none;
  transform: translate(8px, -50%) scale(0.98);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.memory-stream-preview strong,
.memory-stream-preview small,
.memory-stream-preview span {
  min-width: 0;
}

.memory-stream-preview strong {
  color: rgba(50, 57, 110, 0.82);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.03em;
  line-height: 1.2;
}

.memory-stream-preview small {
  color: rgba(103, 88, 245, 0.68);
  font-size: 10px;
  font-weight: 850;
  line-height: 1;
}

.memory-stream-preview span {
  color: rgba(24, 32, 51, 0.58);
  font-size: 11px;
  font-weight: 650;
  line-height: 1.35;
}

.memory-stream-item:hover .memory-stream-preview,
.memory-stream-item:focus-visible .memory-stream-preview {
  opacity: 1;
  transform: translate(0, -50%) scale(1);
}

.memory-stream-empty {
  padding: 12px;
  border: 1px dashed rgba(103, 88, 245, 0.22);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.05);
}

.memory-stream-empty strong {
  color: rgba(24, 32, 51, 0.74);
  font-size: 12px;
}

.memory-stream-empty p {
  margin-top: 6px;
}

.memory-stream-empty.warn {
  border-color: rgba(244, 63, 94, 0.2);
}

.aurora-idle-enter-active,
.aurora-idle-leave-active {
  transition: opacity var(--aurora-ease), transform var(--aurora-ease);
}

.aurora-idle-enter-from,
.aurora-idle-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

.aurora-status-strip {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 48px;
  padding: 0 18px;
  border-bottom: 1px solid rgba(126, 147, 178, 0.18);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.66), rgba(255, 255, 255, 0.36));
}

.aurora-brand,
.aurora-state {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.aurora-brand {
  gap: 10px;
}

.aurora-mark {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: conic-gradient(from 180deg, #2bd1ff, #ff73ac, #ffe68a, #2bd1ff);
  box-shadow: 0 0 18px rgba(43, 209, 255, 0.46);
}

.aurora-title {
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
  color: #152033;
}

.aurora-divider {
  width: 1px;
  height: 16px;
  flex: 0 0 auto;
  background: rgba(90, 105, 133, 0.24);
}

.aurora-session {
  min-width: 0;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.66);
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aurora-state {
  flex: 0 0 auto;
  gap: 7px;
  padding: 6px 10px;
  border: 1px solid rgba(76, 98, 131, 0.13);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.5);
  color: rgba(21, 32, 51, 0.62);
  font-size: 11px;
  font-weight: 700;
}

.aurora-state-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #48c78e;
  box-shadow: 0 0 12px rgba(72, 199, 142, 0.46);
}

.aurora-state.active .aurora-state-dot {
  background: #2bd1ff;
  box-shadow: 0 0 14px rgba(43, 209, 255, 0.66);
}

.aurora-workbench {
  position: relative;
  z-index: 4;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.aurora-workbench :deep(.chat-panel) {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.aurora-operating-layer.is-idle .aurora-workbench {
  pointer-events: none;
}

.aurora-operating-layer.is-idle .aurora-workbench :deep(.chat-panel.intent-launcher-mode) {
  background: transparent !important;
}

.aurora-operating-layer.is-idle .aurora-workbench :deep(.chat-input-area) {
  pointer-events: auto;
}

.aurora-operating-layer.is-idle .aurora-workbench :deep(.chat-main.intent-launcher-idle) {
  justify-content: center;
  padding: clamp(132px, 24vh, 190px) clamp(190px, 24vw, 360px) clamp(72px, 12vh, 122px);
}

:global(.dark) .aurora-operating-layer {
  --aurora-glass-bg: linear-gradient(135deg, rgba(29, 35, 48, 0.9), rgba(17, 21, 31, 0.78)), rgba(18, 22, 32, 0.78);
  --aurora-glass-bg-strong: linear-gradient(135deg, rgba(34, 40, 54, 0.92), rgba(20, 24, 34, 0.82)), rgba(18, 22, 32, 0.84);
  --aurora-glass-border: rgba(255, 255, 255, 0.12);
  --aurora-glass-shadow: 0 22px 70px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  --aurora-muted: rgba(237, 243, 255, 0.58);
  --aurora-text: #edf3ff;

  color: #edf3ff;
  background:
    linear-gradient(90deg, rgba(255, 255, 255, 0.045) 0 1px, transparent 1px 72px),
    linear-gradient(180deg, rgba(255, 255, 255, 0.04) 0 1px, transparent 1px 72px),
    linear-gradient(135deg, #151821 0%, #1b202b 48%, #221c2b 100%);
}

:global(.dark) .aurora-shell {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(19, 24, 34, 0.72);
  box-shadow:
    0 24px 70px rgba(0, 0, 0, 0.24),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

:global(.dark) .aurora-shell.console-closed {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

:global(.dark) .aurora-status-strip {
  border-bottom-color: rgba(255, 255, 255, 0.09);
  background: linear-gradient(180deg, rgba(34, 40, 54, 0.72), rgba(20, 24, 34, 0.42));
}

:global(.dark) .aurora-title {
  color: #edf3ff;
}

:global(.dark) .aurora-divider {
  background: rgba(255, 255, 255, 0.15);
}

:global(.dark) .aurora-session,
:global(.dark) .aurora-state {
  color: rgba(237, 243, 255, 0.68);
}

:global(.dark) .aurora-state {
  border-color: rgba(255, 255, 255, 0.11);
  background: rgba(255, 255, 255, 0.08);
}

:global(.dark) .aurora-top-bar,
:global(.dark) .top-bar-menu,
:global(.dark) .status-hover-card {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(18, 22, 32, 0.68);
}

:global(.dark) .top-bar-chip,
:global(.dark) .top-bar-avatar {
  color: rgba(237, 243, 255, 0.66);
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .top-bar-chip:hover,
:global(.dark) .top-bar-avatar:hover {
  color: #9de9ff;
  background: rgba(255, 255, 255, 0.1);
}

:global(.dark) .top-bar-menu-item,
:global(.dark) .status-hover-card {
  color: rgba(237, 243, 255, 0.7);
}

:global(.dark) .top-bar-menu-item small,
:global(.dark) .top-bar-empty,
:global(.dark) .status-hover-card span {
  color: rgba(237, 243, 255, 0.48);
}

:global(.dark) .language-glyph {
  color: rgba(190, 220, 255, 0.9);
}

:global(.dark) .top-bar-menu-item span,
:global(.dark) .status-hover-card strong {
  color: rgba(237, 243, 255, 0.9);
}

:global(.dark) .app-menu-header strong,
:global(.dark) .app-menu-copy strong {
  color: rgba(237, 243, 255, 0.88);
}

:global(.dark) .app-menu-header span,
:global(.dark) .desktop-config-message,
:global(.dark) .app-menu-copy small {
  color: rgba(237, 243, 255, 0.48);
}

:global(.dark) .desktop-config-actions button {
  color: #9de9ff;
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .desktop-presets button {
  color: rgba(237, 243, 255, 0.72);
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .desktop-presets button:hover,
:global(.dark) .desktop-presets button:focus-visible {
  color: #9de9ff;
  background: rgba(255, 255, 255, 0.1);
}

:global(.dark) .desktop-presets span {
  color: rgba(237, 243, 255, 0.48);
}

:global(.dark) .top-bar-app-row {
  color: rgba(237, 243, 255, 0.72);
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .top-bar-app-row:hover,
:global(.dark) .top-bar-app-row:focus-within {
  color: #9de9ff;
  background: rgba(255, 255, 255, 0.1);
}

:global(.dark) .top-bar-app-item,
:global(.dark) .app-pin-button {
  color: rgba(237, 243, 255, 0.66);
}

:global(.dark) .app-menu-icon {
  color: #9de9ff;
  background: rgba(255, 255, 255, 0.08);
}

@media (max-width: 1180px) {
  .aurora-trust-rail {
    display: none;
  }

  .aurora-tools-panel {
    width: min(500px, calc(100vw - 220px));
    min-width: 0;
  }

  .tool-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .aurora-operating-layer.is-idle .aurora-workbench :deep(.chat-main.intent-launcher-idle) {
    padding-right: clamp(120px, 16vw, 190px);
    padding-left: clamp(120px, 16vw, 190px);
  }
}

@media (max-width: 768px) {
  .aurora-operating-layer {
    padding: 8px;
  }

  .aurora-operating-layer.is-idle {
    padding: 0;
  }

  .aurora-floating-nav {
    top: auto;
    bottom: 18px;
    left: 50%;
    display: inline-flex;
    flex-direction: row;
    width: auto;
    min-height: 0;
    padding: 8px;
    transform: translateX(-50%);
  }

  .aurora-nav-button.primary {
    margin-bottom: 0;
  }

  .aurora-nav-button,
  .aurora-nav-button.primary {
    width: 40px;
    height: 40px;
  }

  .aurora-idle-brand {
    top: 92px;
    min-width: 0;
    width: calc(100vw - 32px);
    flex-direction: column;
    gap: 10px;
    text-align: center;
  }

  .aurora-top-bar {
    top: 12px;
    right: 12px;
    left: 12px;
    justify-content: flex-end;
    border-radius: 20px;
  }

  .top-bar-chip {
    max-width: 46vw;
  }

  .app-menu {
    width: calc(100vw - 24px);
  }

  .aurora-trust-rail {
    display: none;
  }

  .aurora-tools-panel {
    top: auto;
    right: 18px;
    bottom: 82px;
    left: 18px;
    width: auto;
    padding: 12px;
    border-radius: 20px;
    transform: none;
  }

  .launcher-panel-header {
    display: none;
  }

  .tool-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }

  .tool-chip {
    min-height: 56px;
    border-radius: 14px;
  }

  .tool-chip strong {
    font-size: 8px;
  }

  .aurora-dock-handle {
    bottom: -23px;
    width: 34px;
    height: 34px;
  }

  .aurora-bottom-pill {
    display: none;
  }

  .aurora-operating-layer.is-idle .aurora-workbench :deep(.chat-main.intent-launcher-idle) {
    padding: 180px 18px 98px;
  }

  .aurora-shell {
    border-radius: 18px;
  }

  .aurora-status-strip {
    min-height: 44px;
    padding: 0 12px;
  }

  .aurora-session {
    display: none;
  }
}
</style>
