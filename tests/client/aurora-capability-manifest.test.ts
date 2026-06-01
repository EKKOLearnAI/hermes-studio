// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  AURORA_APP_CAPABILITIES,
  AURORA_APP_CAPABILITY_ORDER,
  AURORA_COMMAND_CAPABILITIES,
  AURORA_DEFAULT_PINNED_APP_KINDS,
  AURORA_DESKTOP_PRESETS,
  AURORA_LAUNCHER_APP_KINDS,
  AURORA_LAUNCHER_APPS,
  getAuroraAppWindowMeta,
} from '@/services/hermes/aurora/capability-manifest'
import { AURORA_APP_WINDOW_REGISTRY } from '@/services/hermes/aurora/app-window-registry'
import { listAuroraResultPresenterToolIds } from '@/services/hermes/aurora/result-presenters'
import { ToolRegistry } from '@/services/hermes/aurora/tool-registry'

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

describe('Aurora capability manifest contract', () => {
  it('keeps every app capability wired to AppWindowRegistry metadata and component loading', () => {
    const manifestKinds = Object.keys(AURORA_APP_CAPABILITIES).sort()
    const orderedKinds = [...AURORA_APP_CAPABILITY_ORDER].sort()
    const registryKinds = Object.keys(AURORA_APP_WINDOW_REGISTRY).sort()

    expect(manifestKinds).toEqual(orderedKinds)
    expect(registryKinds).toEqual(orderedKinds)

    for (const kind of AURORA_APP_CAPABILITY_ORDER) {
      const capability = AURORA_APP_CAPABILITIES[kind]
      const registryEntry = AURORA_APP_WINDOW_REGISTRY[kind]
      const meta = getAuroraAppWindowMeta(kind)

      expect(capability.kind).toBe(kind)
      expect(capability.title.length).toBeGreaterThan(0)
      expect(capability.subtitle.length).toBeGreaterThan(0)
      expect(capability.intentPattern).toBeInstanceOf(RegExp)
      expect(meta).toEqual({
        kind,
        title: capability.title,
        subtitle: capability.subtitle,
      })
      expect(registryEntry.kind).toBe(kind)
      expect(registryEntry.title).toBe(capability.title)
      expect(registryEntry.subtitle).toBe(capability.subtitle)
      expect(registryEntry.component).toBeTruthy()
    }
  })

  it('keeps launcher apps, default pins, and desktop presets inside the manifest app universe', () => {
    const manifestKinds = new Set(AURORA_APP_CAPABILITY_ORDER)
    const launcherKinds = new Set(AURORA_LAUNCHER_APPS.map(app => app.kind))

    expect(AURORA_LAUNCHER_APPS.map(app => app.kind)).toEqual(AURORA_LAUNCHER_APP_KINDS)
    expect(launcherKinds.size).toBe(AURORA_LAUNCHER_APPS.length)

    for (const app of AURORA_LAUNCHER_APPS) {
      const launcher = AURORA_APP_CAPABILITIES[app.kind].launcher
      expect(manifestKinds.has(app.kind)).toBe(true)
      expect(launcher).toEqual(app)
    }

    for (const kind of AURORA_DEFAULT_PINNED_APP_KINDS) {
      expect(launcherKinds.has(kind)).toBe(true)
    }

    for (const preset of AURORA_DESKTOP_PRESETS) {
      expect(preset.id.length).toBeGreaterThan(0)
      expect(preset.pinnedApps.length).toBeGreaterThan(0)
      for (const kind of preset.pinnedApps) {
        expect(manifestKinds.has(kind)).toBe(true)
      }
    }
  })

  it('keeps command coverage rows linked to registered tools and valid app kinds', () => {
    const registeredToolIds = new Set(ToolRegistry.all().map(tool => tool.id))
    const manifestKinds = new Set(AURORA_APP_CAPABILITY_ORDER)
    const resolvedRows = AURORA_COMMAND_CAPABILITIES.map(row => {
      const hasTools = row.toolIds?.every(toolId => registeredToolIds.has(toolId)) ?? false
      return {
        ...row,
        status: row.status || (hasTools ? 'ready' : 'partial'),
      }
    })

    expect(resolvedRows).toHaveLength(17)
    expect(resolvedRows.filter(row => row.status === 'ready')).toHaveLength(16)
    expect(resolvedRows.filter(row => row.status === 'legacy')).toHaveLength(1)
    expect(resolvedRows.filter(row => row.status === 'partial')).toHaveLength(0)

    for (const row of AURORA_COMMAND_CAPABILITIES) {
      if (row.appKind) {
        expect(manifestKinds.has(row.appKind)).toBe(true)
      }
      for (const toolId of row.toolIds || []) {
        expect(registeredToolIds.has(toolId)).toBe(true)
      }
    }

    const hubRow = resolvedRows.find(row => row.id === 'hub')
    expect(hubRow).toMatchObject({
      label: 'Hub / Proxy',
      auroraEntry: 'Retired from Aurora surface',
      status: 'legacy',
    })
    expect(hubRow?.appKind).toBeUndefined()
    expect(hubRow?.toolIds).toBeUndefined()
  })

  it('routes manifest app intents through the legacy app opener while keeping Hub excluded', async () => {
    for (const [kind, input] of Object.entries(appIntentSamples)) {
      const execution = ToolRegistry.findForInput(input)
      const expectedToolId = kind === 'mirofish' || kind === 'mirofish-arena'
        ? 'quant.mirofish.run'
        : kind === 'mirofish-graph'
          ? 'quant.mirofish.graph.open'
          : kind === 'video-studio'
            ? 'aurora.videoStudio.open'
            : 'aurora.legacyApp.open'
      const expectedKind = kind === 'mirofish-arena' ? 'mirofish' : kind
      expect(execution?.toolId, input).toBe(expectedToolId)
      expect(execution?.args).toMatchObject({ kind: expectedKind })
    }

    expect(ToolRegistry.findForInput('open hub')).toBeNull()
    expect(ToolRegistry.findForInput('打開中轉站')).toBeNull()
  })

  it('keeps every registered Aurora tool backed by a result presenter', () => {
    const presenterToolIds = new Set(listAuroraResultPresenterToolIds())

    for (const tool of ToolRegistry.all()) {
      expect(presenterToolIds.has(tool.id), tool.id).toBe(true)
    }
  })
})
