<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { desktopBridge, type DesktopBrowserSelection, type DesktopBrowserState } from '@/utils/desktop-bridge'

const emit = defineEmits<{
  attach: [payload: { file: File; context: string }]
}>()

const { t } = useI18n()
const message = useMessage()
const bridge = desktopBridge()?.browser
const state = ref<DesktopBrowserState | null>(null)
const address = ref('')
const viewport = ref<HTMLElement>()
const busy = ref(false)
const loadError = ref('')
const externalModalOpen = ref(false)
const annotationNote = ref('')
const annotations = ref<Array<{
  marker: number
  mode: 'element' | 'region'
  region: DesktopBrowserSelection['region']
  element?: DesktopBrowserSelection['element']
  note: string
}>>([])
const annotationCapture = ref<{
  file: File
  previewUrl: string
  tabId: string
  url: string
  title: string
  viewport: DesktopBrowserSelection['viewport']
} | null>(null)
const annotationTabId = ref<string | null>(null)
const pendingAnnotation = ref<{
  marker: number
  mode: 'element' | 'region'
  viewport: DesktopBrowserSelection['viewport']
  region: DesktopBrowserSelection['region']
  element?: DesktopBrowserSelection['element']
} | null>(null)
let resizeObserver: ResizeObserver | null = null
let modalObserver: MutationObserver | null = null
let stopStateListener: (() => void) | undefined
let stopAnnotationRequestListener: (() => void) | undefined
let annotatingTabId: string | null = null
let unmounting = false
let annotationNoteUpdate: Promise<unknown> = Promise.resolve()

const activeTab = computed(() => state.value?.tabs.find(tab => tab.id === state.value?.activeTabId))
const annotationCount = computed(() => annotations.value.length + (pendingAnnotation.value ? 1 : 0))
const hasAnnotationSession = computed(() => annotationCount.value > 0)
const annotationAbove = computed(() => {
  const pending = pendingAnnotation.value
  if (!pending) return false
  const spaceBelow = pending.viewport.height - pending.region.y - pending.region.height
  return spaceBelow < 180 && pending.region.y >= 180
})
const annotationAnchorStyle = computed(() => {
  const pending = pendingAnnotation.value
  if (!pending) return undefined
  const viewportWidth = Math.max(1, pending.viewport.width)
  const viewportHeight = Math.max(1, pending.viewport.height)
  const left = Math.min(100, Math.max(0, pending.region.x / viewportWidth * 100))
  const top = Math.min(100, Math.max(0, pending.region.y / viewportHeight * 100))
  const bottom = Math.min(100, Math.max(0, (pending.region.y + pending.region.height) / viewportHeight * 100))
  return {
    '--annotation-left': `${left}%`,
    '--annotation-top': `${top}%`,
    '--annotation-bottom': `${bottom}%`,
  }
})

watch(() => activeTab.value?.url, value => { address.value = value || '' }, { immediate: true })
watch(externalModalOpen, () => { void nextTick(syncViewport) })

function applyState(next: DesktopBrowserState): void {
  state.value = next
}

