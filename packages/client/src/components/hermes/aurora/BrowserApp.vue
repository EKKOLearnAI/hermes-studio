<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { auroraEventBus } from '@/services/hermes/aurora/aurora-event-bus'
import { useAuroraWorkingMemoryStore } from '@/stores/hermes/working-memory'

const props = withDefaults(defineProps<{
  initialUrl?: string
  source?: string
}>(), {
  initialUrl: 'https://www.google.com/search?igu=1',
  source: 'aurora',
})

interface WebSandboxContext {
  url: string
  iframeUrl: string
  pageExcerpt?: string
  source: string
  updatedAt: string
}

declare global {
  interface Window {
    __AURORA_WEB_SANDBOX__?: WebSandboxContext
  }
}

const addressInput = ref('')
const currentUrl = ref('')
const iframeUrl = ref('')
const pageExcerpt = ref('')
const isLoading = ref(false)
const navigationError = ref('')
const historyStack = ref<string[]>([])
const historyIndex = ref(-1)
const workingMemoryStore = useAuroraWorkingMemoryStore()
let loadTimer: ReturnType<typeof setTimeout> | null = null

const canGoBack = computed(() => historyIndex.value > 0)
const canGoForward = computed(() => historyIndex.value >= 0 && historyIndex.value < historyStack.value.length - 1)
const hostLabel = computed(() => {
  try {
    return new URL(currentUrl.value).host || 'Sandbox'
  } catch {
    return 'Sandbox'
  }
})

