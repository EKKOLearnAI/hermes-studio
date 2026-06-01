import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AuroraAppKind } from '@/services/hermes/aurora/capability-manifest'

export interface AuroraFocusedAppContext {
  kind: AuroraAppKind
  title: string
  subtitle?: string
  payload?: Record<string, unknown> | null
  focusedAt: string
}

export interface AuroraBrowserContext {
  url: string
  iframeUrl?: string
  title?: string
  source?: string
  topic?: string
  excerpt?: string
  updatedAt: string
}

export interface AuroraFileContext {
  path: string
  name?: string
  language?: string
  updatedAt: string
}

function clip(value: string, max = 420): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean
}

function stringifyPayload(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return ''
  try {
    return clip(JSON.stringify(payload), 360)
  } catch {
    return ''
  }
}

export const WORKING_MEMORY_CONTEXT_MARKER = '[Aurora Working Memory]'
const WORKING_MEMORY_LOCK_KEY = 'aurora.working-memory.context-lock'

function readContextLockDefault(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = window.localStorage.getItem(WORKING_MEMORY_LOCK_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}

export const useAuroraWorkingMemoryStore = defineStore('aurora-working-memory', () => {
  const contextLockEnabled = ref(readContextLockDefault())
  const focusedApp = ref<AuroraFocusedAppContext | null>(null)
  const browserContext = ref<AuroraBrowserContext | null>(null)
  const fileContext = ref<AuroraFileContext | null>(null)

  const hasContextLock = computed(() =>
    contextLockEnabled.value && Boolean(focusedApp.value || browserContext.value || fileContext.value),
  )

  const contextLabel = computed(() => {
    if (browserContext.value?.title) return browserContext.value.title
    if (browserContext.value?.url) {
      try {
        return new URL(browserContext.value.url).host
      } catch {
        return browserContext.value.url
      }
    }
    if (fileContext.value?.name || fileContext.value?.path) return fileContext.value.name || fileContext.value.path
    if (focusedApp.value?.title) return focusedApp.value.title
    return ''
  })

  const contextSummary = computed(() => {
    const lines: string[] = []
    if (focusedApp.value) {
      lines.push(`Focused app: ${focusedApp.value.title} (${focusedApp.value.kind})`)
      if (focusedApp.value.subtitle) lines.push(`App detail: ${focusedApp.value.subtitle}`)
      const payload = stringifyPayload(focusedApp.value.payload)
      if (payload) lines.push(`App payload: ${payload}`)
    }
    if (browserContext.value) {
      lines.push(`Browser URL: ${browserContext.value.url}`)
      if (browserContext.value.title) lines.push(`Browser title/topic: ${browserContext.value.title}`)
      if (browserContext.value.topic) lines.push(`Browser topic: ${browserContext.value.topic}`)
      if (browserContext.value.excerpt) lines.push(`Visible page excerpt: ${clip(browserContext.value.excerpt, 900)}`)
      if (browserContext.value.iframeUrl && browserContext.value.iframeUrl !== browserContext.value.url) {
        lines.push(`Embedded URL: ${browserContext.value.iframeUrl}`)
      }
    }
    if (fileContext.value) {
      lines.push(`Active file: ${fileContext.value.path}`)
      if (fileContext.value.language) lines.push(`File language: ${fileContext.value.language}`)
    }
    return lines.join('\n')
  })

  function focusApp(input: Omit<AuroraFocusedAppContext, 'focusedAt'>) {
    focusedApp.value = {
      ...input,
      focusedAt: new Date().toISOString(),
    }
  }

  function clearFocusedApp(kind?: AuroraAppKind) {
    if (!kind || focusedApp.value?.kind === kind) focusedApp.value = null
  }

  function setBrowserContext(input: Omit<AuroraBrowserContext, 'updatedAt'> & { updatedAt?: string }) {
    browserContext.value = {
      ...input,
      updatedAt: input.updatedAt || new Date().toISOString(),
    }
  }

  function setFileContext(input: Omit<AuroraFileContext, 'updatedAt'> & { updatedAt?: string }) {
    fileContext.value = {
      ...input,
      updatedAt: input.updatedAt || new Date().toISOString(),
    }
  }

  function clearBrowserContext() {
    browserContext.value = null
  }

  function clearFileContext() {
    fileContext.value = null
  }

  function clearAllContext() {
    focusedApp.value = null
    browserContext.value = null
    fileContext.value = null
  }

  function setContextLockEnabled(enabled: boolean) {
    contextLockEnabled.value = enabled
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(WORKING_MEMORY_LOCK_KEY, enabled ? '1' : '0')
      } catch {
        // Context lock preference can safely fall back to in-memory state.
      }
    }
  }

  function toggleContextLock() {
    setContextLockEnabled(!contextLockEnabled.value)
  }

  function enrichPrompt(input: string): string {
    const clean = input.trim()
    if (!contextLockEnabled.value) return clean
    const summary = contextSummary.value.trim()
    if (!summary || clean.includes(WORKING_MEMORY_CONTEXT_MARKER)) return clean
    return `${clean}\n\n${WORKING_MEMORY_CONTEXT_MARKER}\n${summary}`
  }

  return {
    contextLockEnabled,
    focusedApp,
    browserContext,
    fileContext,
    hasContextLock,
    contextLabel,
    contextSummary,
    focusApp,
    clearFocusedApp,
    setBrowserContext,
    setFileContext,
    clearBrowserContext,
    clearFileContext,
    clearAllContext,
    setContextLockEnabled,
    toggleContextLock,
    enrichPrompt,
  }
})
