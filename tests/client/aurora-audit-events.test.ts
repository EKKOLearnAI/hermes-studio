// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/aurora/intent-audit', () => ({
  writeAuroraIntentAuditRecord: vi.fn(async record => ({ ok: true, record, count: 1 })),
  fetchAuroraIntentAudit: vi.fn(async () => ({
    generatedAt: '2026-05-28T12:00:00.000Z',
    storage: 'server',
    records: [],
  })),
  clearAuroraIntentAudit: vi.fn(async () => ({ ok: true, count: 0 })),
}))

import { useAuroraCommanderStore } from '@/stores/hermes/aurora-commander'
import { useAuroraGovernanceStore } from '@/stores/hermes/aurora-governance'
import { useAuroraIntentAuditStore } from '@/stores/hermes/aurora-intent-audit'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import { useMemoryQueueStore } from '@/stores/hermes/memory-queue'
import { useChatStore } from '@/stores/hermes/chat'

async function flushPromises() {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

function recordsByInput(input: string) {
  return useAuroraIntentAuditStore().records.filter(record => record.input === input)
}

describe('Aurora audit events', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  it('records Hermes fallback when no Aurora tool matches', async () => {
    const commander = useAuroraCommanderStore()

    await expect(commander.routeInput('hello ordinary Hermes chat')).resolves.toBe(false)

    expect(recordsByInput('hello ordinary Hermes chat')).toEqual([
      expect.objectContaining({
        status: 'fallback',
        summary: 'No Aurora tool matched. Falling back to Hermes chat stream.',
        payload: { fallback: 'hermes-chat-stream' },
      }),
    ])
  })

  it('records App Mode launches and keeps the app window state traceable', async () => {
    const commander = useAuroraCommanderStore()
    const appWindowStore = useAuroraAppWindowStore()

    await expect(commander.routeInput('open Quant Lab')).resolves.toBe(true)

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp?.kind).toBe('quant-lab')
    expect(recordsByInput('open Quant Lab')).toEqual([
      expect.objectContaining({
        status: 'app_opened',
        toolId: 'aurora.legacyApp.open',
        toolName: 'OpenHermesAppTool',
        securityLevel: 'L1_ReadOnly',
        appKind: 'quant-lab',
        payload: expect.objectContaining({
          app: expect.objectContaining({ kind: 'quant-lab', label: 'Open App' }),
        }),
      }),
    ])
  })

  it('passes MiroFish Graph App payloads into App Mode launches', async () => {
    const commander = useAuroraCommanderStore()
    const appWindowStore = useAuroraAppWindowStore()

    await expect(commander.routeInput('open MiroFish graph')).resolves.toBe(true)

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp?.kind).toBe('mirofish-graph')
    expect(appWindowStore.activePayload).toMatchObject({
      projectId: 'preview-project',
    })
    expect(recordsByInput('open MiroFish graph')).toEqual([
      expect.objectContaining({
        status: 'app_opened',
        toolId: 'quant.mirofish.graph.open',
        toolName: 'OpenMiroFishGraphTool',
        securityLevel: 'L1_ReadOnly',
        appKind: 'mirofish-graph',
        payload: expect.objectContaining({
          app: expect.objectContaining({
            kind: 'mirofish-graph',
            payload: expect.objectContaining({ projectId: 'preview-project' }),
          }),
        }),
      }),
    ])
  })

  it('opens the merged MiroFish app from OmniBar ticker intents without showing raw results', async () => {
    const commander = useAuroraCommanderStore()
    const appWindowStore = useAuroraAppWindowStore()

    await expect(commander.routeInput('Run MiroFish on AVGO')).resolves.toBe(true)

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp?.kind).toBe('mirofish')
    expect(appWindowStore.activePayload).toMatchObject({
      projectId: 'preview-project',
      graphPath: '/process/preview-project',
      launchContext: {
        source: 'aurora-omnibar',
        targetTicker: 'AVGO',
      },
    })
    expect(commander.result).toBeNull()
    expect(recordsByInput('Run MiroFish on AVGO')).toEqual([
      expect.objectContaining({
        status: 'app_opened',
        toolId: 'quant.mirofish.run',
        toolName: 'MiroFishDebateTool',
        securityLevel: 'L1_ReadOnly',
        appKind: 'mirofish',
        payload: expect.objectContaining({
          app: expect.objectContaining({
            kind: 'mirofish',
            payload: expect.objectContaining({
              projectId: 'preview-project',
              graphPath: '/process/preview-project',
              launchContext: expect.objectContaining({ targetTicker: 'AVGO' }),
            }),
          }),
        }),
      }),
    ])
  })

  it('records generated widget loads as completed structured widget results', async () => {
    const commander = useAuroraCommanderStore()

    await expect(commander.routeInput('open PomodoroGlassWidget')).resolves.toBe(true)

    expect(commander.result?.widget?.type).toBe('generated-widget')
    expect(recordsByInput('open PomodoroGlassWidget')).toEqual([
      expect.objectContaining({
        status: 'completed',
        toolId: 'aurora.generatedWidget.load',
        toolName: 'LoadGeneratedWidgetTool',
        securityLevel: 'L1_ReadOnly',
        payload: expect.objectContaining({
          result: expect.objectContaining({
            widgetType: 'generated-widget',
          }),
        }),
      }),
    ])
  })

  it('updates existing audit records without creating duplicate events', async () => {
    const auditStore = useAuroraIntentAuditStore()
    const record = auditStore.record({
      input: 'MiroFish decision audit: BUY NVDA vs archive',
      status: 'completed',
      toolId: 'quant.mirofish.run',
      toolName: 'RunMiroFishTool',
      payload: {
        source: 'mirofish-current-archive-compare',
      },
    })

    const updated = auditStore.updateRecord(record.id, existing => ({
      ...existing,
      payload: {
        ...(existing.payload || {}),
        baselineDrift: {
          score: 42,
          label: 'Medium',
          contributions: [
            { label: 'Action', points: 24 },
          ],
        },
      },
    }))

    expect(updated).toMatchObject({
      id: record.id,
      timestamp: record.timestamp,
      payload: expect.objectContaining({
        source: 'mirofish-current-archive-compare',
        baselineDrift: expect.objectContaining({
          score: 42,
          label: 'Medium',
        }),
      }),
    })
    expect(auditStore.records).toHaveLength(1)
  })

  it('records memory proposals without writing long-term memory directly', async () => {
    const commander = useAuroraCommanderStore()
    const memoryQueueStore = useMemoryQueueStore()

    await expect(commander.routeInput('remember that Aurora audit events need coverage')).resolves.toBe(true)

    expect(memoryQueueStore.pendingMemories).toHaveLength(1)
    expect(memoryQueueStore.pendingMemories[0]).toMatchObject({
      content: 'Aurora audit events need coverage',
      source: 'Chat Interaction',
      status: 'pending',
    })
    expect(recordsByInput('remember that Aurora audit events need coverage')).toEqual([
      expect.objectContaining({
        status: 'completed',
        toolId: 'aurora.memory.propose',
        toolName: 'ProposeMemoryTool',
        securityLevel: 'L2_Draft',
        summary: 'Aurora drafted a memory candidate for human review. No long-term memory was written.',
      }),
    ])
  })

  it('records approval required, queued, rejected, and context injection for denied tools', async () => {
    const commander = useAuroraCommanderStore()
    const governanceStore = useAuroraGovernanceStore()
    const chatStore = useChatStore()
    const input = 'create task Audit rejection coverage'

    await expect(commander.routeInput(input)).resolves.toBe(true)

    expect(commander.pendingApproval).toMatchObject({
      toolName: 'CreateTaskTool',
      securityLevel: 'L3_Approval',
    })
    expect(governanceStore.activeConfirmation).toMatchObject({
      toolId: 'legacy.kanban.createTask',
      toolName: 'CreateTaskTool',
      securityLevel: 'L3_Approval',
    })

    governanceStore.cancelActive()
    await flushPromises()

    const statuses = recordsByInput(input).map(record => record.status)
    expect(statuses).toEqual(expect.arrayContaining([
      'approval_required',
      'approval_queued',
      'approval_rejected',
      'rejected',
    ]))
    expect(recordsByInput(input).find(record => record.status === 'approval_required')).toMatchObject({
      toolId: 'legacy.kanban.createTask',
      toolName: 'CreateTaskTool',
      securityLevel: 'L3_Approval',
    })
    expect(recordsByInput(input).find(record => record.status === 'rejected')).toMatchObject({
      summary: 'System: Tool execution rejected by user.',
      payload: expect.objectContaining({
        approvalDecision: 'rejected',
      }),
    })
    expect(chatStore.activeSession?.messages.some(message =>
      message.role === 'system' &&
      message.content === 'System: Tool execution rejected by user.' &&
      message.commandAction === 'aurora.tool.rejected',
    )).toBe(true)
  })
})
