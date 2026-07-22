<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NCard, NInput, NModal, NSelect, NSwitch, NTabPane, NTabs, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { desktopBridge, type DesktopBrowserProfile, type DesktopBrowserState } from '@/utils/desktop-bridge'
import { queueBrowserAttachment } from '@/utils/pending-browser-attachments'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const router = useRouter()
const bridge = desktopBridge()?.browser
const state = ref<DesktopBrowserState | null>(null)
const address = ref('')
const viewport = ref<HTMLElement>()
const showSettings = ref(false)
const profileName = ref('')
const settingsProfileId = ref('')
const profileDraft = ref<DesktopBrowserProfile | null>(null)
const busy = ref(false)
const loadError = ref('')
const overlayOpen = ref(false)
const externalModalOpen = ref(false)
let resizeObserver: ResizeObserver | null = null
let modalObserver: MutationObserver | null = null
let stopStateListener: (() => void) | undefined
let annotatingTabId: string | null = null
let unmounting = false

const activeTab = computed(() => state.value?.tabs.find(tab => tab.id === state.value?.activeTabId))
const profileOptions = computed(() => state.value?.profiles.map(profile => ({ label: profile.name, value: profile.id })) || [])
const conflictOptions = computed(() => [
  { label: t('browser.uniquifyDownloads'), value: 'uniquify' },
  { label: t('browser.askOnConflict'), value: 'ask' },
])
const profileDownloads = computed(() => state.value?.downloads.filter(item => item.profileId === settingsProfileId.value) || [])
const profilePermissions = computed(() => state.value?.permissions.filter(item => item.profileId === settingsProfileId.value) || [])

watch(() => activeTab.value?.url, value => { address.value = value || '' }, { immediate: true })
watch(settingsProfileId, profileId => {
  const profile = state.value?.profiles.find(item => item.id === profileId)
  profileDraft.value = profile ? { ...profile, tabs: [...profile.tabs] } : null
})
watch(showSettings, show => {
  if (show) settingsProfileId.value = state.value?.activeProfileId || ''
  void nextTick(syncViewport)
})
watch(overlayOpen, () => { void nextTick(syncViewport) })
watch(externalModalOpen, () => { void nextTick(syncViewport) })

function applyState(next: DesktopBrowserState): void {
  state.value = next
  if (settingsProfileId.value && !next.profiles.some(profile => profile.id === settingsProfileId.value)) {
    settingsProfileId.value = next.activeProfileId
  }
}

async function syncViewport(): Promise<void> {
  if (!bridge || !viewport.value) return
  const rect = viewport.value.getBoundingClientRect()
  const visible = !showSettings.value && !overlayOpen.value && !externalModalOpen.value
    && rect.width > 0 && rect.height > 0 && document.visibilityState === 'visible'
  await bridge.setViewport({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, visible).catch(() => undefined)
}

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true
  try { await action() } catch (error) { if (!unmounting) message.error(error instanceof Error ? error.message : String(error)) } finally { busy.value = false }
}

function navigate(): void {
  const tab = activeTab.value
  if (!tab || !address.value.trim()) return
  void run(() => bridge!.navigate(tab.id, address.value.trim()))
}

function navigationAction(action: 'back' | 'forward' | 'reload' | 'stop'): void {
  if (activeTab.value) void run(() => bridge!.navigationAction(activeTab.value!.id, action))
}

function createTab(): void {
  void run(() => bridge!.createTab('about:blank', true))
}

function closeTab(tabId: string, event: MouseEvent): void {
  event.stopPropagation()
  void run(() => bridge!.closeTab(tabId))
}

function activateTab(tabId: string): void {
  void run(() => bridge!.activateTab(tabId))
}

