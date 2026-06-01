// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  AURORA_APP_CAPABILITIES,
  AURORA_APP_CAPABILITY_ORDER,
  AURORA_LAUNCHER_APP_KINDS,
  getAuroraAppWindowMeta,
} from '@/services/hermes/aurora/capability-manifest'
import {
  AURORA_APP_WINDOW_REGISTRY,
  getAuroraAppWindowDefinition,
} from '@/services/hermes/aurora/app-window-registry'
import { ToolRegistry } from '@/services/hermes/aurora/tool-registry'
import { useAppStore } from '@/stores/hermes/app'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import { useAuroraCommanderStore } from '@/stores/hermes/aurora-commander'

const appIntentSamples = {
  'life-os': 'open LifeOS',
  'quant-lab': 'open Quant Lab',
  tradingview: 'open TradingView',
  mirofish: 'Run MiroFish on AVGO',
  'mirofish-graph': 'open MiroFish graph',
  'mirofish-arena': 'open MiroFish debate',
  kanban: 'open Kanban',
  memory: 'open Memory',
  files: 'open Files',
  'video-studio': '請製作一支 9:16 直式短影片',
  browser: 'open browser',
  jobs: 'open jobs',
  history: 'open history',
  models: 'open models',
  profiles: 'open profiles',
  channels: 'open channels',
  'group-chat': 'open group chat',
  gateways: 'open gateways',
  logs: 'open logs',
  usage: 'open usage',
  skills: 'open skills',
  plugins: 'open plugins',
  'code-intelligence': 'open code intelligence',
  'system-status': 'open system status',
  settings: 'open settings',
} satisfies Record<keyof typeof AURORA_APP_CAPABILITIES, string>