function normalizeBrowserUrl(value: string): string | null {
  let target = String(value || '').trim()
  if (!target) return null
  target = target.replace(/^<(.+)>$/, '$1').trim()

  const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
  const isLocalHost = /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(target)
    || /^127(?:\.\d+){3}(?::\d+)?(?:[/?#].*)?$/.test(target)
  const looksLikeDomain = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#].*)?$/i.test(target)

  if (!hasProtocol) {
    if (isLocalHost) {
      target = `http://${target}`
    } else if (looksLikeDomain) {
      target = `https://${target}`
    } else {
      target = `https://www.google.com/search?igu=1&q=${encodeURIComponent(target)}`
    }
  }

  try {
    const parsed = new URL(target)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function toEmbeddableUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace(/^www\./, '')
    if (hostname.startsWith('google.') && parsed.pathname === '/') {
      return 'https://www.google.com/search?igu=1'
    }
    return parsed.toString()
  } catch {
    return url
  }
}

function publishSandboxContext() {
  const analyzedAt = new Date().toISOString()
  const context: WebSandboxContext = {
    url: currentUrl.value,
    iframeUrl: iframeUrl.value,
    pageExcerpt: pageExcerpt.value || undefined,
    source: props.source,
    updatedAt: analyzedAt,
  }
  window.__AURORA_WEB_SANDBOX__ = context
  workingMemoryStore.setBrowserContext({
    url: currentUrl.value,
    iframeUrl: iframeUrl.value,
    title: hostLabel.value,
    excerpt: pageExcerpt.value,
    source: props.source,
    topic: hostLabel.value,
    updatedAt: analyzedAt,
  })
  auroraEventBus.publish('PAGE_ANALYZED', {
    url: currentUrl.value,
    iframeUrl: iframeUrl.value,
    title: hostLabel.value,
    excerpt: pageExcerpt.value || undefined,
    source: props.source,
    topic: hostLabel.value,
    analyzedAt,
  })
  try {
    window.localStorage.setItem('aurora.webSandbox.current', JSON.stringify(context))
  } catch {
    // Local storage is advisory context for agents and should not interrupt browsing.
  }
  window.dispatchEvent(new CustomEvent('aurora:web-sandbox-url', { detail: context }))
}

function clearLoadTimer() {
  if (!loadTimer) return
  clearTimeout(loadTimer)
  loadTimer = null
}

function armLoadTimeout() {
  clearLoadTimer()
  loadTimer = setTimeout(() => {
    isLoading.value = false
    loadTimer = null
  }, 1800)
}

function setHistory(url: string, shouldPush: boolean) {
  if (!shouldPush) return
  const previous = historyStack.value[historyIndex.value]
  if (previous === url) return
  const nextStack = historyStack.value.slice(0, Math.max(historyIndex.value + 1, 0))
  nextStack.push(url)
  historyStack.value = nextStack
  historyIndex.value = nextStack.length - 1
}

function navigateTo(value: string, shouldPush = true) {
  const url = normalizeBrowserUrl(value)
  if (!url) {
    navigationError.value = 'Enter a valid web address or search phrase.'
    return
  }

  navigationError.value = ''
  isLoading.value = true
  armLoadTimeout()
  pageExcerpt.value = ''
  currentUrl.value = url
  iframeUrl.value = toEmbeddableUrl(url)
  addressInput.value = url
  setHistory(url, shouldPush)
  publishSandboxContext()
}

function submitAddress() {
  navigateTo(addressInput.value)
}

function goBack() {
  if (!canGoBack.value) return
  historyIndex.value -= 1
  navigateTo(historyStack.value[historyIndex.value], false)
}

function goForward() {
  if (!canGoForward.value) return
  historyIndex.value += 1
  navigateTo(historyStack.value[historyIndex.value], false)
}

function refreshFrame() {
  if (!iframeUrl.value) return
  isLoading.value = true
  pageExcerpt.value = ''
  armLoadTimeout()
  iframeUrl.value = ''
  requestAnimationFrame(() => {
    iframeUrl.value = toEmbeddableUrl(currentUrl.value)
    publishSandboxContext()
  })
}

function extractFrameExcerpt(frame: HTMLIFrameElement | null): string {
  if (!frame) return ''
  try {
    const bodyText = frame.contentDocument?.body?.innerText || ''
    return bodyText.replace(/\s+/g, ' ').trim().slice(0, 1400)
  } catch {
    return ''
  }
}

function handleFrameLoad(event: Event) {
  clearLoadTimer()
  isLoading.value = false
  pageExcerpt.value = extractFrameExcerpt(event.target instanceof HTMLIFrameElement ? event.target : null)
  publishSandboxContext()
}

watch(() => props.initialUrl, (nextUrl) => {
  navigateTo(nextUrl || 'https://www.google.com/search?igu=1')
})

onMounted(() => {
  navigateTo(props.initialUrl || 'https://www.google.com/search?igu=1')
})

onBeforeUnmount(() => {
  clearLoadTimer()
})
</script>

<template>
  <section class="browser-app" aria-label="Aurora Web Sandbox">
    <header class="browser-toolbar">
      <div class="browser-window-dots" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>

      <div class="browser-navigation">
        <button type="button" :disabled="!canGoBack" aria-label="Back" @click="goBack">Back</button>
        <button type="button" :disabled="!canGoForward" aria-label="Forward" @click="goForward">Forward</button>
        <button type="button" aria-label="Refresh" @click="refreshFrame">Refresh</button>
      </div>

      <form class="browser-address-shell" @submit.prevent="submitAddress">
        <span>{{ hostLabel }}</span>
        <input
          v-model="addressInput"
          data-testid="aurora-browser-address"
          aria-label="Sandbox browser address"
          autocomplete="off"
          spellcheck="false"
        />
      </form>

      <a class="browser-open-link" :href="currentUrl" target="_blank" rel="noreferrer">Open</a>
    </header>

    <main class="browser-viewport">
      <iframe
        v-if="iframeUrl"
        class="browser-frame"
        data-testid="aurora-browser-frame"
        :src="iframeUrl"
        title="Aurora Web Sandbox"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerpolicy="no-referrer-when-downgrade"
        @load="handleFrameLoad"
      ></iframe>

      <div v-if="isLoading || navigationError" class="browser-state-card">
        <strong>{{ navigationError ? 'Navigation paused' : 'Loading sandbox' }}</strong>
        <span>{{ navigationError || `Rendering ${hostLabel} in an isolated iframe.` }}</span>
      </div>
    </main>

    <footer class="browser-context-bar">
      <span>OpenClaw context</span>
      <strong>{{ currentUrl }}</strong>
    </footer>
  </section>
</template>

<style scoped lang="scss">
.browser-app {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: rgba(248, 250, 252, 0.94);
  background:
    radial-gradient(760px 480px at 12% 10%, rgba(56, 189, 248, 0.16), transparent 62%),
    radial-gradient(820px 520px at 86% 12%, rgba(168, 85, 247, 0.18), transparent 60%),
    linear-gradient(135deg, rgba(2, 6, 23, 0.96), rgba(15, 23, 42, 0.9));
  font-family: Poppins, "Noto Sans TC", "Noto Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.browser-toolbar {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  margin: 14px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.055);
  box-shadow: 0 24px 78px rgba(2, 6, 23, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
}

.browser-window-dots,
.browser-navigation {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.browser-window-dots span {
  width: 11px;
  height: 11px;
  border-radius: 999px;
}

.browser-window-dots span:nth-child(1) {
  background: #ff5f57;
}

.browser-window-dots span:nth-child(2) {
  background: #ffbd2e;
}

.browser-window-dots span:nth-child(3) {
  background: #28c840;
}

.browser-navigation button,
.browser-open-link {
  display: inline-grid;
  min-height: 30px;
  place-items: center;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  color: rgba(226, 232, 240, 0.86);
  background: rgba(255, 255, 255, 0.06);
  cursor: pointer;
  font-size: 11px;
  font-weight: 850;
  text-decoration: none;
  transition: all 0.24s cubic-bezier(0.4, 0, 0.2, 1);
}

.browser-navigation button:hover:not(:disabled),
.browser-open-link:hover,
.browser-navigation button:focus-visible,
.browser-open-link:focus-visible {
  border-color: rgba(129, 140, 248, 0.38);
  color: #fff;
  background: rgba(129, 140, 248, 0.18);
  outline: none;
  transform: translateY(-1px);
}

.browser-navigation button:disabled {
  cursor: default;
  opacity: 0.42;
}

.browser-address-shell {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 38px;
  padding: 0 13px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(2, 6, 23, 0.28);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.browser-address-shell span {
  color: rgba(167, 243, 208, 0.82);
  font-size: 10px;
  font-weight: 920;
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
}

.browser-address-shell input {
  width: 100%;
  min-width: 0;
  border: 0;
  color: rgba(248, 250, 252, 0.94);
  background: transparent;
  outline: none;
  font-size: 13px;
  font-weight: 750;
}

.browser-viewport {
  position: relative;
  min-height: 0;
  margin: 0 14px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 28px;
  background: rgba(2, 6, 23, 0.32);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 26px 84px rgba(2, 6, 23, 0.28);
}

.browser-frame {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  background: rgba(255, 255, 255, 0.96);
}

.browser-state-card {
  position: absolute;
  inset: 50% auto auto 50%;
  display: grid;
  width: min(300px, calc(100% - 44px));
  gap: 8px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 22px;
  background: rgba(15, 23, 42, 0.68);
  box-shadow: 0 24px 70px rgba(2, 6, 23, 0.34);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  text-align: center;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.browser-state-card strong {
  color: rgba(248, 250, 252, 0.94);
  font-size: 13px;
  font-weight: 900;
}

.browser-state-card span {
  color: rgba(203, 213, 225, 0.76);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
}

.browser-context-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-width: 0;
  margin: 12px 14px 14px;
  padding: 9px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  color: rgba(203, 213, 225, 0.72);
  background: rgba(255, 255, 255, 0.045);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.browser-context-bar span {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 920;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.browser-context-bar strong {
  min-width: 0;
  overflow: hidden;
  color: rgba(248, 250, 252, 0.82);
  font-size: 11px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 760px) {
  .browser-toolbar {
    grid-template-columns: auto minmax(0, 1fr) auto;
    border-radius: 24px;
  }

  .browser-window-dots {
    display: none;
  }

  .browser-navigation {
    grid-column: 1 / -1;
    justify-content: center;
    order: 2;
  }

  .browser-address-shell {
    min-height: 36px;
  }
}
</style>