async function switchProfile(profileId: string): Promise<void> {
  if (!bridge || profileId === state.value?.activeProfileId) return
  try {
    const impact = await bridge.profileSwitchImpact()
    if (!impact.requiresConfirmation) return run(() => bridge.switchProfile(profileId))
    dialog.warning({
      title: t('browser.profileSwitchTitle'),
      content: t('browser.profileSwitchWarning', { agents: impact.activeAgentRuns, downloads: impact.activeDownloads, annotations: impact.pendingAnnotations }),
      positiveText: t('common.confirm'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => run(() => bridge.switchProfile(profileId, true)),
    })
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

function createProfile(): void {
  const name = profileName.value.trim()
  if (!name) return
  void run(async () => { await bridge!.createProfile(name); profileName.value = '' })
}

function chooseDirectory(kind: 'download' | 'session'): void {
  const draft = profileDraft.value
  if (!draft) return
  void run(async () => {
    const updated = await bridge!.chooseDirectory(kind, draft.id)
    if (updated) profileDraft.value = { ...updated, tabs: [...updated.tabs] }
  })
}

function saveProfile(): void {
  const draft = profileDraft.value
  if (!draft) return
  void run(async () => {
    const renamed = await bridge!.renameProfile(draft.id, draft.name)
    const updated = await bridge!.updateProfile(draft.id, {
      askBeforeDownload: draft.askBeforeDownload,
      downloadConflictPolicy: draft.downloadConflictPolicy,
    })
    profileDraft.value = { ...updated, name: renamed.name, tabs: [...updated.tabs] }
    message.success(t('common.saved'))
  })
}

function deleteProfile(profileId: string): void {
  dialog.warning({
    title: t('browser.deleteProfileTitle'),
    content: t('browser.deleteProfileWarning'),
    positiveText: t('common.delete'), negativeText: t('common.cancel'),
    onPositiveClick: () => run(() => bridge!.deleteProfile(profileId)),
  })
}

function clearProfileData(kind: 'cache' | 'site-data' | 'permission-audit'): void {
  const profileId = settingsProfileId.value
  if (!profileId) return
  const clear = () => run(async () => {
    await bridge!.clearProfileData(profileId, kind)
    message.success(t('browser.dataCleared'))
  })
  if (kind !== 'site-data') { void clear(); return }
  dialog.warning({
    title: t('browser.clearSiteData'), content: t('browser.clearSiteDataWarning'),
    positiveText: t('common.confirm'), negativeText: t('common.cancel'), onPositiveClick: clear,
  })
}

function takeOver(): void {
  if (activeTab.value) void run(() => bridge!.takeOver(activeTab.value!.id))
}

function handleOverlayVisibility(show: boolean): void {
  overlayOpen.value = show
}

function annotate(mode: 'element' | 'region'): void {
  const tab = activeTab.value
  if (!tab) return
  void run(async () => {
    annotatingTabId = tab.id
    try {
      const selection = await bridge!.annotate(tab.id, mode)
      const bytes = Uint8Array.from(atob(selection.screenshot.data), character => character.charCodeAt(0))
      const file = new File([bytes], `browser-${mode}-${Date.now()}.png`, { type: selection.screenshot.mediaType })
      queueBrowserAttachment(file, JSON.stringify({
        browser_selection: {
          url: selection.url,
          title: selection.title,
          mode: selection.mode,
          region: selection.region,
          ...(selection.element ? { element: selection.element } : {}),
        },
      }, null, 2))
      await bridge!.setViewport({ x: 0, y: 0, width: 1, height: 1 }, false)
      await router.push({ name: 'hermes.chat' })
      message.success(t('browser.annotationAdded'))
    } finally {
      if (annotatingTabId === tab.id) annotatingTabId = null
    }
  })
}

function handleVisibility(): void { void syncViewport() }

function detectExternalModal(): void {
  externalModalOpen.value = !!document.querySelector('.n-modal-container')
}

onMounted(async () => {
  if (!bridge) return
  try {
    state.value = await bridge.getState()
    stopStateListener = bridge.onStateChange(applyState)
    resizeObserver = new ResizeObserver(() => { void syncViewport() })
    if (viewport.value) resizeObserver.observe(viewport.value)
    modalObserver = new MutationObserver(detectExternalModal)
    modalObserver.observe(document.body, { childList: true, subtree: true })
    detectExternalModal()
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('resize', handleVisibility)
    await nextTick(syncViewport)
  } catch (error) {
    loadError.value = `${t('browser.loadFailed')}: ${error instanceof Error ? error.message : String(error)}`
    message.error(loadError.value)
  }
})

onUnmounted(() => {
  unmounting = true
  if (bridge && annotatingTabId) void bridge.cancelAnnotation(annotatingTabId)
  stopStateListener?.()
  resizeObserver?.disconnect()
  modalObserver?.disconnect()
  document.removeEventListener('visibilitychange', handleVisibility)
  window.removeEventListener('resize', handleVisibility)
  if (bridge) void bridge.setViewport({ x: 0, y: 0, width: 1, height: 1 }, false)
})
</script>

<template>
  <section class="browser-page">
    <div v-if="!bridge" class="unavailable">{{ t('browser.desktopOnly') }}</div>
    <template v-else>
      <header class="browser-header">
        <strong>{{ t('browser.title') }}</strong>
        <div class="header-actions">
          <NSelect :value="state?.activeProfileId" :options="profileOptions" size="small" class="profile-select" @update:value="switchProfile" @update:show="handleOverlayVisibility" />
          <NButton size="small" quaternary @click="showSettings = true">{{ t('browser.settings') }}</NButton>
        </div>
      </header>

      <div class="tab-strip">
        <button v-for="tab in state?.tabs" :key="tab.id" class="tab" :class="{ active: tab.id === state?.activeTabId }" @click="activateTab(tab.id)">
          <img v-if="tab.faviconUrl" :src="tab.faviconUrl" alt="" />
          <span>{{ tab.title || t('browser.newTab') }}</span>
          <i v-if="tab.agentControl !== 'idle'" :title="tab.agentAction">●</i>
          <b @click="closeTab(tab.id, $event)">×</b>
        </button>
        <button class="new-tab" :disabled="(state?.tabs.length || 0) >= (state?.maxTabs || 8)" @click="createTab">+</button>
      </div>

      <div class="toolbar">
        <button :disabled="!activeTab?.canGoBack" :title="t('browser.back')" @click="navigationAction('back')">←</button>
        <button :disabled="!activeTab?.canGoForward" :title="t('browser.forward')" @click="navigationAction('forward')">→</button>
        <button :title="activeTab?.loading ? t('browser.stop') : t('browser.reload')" @click="navigationAction(activeTab?.loading ? 'stop' : 'reload')">{{ activeTab?.loading ? '×' : '↻' }}</button>
        <NInput v-model:value="address" size="small" :placeholder="t('browser.addressPlaceholder')" :disabled="busy" @keydown.enter="navigate" />
        <NButton size="small" @click="annotate('element')">{{ t('browser.selectElement') }}</NButton>
        <NButton size="small" @click="annotate('region')">{{ t('browser.selectRegion') }}</NButton>
      </div>

      <div v-if="activeTab?.agentControl !== 'idle'" class="agent-banner">
        <span v-if="activeTab?.agentControl === 'waiting-for-user'">{{ t('browser.agentWaiting', { agent: activeTab?.agentLabel || t('browser.agent') }) }}</span>
        <span v-else>{{ t('browser.agentControlling', { agent: activeTab?.agentLabel || t('browser.agent') }) }} · {{ activeTab?.agentAction }}</span>
        <NButton size="tiny" @click="takeOver">{{ t('browser.takeOver') }}</NButton>
      </div>

      <div v-if="activeTab?.crashed" class="crash-banner">
        <span>{{ t('browser.tabCrashed') }}</span>
        <NButton size="tiny" @click="navigationAction('reload')">{{ t('browser.recoverTab') }}</NButton>
      </div>

      <div ref="viewport" class="native-viewport">
        <span v-if="loadError">{{ loadError }}</span>
        <span v-else-if="!state">{{ t('common.loading') }}</span>
      </div>

      <NModal v-model:show="showSettings" :mask-closable="false">
        <NCard class="settings-card" :title="t('browser.settings')" closable @close="showSettings = false">
          <NTabs type="line" animated>
            <NTabPane name="profiles" :tab="t('browser.profiles')">
              <div class="create-profile"><NInput v-model:value="profileName" :placeholder="t('browser.profileName')" /><NButton @click="createProfile">{{ t('common.create') }}</NButton></div>
              <div v-if="profileDraft" class="settings-form">
                <label>{{ t('browser.profiles') }}<NSelect v-model:value="settingsProfileId" :options="profileOptions" /></label>
                <label>{{ t('browser.profileName') }}<NInput v-model:value="profileDraft.name" /></label>
                <label>{{ t('browser.profileDirectory') }}<div class="path-row"><NInput v-model:value="profileDraft.sessionPath" readonly /><NButton @click="chooseDirectory('session')">…</NButton></div></label>
                <p v-if="profileDraft.pendingSessionPath" class="hint">{{ t('browser.profileMovePending') }}</p>
                <label>{{ t('browser.downloadDirectory') }}<div class="path-row"><NInput v-model:value="profileDraft.downloadPath" readonly /><NButton @click="chooseDirectory('download')">…</NButton></div></label>
                <label class="switch-row"><span>{{ t('browser.askBeforeDownload') }}</span><NSwitch v-model:value="profileDraft.askBeforeDownload" /></label>
                <label>{{ t('browser.downloadConflictPolicy') }}<NSelect v-model:value="profileDraft.downloadConflictPolicy" :options="conflictOptions" /></label>
                <div class="form-actions"><NButton type="primary" @click="saveProfile">{{ t('common.save') }}</NButton><NButton v-if="state && state.profiles.length > 1 && profileDraft.id !== state.activeProfileId" type="error" ghost @click="deleteProfile(profileDraft.id)">{{ t('common.delete') }}</NButton></div>
              </div>
            </NTabPane>
            <NTabPane name="downloads" :tab="t('browser.downloads')">
              <div v-if="!profileDownloads.length" class="empty">{{ t('common.noData') }}</div>
              <div v-for="item in profileDownloads" :key="item.id" class="record"><strong>{{ item.fileName }}</strong><span>{{ item.state }} · {{ item.savePath }}</span></div>
            </NTabPane>
            <NTabPane name="permissions" :tab="t('browser.permissions')">
              <p class="hint">{{ t('browser.permissionsHint') }}</p>
              <div class="form-actions">
                <NButton @click="clearProfileData('cache')">{{ t('browser.clearCache') }}</NButton>
                <NButton @click="clearProfileData('permission-audit')">{{ t('browser.clearPermissionAudit') }}</NButton>
                <NButton type="error" ghost @click="clearProfileData('site-data')">{{ t('browser.clearSiteData') }}</NButton>
              </div>
              <div v-if="!profilePermissions.length" class="empty">{{ t('common.noData') }}</div>
              <div v-for="item in profilePermissions" :key="item.id" class="record"><strong>{{ item.origin }}</strong><span>{{ item.permission }} · {{ t('browser.blocked') }}</span></div>
            </NTabPane>
          </NTabs>
        </NCard>
      </NModal>
    </template>
  </section>
</template>

<style scoped lang="scss">
.browser-page { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--text-color); }
.browser-header { height: 52px; flex: 0 0 52px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); }
.header-actions, .toolbar, .path-row, .create-profile, .form-actions { display: flex; align-items: center; gap: 8px; }
.profile-select { width: 160px; }
.tab-strip { height: 38px; flex: 0 0 38px; display: flex; align-items: flex-end; gap: 2px; padding: 4px 8px 0; overflow-x: auto; background: rgba(127,127,127,.06); }
.tab { width: 190px; min-width: 100px; height: 34px; border: 0; border-radius: 8px 8px 0 0; background: transparent; color: inherit; display: flex; align-items: center; gap: 7px; padding: 0 9px; cursor: pointer; }
.tab.active { background: var(--card-color, #fff); }
.tab img { width: 16px; height: 16px; }.tab span { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: left; }.tab i { color: #3b82f6; font-size: 9px; }.tab b { font: 18px/1 sans-serif; font-weight: 400; }
.new-tab, .toolbar > button { border: 0; background: transparent; color: inherit; cursor: pointer; border-radius: 6px; }.new-tab { width: 34px; height: 34px; font-size: 20px; }.toolbar > button { width: 30px; height: 30px; font-size: 18px; }.toolbar > button:hover, .new-tab:hover { background: rgba(127,127,127,.15); }.toolbar > button:disabled { opacity: .35; }
.toolbar { height: 46px; flex: 0 0 46px; padding: 7px 10px; border-bottom: 1px solid var(--border-color); }
.agent-banner, .crash-banner { min-height: 34px; display: flex; align-items: center; justify-content: space-between; padding: 4px 12px; font-size: 12px; }
.agent-banner { background: rgba(59,130,246,.12); color: #3b82f6; }.crash-banner { background: rgba(239,68,68,.12); color: #dc2626; }
.native-viewport { flex: 1; min-height: 100px; position: relative; display: grid; place-items: center; background: #fff; color: #777; }
.settings-card { width: min(720px, calc(100vw - 32px)); max-height: 80vh; overflow: auto; }
.settings-form { display: grid; gap: 14px; margin-top: 18px; }.settings-form label { display: grid; gap: 6px; font-size: 13px; }.path-row .n-input { flex: 1; }.switch-row { display: flex !important; align-items: center; justify-content: space-between; }.hint { color: var(--text-color-3); font-size: 12px; }.record { display: grid; gap: 3px; padding: 10px 0; border-bottom: 1px solid var(--border-color); }.record span { color: var(--text-color-3); font-size: 12px; overflow-wrap: anywhere; }.empty, .unavailable { padding: 40px; text-align: center; color: var(--text-color-3); }
</style>