async function syncViewport(): Promise<void> {
  if (!bridge || !viewport.value) return
  const rect = viewport.value.getBoundingClientRect()
  const visible = !externalModalOpen.value && !pendingAnnotation.value
    && rect.width > 0 && rect.height > 0 && document.visibilityState === 'visible'
  await bridge.setViewport({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, visible).catch(() => undefined)
}

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true
  try {
    await action()
  } catch (error) {
    if (!unmounting) message.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
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
  if (hasAnnotationSession.value) return
  void run(() => bridge!.createTab('about:blank', true))
}

function closeTab(tabId: string, event: MouseEvent): void {
  event.stopPropagation()
  if (hasAnnotationSession.value) return
  void run(() => bridge!.closeTab(tabId))
}

function activateTab(tabId: string): void {
  if (hasAnnotationSession.value) return
  void run(() => bridge!.activateTab(tabId))
}

function takeOver(): void {
  if (activeTab.value) void run(() => bridge!.takeOver(activeTab.value!.id))
}

function annotate(mode: 'element' | 'region', tabId?: string): void {
  const tab = tabId ? state.value?.tabs.find(item => item.id === tabId) : activeTab.value
  if (!tab) return
  if (annotationTabId.value && annotationTabId.value !== tab.id) return
  void run(async () => {
    annotatingTabId = tab.id
    try {
      const selection = await bridge!.annotate(tab.id, mode)
      const bytes = Uint8Array.from(atob(selection.screenshot.data), character => character.charCodeAt(0))
      const file = new File([bytes], `browser-${mode}-${Date.now()}.png`, { type: selection.screenshot.mediaType })
      await bridge!.setViewport({ x: 0, y: 0, width: 1, height: 1 }, false)
      const viewport = selection.viewport || {
        width: selection.screenshot.width,
        height: selection.screenshot.height,
        scaleFactor: 1,
      }
      annotationTabId.value = tab.id
      annotationCapture.value = {
        file,
        previewUrl: `data:${selection.screenshot.mediaType};base64,${selection.screenshot.data}`,
        tabId: selection.tabId,
        url: selection.url,
        title: selection.title,
        viewport,
      }
      pendingAnnotation.value = {
        marker: selection.marker || annotationCount.value + 1,
        mode,
        viewport,
        region: selection.region,
        element: selection.element,
      }
      annotationNote.value = ''
    } finally {
      if (annotatingTabId === tab.id) annotatingTabId = null
    }
  })
}

async function commitPendingAnnotation(restoreViewport = true): Promise<void> {
  const pending = pendingAnnotation.value
  if (!pending) return
  const note = annotationNote.value.trim()
  const tabId = annotationTabId.value
  annotations.value.push({
    marker: pending.marker,
    mode: pending.mode,
    region: pending.region,
    ...(pending.element ? { element: pending.element } : {}),
    note,
  })
  pendingAnnotation.value = null
  annotationNote.value = ''
  annotationNoteUpdate = bridge && tabId
    ? bridge.updateAnnotationNote(tabId, pending.marker, note).catch(() => false)
    : Promise.resolve()
  await annotationNoteUpdate
  if (restoreViewport) await nextTick(syncViewport)
}

async function clearAnnotationSession(): Promise<void> {
  const tabId = annotationTabId.value
  pendingAnnotation.value = null
  annotations.value = []
  annotationCapture.value = null
  annotationTabId.value = null
  annotationNote.value = ''
  if (bridge && tabId) await bridge.clearAnnotations(tabId).catch(() => undefined)
  await nextTick(syncViewport)
}

async function sendAnnotations(): Promise<void> {
  await commitPendingAnnotation(false)
  await annotationNoteUpdate
  const capture = annotationCapture.value
  const tabId = annotationTabId.value
  if (!capture || annotations.value.length === 0) return
  let file = capture.file
  if (bridge && tabId) {
    const screenshot = await bridge.captureAnnotations(tabId).catch(() => null)
    if (screenshot) {
      const bytes = Uint8Array.from(atob(screenshot.data), character => character.charCodeAt(0))
      file = new File([bytes], `browser-annotations-${Date.now()}.png`, { type: screenshot.mediaType })
    }
  }
  emit('attach', {
    file,
    context: JSON.stringify({
      browser_selection: {
        tab_id: capture.tabId,
        url: capture.url,
        title: capture.title,
        viewport: capture.viewport,
        annotations: annotations.value,
      },
    }, null, 2),
  })
  annotations.value = []
  annotationCapture.value = null
  annotationTabId.value = null
  annotationNote.value = ''
  message.success(t('browser.annotationAdded'))
  void (async () => {
    if (bridge && tabId) await bridge.clearAnnotations(tabId).catch(() => undefined)
    await nextTick(syncViewport)
  })()
}

function handleAnnotationFocusout(event: FocusEvent): void {
  const container = event.currentTarget
  const next = event.relatedTarget
  if (container instanceof HTMLElement && next instanceof Node && container.contains(next)) return
  void commitPendingAnnotation()
}

function handleAnnotationKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
  event.preventDefault()
  void sendAnnotations()
}