describe('Aurora App Mode contract', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  it('keeps every manifest app wired to registry metadata, component loader, and intent routing', () => {
    const registryKinds = Object.keys(AURORA_APP_WINDOW_REGISTRY)

    expect(registryKinds.sort()).toEqual([...AURORA_APP_CAPABILITY_ORDER].sort())

    for (const kind of AURORA_APP_CAPABILITY_ORDER) {
      const capability = AURORA_APP_CAPABILITIES[kind]
      const registryEntry = getAuroraAppWindowDefinition(kind)
      const windowMeta = getAuroraAppWindowMeta(kind)

      expect(registryEntry.kind).toBe(kind)
      expect(registryEntry.title).toBe(capability.title)
      expect(registryEntry.subtitle).toBe(capability.subtitle)
      expect(registryEntry.component, kind).toBeTruthy()
      expect(windowMeta).toEqual({
        kind,
        title: capability.title,
        subtitle: capability.subtitle,
      })

      const execution = ToolRegistry.findForInput(appIntentSamples[kind])
      const expectedToolId = kind === 'mirofish' || kind === 'mirofish-arena'
        ? 'quant.mirofish.run'
        : kind === 'mirofish-graph'
          ? 'quant.mirofish.graph.open'
        : kind === 'video-studio'
          ? 'aurora.videoStudio.open'
          : kind === 'browser'
            ? 'aurora.legacyApp.open'
            : 'aurora.legacyApp.open'
      const expectedKind = kind === 'mirofish-arena' ? 'mirofish' : kind
      expect(execution?.toolId, kind).toBe(expectedToolId)
      expect(execution?.args, kind).toMatchObject({ kind: expectedKind })
    }
  })

  it('routes OmniBar MiroFish ticker intents to the Debate Arena tool payload', async () => {
    const execution = ToolRegistry.findForInput('Run MiroFish on AVGO')

    expect(execution?.toolId).toBe('quant.mirofish.run')
    expect(execution?.toolName).toBe('MiroFishDebateTool')
    expect(execution?.args).toMatchObject({
      kind: 'mirofish',
      targetTicker: 'AVGO',
      submitBackend: false,
      initialView: 'workbench',
    })

    const result = await execution?.execute()
    expect(result).toMatchObject({
      kind: 'mirofish',
      payload: {
        projectId: 'preview-project',
        graphPath: '/process/preview-project',
        query: 'Run MiroFish on AVGO',
        initialView: 'workbench',
        launchContext: {
          source: 'aurora-omnibar',
          targetTicker: 'AVGO',
        },
      },
    })
  })

  it('opens MiroFish App Mode from Chinese OmniBar ticker commands', async () => {
    const commander = useAuroraCommanderStore()
    const appWindowStore = useAuroraAppWindowStore()

    await expect(commander.routeInput('推演 AVGO')).resolves.toBe(true)

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp).toEqual(getAuroraAppWindowMeta('mirofish'))
    expect(appWindowStore.activePayload).toMatchObject({
      projectId: 'preview-project',
      graphPath: '/process/preview-project',
      query: '推演 AVGO',
      initialView: 'workbench',
      launchContext: {
        source: 'aurora-omnibar',
        targetTicker: 'AVGO',
      },
    })
    expect(commander.result).toBeNull()
    expect(commander.error).toBeNull()
  })

  it('opens the Aurora Web Sandbox from URL OmniBar commands', async () => {
    const execution = ToolRegistry.findForInput('open google.com')

    expect(execution?.toolId).toBe('aurora.browser.open')
    expect(execution?.args).toMatchObject({
      kind: 'browser',
      url: 'https://google.com/',
    })

    const result = await execution?.execute()
    expect(result).toMatchObject({
      kind: 'browser',
      payload: {
        initialUrl: 'https://google.com/',
        source: 'aurora-omnibar',
      },
    })
  })

  it('opens Video Studio for video creation prompts without falling back to external apps', async () => {
    const commander = useAuroraCommanderStore()
    const appWindowStore = useAuroraAppWindowStore()
    const prompt = '請製作一支 9:16 直式搞笑短影片，時長 12 秒'
    const execution = ToolRegistry.findForInput(prompt)

    expect(execution?.toolId).toBe('aurora.videoStudio.open')
    expect(execution?.args).toMatchObject({
      kind: 'video-studio',
      initialPrompt: '製作一支 9:16 直式搞笑短影片，時長 12 秒',
    })

    await expect(commander.routeInput(prompt)).resolves.toBe(true)

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp).toEqual(getAuroraAppWindowMeta('video-studio'))
    expect(appWindowStore.activePayload).toMatchObject({
      initialPrompt: '製作一支 9:16 直式搞笑短影片，時長 12 秒',
      source: 'aurora-omnibar',
    })
    expect(commander.result).toBeNull()
    expect(commander.error).toBeNull()
  })

  it('opens the GraphRAG pipeline view for MiroFish build/preflight commands', async () => {
    const commander = useAuroraCommanderStore()
    const appWindowStore = useAuroraAppWindowStore()

    await expect(commander.routeInput('MiroFish GraphRAG pipeline AVGO')).resolves.toBe(true)

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp).toEqual(getAuroraAppWindowMeta('mirofish'))
    expect(appWindowStore.activePayload).toMatchObject({
      projectId: 'preview-project',
      graphPath: '/process/preview-project',
      query: 'MiroFish GraphRAG pipeline AVGO',
      initialView: 'pipeline',
      launchContext: {
        source: 'aurora-omnibar',
        targetTicker: 'AVGO',
      },
    })
  })

  it('keeps launcher entries scoped to valid App Mode definitions', () => {
    const uniqueLauncherKinds = new Set(AURORA_LAUNCHER_APP_KINDS)

    expect(uniqueLauncherKinds.size).toBe(AURORA_LAUNCHER_APP_KINDS.length)

    for (const kind of AURORA_LAUNCHER_APP_KINDS) {
      const launcher = AURORA_APP_CAPABILITIES[kind].launcher
      const registryEntry = getAuroraAppWindowDefinition(kind)

      expect(launcher, kind).toBeTruthy()
      expect(launcher?.kind).toBe(kind)
      expect(launcher?.label.length).toBeGreaterThan(0)
      expect(launcher?.icon.length).toBeGreaterThan(0)
      expect(launcher?.description.length).toBeGreaterThan(0)
      expect(registryEntry.kind).toBe(kind)
      expect(registryEntry.component).toBeTruthy()
    }
  })

  it('opens and closes every App Mode kind while keeping the retired console closed', () => {
    const appStore = useAppStore()
    const appWindowStore = useAuroraAppWindowStore()

    for (const kind of AURORA_APP_CAPABILITY_ORDER) {
      appStore.setAdvancedConsoleOpen(true)
      expect(appStore.isAdvancedConsoleOpen).toBe(false)

      appWindowStore.openApp(kind)

      expect(appWindowStore.isOpen).toBe(true)
      expect(appWindowStore.activeApp).toEqual(getAuroraAppWindowMeta(kind))
      expect(appStore.isAdvancedConsoleOpen, kind).toBe(false)
      expect(appStore.sidebarOpen, kind).toBe(false)

      appStore.setAdvancedConsoleOpen(true)
      expect(appStore.isAdvancedConsoleOpen).toBe(false)

      appWindowStore.closeApp()

      expect(appWindowStore.isOpen).toBe(false)
      expect(appWindowStore.activeApp).toBeNull()
      expect(appWindowStore.activePayload).toBeNull()
      expect(appStore.isAdvancedConsoleOpen, kind).toBe(false)
      expect(appStore.sidebarOpen, kind).toBe(false)
    }
  })

  it('carries optional App Mode payloads for payload-aware windows', () => {
    const appWindowStore = useAuroraAppWindowStore()
    const replayPayload = {
      replayRecord: {
        id: 'intent-replay',
        input: 'MiroFish decision audit',
      },
    }

    appWindowStore.openApp('mirofish-arena', replayPayload)

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp).toEqual(getAuroraAppWindowMeta('mirofish-arena'))
    expect(appWindowStore.activePayload).toEqual(replayPayload)

    appWindowStore.closeApp()

    expect(appWindowStore.activePayload).toBeNull()

    const graphPayload = {
      projectId: 'preview-project',
      initialUrl: 'http://localhost:3000',
    }

    appWindowStore.openApp('mirofish-graph', graphPayload)

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp).toEqual(getAuroraAppWindowMeta('mirofish-graph'))
    expect(appWindowStore.activePayload).toEqual(graphPayload)
  })
})