function handleVisibility(): void {
  void syncViewport()
}

function detectExternalModal(): void {
  externalModalOpen.value = !!document.querySelector('.n-modal-container')
}

onMounted(async () => {
  if (!bridge) return
  try {
    state.value = await bridge.getState()
    stopStateListener = bridge.onStateChange(applyState)
    stopAnnotationRequestListener = bridge.onAnnotationRequest(request => {
      if (state.value?.tabs.some(tab => tab.id === request.tabId)) annotate(request.mode, request.tabId)
    })
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
  if (bridge && annotationTabId.value) void bridge.clearAnnotations(annotationTabId.value)
  stopStateListener?.()
  stopAnnotationRequestListener?.()
  resizeObserver?.disconnect()
  modalObserver?.disconnect()
  document.removeEventListener('visibilitychange', handleVisibility)
  window.removeEventListener('resize', handleVisibility)
  if (bridge) void bridge.setViewport({ x: 0, y: 0, width: 1, height: 1 }, false)
})
</script>

<template>
  <section class="browser-panel">
    <div v-if="!bridge" class="unavailable">{{ t('browser.desktopOnly') }}</div>
    <template v-else>
      <div class="tab-strip">
        <button v-for="tab in state?.tabs" :key="tab.id" class="tab" :class="{ active: tab.id === state?.activeTabId }" :disabled="hasAnnotationSession" @click="activateTab(tab.id)">
          <img v-if="tab.faviconUrl" :src="tab.faviconUrl" alt="" />
          <span>{{ tab.title || t('browser.newTab') }}</span>
          <i v-if="tab.agentControl !== 'idle'" :title="tab.agentAction">●</i>
          <b @click="closeTab(tab.id, $event)">×</b>
        </button>
        <button class="new-tab" :disabled="hasAnnotationSession || (state?.tabs.length || 0) >= (state?.maxTabs || 8)" @click="createTab">+</button>
      </div>

      <div class="toolbar">
        <button :disabled="hasAnnotationSession || !activeTab?.canGoBack" :title="t('browser.back')" @click="navigationAction('back')">←</button>
        <button :disabled="hasAnnotationSession || !activeTab?.canGoForward" :title="t('browser.forward')" @click="navigationAction('forward')">→</button>
        <button :disabled="hasAnnotationSession" :title="activeTab?.loading ? t('browser.stop') : t('browser.reload')" @click="navigationAction(activeTab?.loading ? 'stop' : 'reload')">{{ activeTab?.loading ? '×' : '↻' }}</button>
        <NInput v-model:value="address" size="small" :placeholder="t('browser.addressPlaceholder')" :disabled="busy || hasAnnotationSession" @keydown.enter="navigate" />
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

      <div v-if="hasAnnotationSession" class="annotation-session-bar">
        <span>{{ t('browser.annotationCount', { count: annotationCount }) }}</span>
        <div>
          <NButton size="tiny" @mousedown.prevent @click="clearAnnotationSession">{{ t('browser.clearAnnotations') }}</NButton>
          <NButton size="tiny" type="primary" @mousedown.prevent @click="sendAnnotations">{{ t('chat.send') }}</NButton>
        </div>
      </div>

      <div v-if="pendingAnnotation" class="annotation-editor">
        <div class="annotation-preview" :style="annotationAnchorStyle">
          <img :src="annotationCapture?.previewUrl" alt="" />
          <div class="annotation-popover" :class="{ above: annotationAbove }" @focusout="handleAnnotationFocusout">
            <strong>{{ t('browser.annotationLabel', { index: pendingAnnotation.marker }) }} · {{ t(pendingAnnotation.mode === 'element' ? 'browser.selectElement' : 'browser.selectRegion') }}</strong>
            <NInput
              v-model:value="annotationNote"
              type="textarea"
              :rows="3"
              autofocus
              :placeholder="t('browser.annotationPlaceholder')"
              @keydown="handleAnnotationKeydown"
            />
            <div class="annotation-actions">
              <NButton size="small" @mousedown.prevent @click="clearAnnotationSession">{{ t('browser.clearAnnotations') }}</NButton>
              <NButton size="small" type="primary" @mousedown.prevent @click="commitPendingAnnotation()">{{ t('browser.finishAnnotation') }}</NButton>
            </div>
          </div>
        </div>
      </div>

      <div v-show="!pendingAnnotation" ref="viewport" class="native-viewport">
        <span v-if="loadError">{{ loadError }}</span>
        <span v-else-if="!state">{{ t('common.loading') }}</span>
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
.browser-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--text-color); }
.tab-strip { height: 38px; flex: 0 0 38px; display: flex; align-items: flex-end; gap: 2px; padding: 4px 8px 0; overflow-x: auto; background: rgba(127,127,127,.06); }
.tab { width: 190px; min-width: 100px; height: 34px; border: 0; border-radius: 8px 8px 0 0; background: transparent; color: inherit; display: flex; align-items: center; gap: 7px; padding: 0 9px; cursor: pointer; }
.tab.active { background: var(--card-color, #fff); }
.tab img { width: 16px; height: 16px; }.tab span { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: left; }.tab i { color: #3b82f6; font-size: 9px; }.tab b { font: 18px/1 sans-serif; font-weight: 400; }
.new-tab, .toolbar > button { border: 0; background: transparent; color: inherit; cursor: pointer; border-radius: 6px; }.new-tab { width: 34px; height: 34px; font-size: 20px; }.toolbar > button { width: 30px; height: 30px; font-size: 18px; }.toolbar > button:hover, .new-tab:hover { background: rgba(127,127,127,.15); }.toolbar > button:disabled { opacity: .35; }
.toolbar { height: 46px; flex: 0 0 46px; padding: 7px 10px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; gap: 8px; }
.agent-banner, .crash-banner { min-height: 34px; display: flex; align-items: center; justify-content: space-between; padding: 4px 12px; font-size: 12px; }
.agent-banner { background: rgba(59,130,246,.12); color: #3b82f6; }.crash-banner { background: rgba(239,68,68,.12); color: #dc2626; }
.annotation-session-bar { min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 10px; color: #2563eb; background: rgba(59,130,246,.1); font-size: 12px; }
.annotation-session-bar > div { display: flex; gap: 6px; }
.native-viewport { flex: 1; min-height: 100px; position: relative; display: grid; place-items: center; background: #fff; color: #777; }
.annotation-editor { flex: 1; min-height: 0; overflow: auto; padding: 12px; background: var(--card-color, #fff); }
.annotation-preview { position: relative; width: 100%; margin-bottom: 168px; line-height: 0; }
.annotation-preview > img { display: block; width: 100%; height: auto; border: 1px solid var(--border-color); border-radius: 8px; background: #fff; box-sizing: border-box; }
.annotation-popover { position: absolute; z-index: 2; left: clamp(8px, var(--annotation-left), calc(100% - 328px)); top: calc(var(--annotation-bottom) + 32px); width: min(320px, calc(100% - 16px)); padding: 10px; display: flex; flex-direction: column; gap: 8px; line-height: normal; border: 1px solid rgba(59,130,246,.45); border-radius: 10px; background: var(--card-color, #fff); box-shadow: 0 8px 28px rgba(15,23,42,.22); box-sizing: border-box; }
.annotation-popover.above { top: auto; bottom: calc(100% - var(--annotation-top) + 8px); }
.annotation-popover > strong { color: #3b82f6; font-size: 12px; }
.annotation-actions { display: flex; justify-content: flex-end; gap: 8px; }
.unavailable { padding: 40px; text-align: center; color: var(--text-color-3); }
</style>
