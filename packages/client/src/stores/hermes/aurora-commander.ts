import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'
import { useAuroraGovernanceStore } from '@/stores/hermes/aurora-governance'
import {
  ToolRegistry,
  type AuroraToolExecution,
  type AuroraToolSecurityLevel,
} from '@/services/hermes/aurora/tool-registry'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import { useAuroraIntentAuditStore } from '@/stores/hermes/aurora-intent-audit'
import { useAuroraWorkingMemoryStore } from '@/stores/hermes/working-memory'
import {
  formatAuroraResult,
  type AuroraResult,
  type AuroraResultWidgetAppAction,
} from '@/services/hermes/aurora/result-presenters'
import { parseTickerFocusIntent } from '@/services/hermes/aurora/intent-parsers'
import { auroraEventBus } from '@/services/hermes/aurora/aurora-event-bus'

export interface AuroraPendingApproval {
  id: string
  title: string
  toolName: string
  securityLevel: AuroraToolSecurityLevel
  summary: string
  argsJson: string
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMiroFishInitialView(value: unknown): value is 'graph' | 'pipeline' | 'workbench' {
  return value === 'graph' || value === 'pipeline' || value === 'workbench'
}

export const useAuroraCommanderStore = defineStore('aurora-commander', () => {
  const isRunning = ref(false)
  const result = ref<AuroraResult | null>(null)
  const pendingApproval = ref<AuroraPendingApproval | null>(null)
  const error = ref<string | null>(null)
  const isVisible = computed(() => Boolean(result.value || pendingApproval.value || error.value || isRunning.value))

  let governanceApprovalId = ''
  let pendingExecution: AuroraToolExecution | null = null
  let pendingInput = ''
  let activeRunId = 0

  function governanceContextKey(approvalId: string): string {
    return `aurora-commander:${approvalId}`
  }

  function cancelGovernanceApproval(approvalId = governanceApprovalId) {
    if (!approvalId) return
    useAuroraGovernanceStore().cancelConfirmation(governanceContextKey(approvalId))
  }

  function clear() {
    const approvalId = governanceApprovalId
    activeRunId += 1
    isRunning.value = false
    result.value = null
    pendingApproval.value = null
    error.value = null
    governanceApprovalId = ''
    pendingExecution = null
    pendingInput = ''
    cancelGovernanceApproval(approvalId)
  }

  function clearPassiveResult() {
    if (isRunning.value || pendingApproval.value) return
    result.value = null
    error.value = null
  }

  function requestGovernanceForPending(approvalId: string) {
    const approval = pendingApproval.value
    if (!approval || governanceApprovalId === approvalId) return
    governanceApprovalId = approvalId

    void useAuroraGovernanceStore().requestConfirmation({
      title: approval.title,
      description: approval.securityLevel === 'L4_Locked'
        ? 'Aurora paused a locked tool call. Review the exact payload before allowing it to continue.'
        : 'Aurora wants to bridge into a write-capable legacy module. Review the payload before allowing it to continue.',
      details: approval.argsJson,
      confirmLabel: 'Approve',
      cancelLabel: 'Reject',
      source: `${approval.toolName} Approval`,
      contextKey: governanceContextKey(approvalId),
      auditInput: pendingInput || approval.summary,
      toolId: pendingExecution?.toolId,
      toolName: pendingExecution?.toolName || approval.toolName,
      securityLevel: pendingExecution?.securityLevel || approval.securityLevel,
      payload: {
        args: pendingExecution?.args || {},
        approval,
      },
    }).then((approved) => {
      if (pendingApproval.value?.id !== approvalId) return
      governanceApprovalId = ''
      if (approved) {
        void approvePending()
      } else {
        rejectPending()
      }
    })
  }

  function normalizeMiroFishAppLaunch(app: AuroraResultWidgetAppAction | undefined, input: string, tool: AuroraToolExecution): AuroraResultWidgetAppAction | null {
    if (tool.toolId !== 'quant.mirofish.run') return app || null

    const args = isRecord(tool.args) ? tool.args : {}
    const existingPayload = isRecord(app?.payload) ? app.payload : {}
    const existingLaunchContext = isRecord(existingPayload.launchContext) ? existingPayload.launchContext : {}
    const targetTicker = typeof args.targetTicker === 'string'
      ? args.targetTicker.trim().toUpperCase()
      : typeof existingLaunchContext.targetTicker === 'string'
        ? existingLaunchContext.targetTicker.trim().toUpperCase()
        : ''
    const topic = typeof args.topic === 'string'
      ? args.topic.trim()
      : typeof existingLaunchContext.topic === 'string'
        ? existingLaunchContext.topic.trim()
        : ''
    const initialView = isMiroFishInitialView(args.initialView)
      ? args.initialView
      : isMiroFishInitialView(existingPayload.initialView)
        ? existingPayload.initialView
        : 'workbench'

    const forceArena = /\bsimulat(?:e|ion)\b|\brisk\b|風險推演|风险推演|情境推演|情景推演/i.test(input)

    return {
      kind: app?.kind === 'mirofish' && forceArena ? 'mirofish-arena' : app?.kind || 'mirofish-arena',
      label: app?.label || 'Open App',
      payload: {
        projectId: 'preview-project',
        graphPath: '/process/preview-project',
        ...existingPayload,
        query: typeof existingPayload.query === 'string' ? existingPayload.query : input,
        initialView,
        launchContext: {
          source: 'aurora-omnibar',
          ...existingLaunchContext,
          ...(targetTicker ? { targetTicker } : {}),
          ...(topic ? { topic } : {}),
        },
      },
    }
  }

  function openAppModeIfNeeded(nextResult: AuroraResult, input: string, tool: AuroraToolExecution): boolean {
    const app = normalizeMiroFishAppLaunch(nextResult.widget?.app, input, tool)
    if (!app) return false
    useAuroraAppWindowStore().openApp(app.kind, app.payload || null)
    useAuroraIntentAuditStore().record({
      input,
      status: 'app_opened',
      toolId: tool.toolId,
      toolName: tool.toolName,
      securityLevel: tool.securityLevel,
      appKind: app.kind,
      summary: nextResult.summary,
      payload: {
        args: tool.args,
        app,
        result: {
          title: nextResult.title,
          subtitle: nextResult.subtitle,
          summary: nextResult.summary,
        },
      },
    })
    result.value = null
    error.value = null
    return true
  }

  async function routeInput(input: string): Promise<boolean> {
    const workingMemoryStore = useAuroraWorkingMemoryStore()
    const enrichedInput = workingMemoryStore.enrichPrompt(input)
    const tickerFocus = parseTickerFocusIntent(input)
    if (tickerFocus) {
      auroraEventBus.emit('TICKER_FOCUSED', {
        symbol: tickerFocus.symbol,
        rawSymbol: tickerFocus.rawSymbol,
        source: 'aurora-commander',
        input,
        focusedAt: new Date().toISOString(),
      })
    }
    const tool = ToolRegistry.findForInput(input)
    if (!tool) {
      useAuroraIntentAuditStore().record({
        input: enrichedInput,
        status: 'fallback',
        summary: 'No Aurora tool matched. Falling back to Hermes chat stream.',
        payload: {
          fallback: 'hermes-chat-stream',
          workingMemory: workingMemoryStore.contextSummary || undefined,
        },
      })
      return false
    }

    result.value = null
    error.value = null

    if (tool.securityLevel === 'L3_Approval' || tool.securityLevel === 'L4_Locked') {
      cancelGovernanceApproval()
      governanceApprovalId = ''
      pendingExecution = tool
      pendingInput = input
      pendingApproval.value = {
        id: makeId('approval'),
        title: `${tool.toolName} requires approval`,
        toolName: tool.toolName,
        securityLevel: tool.securityLevel,
        summary: 'Aurora wants to bridge into a legacy write-capable module.',
        argsJson: JSON.stringify(tool.args, null, 2),
      }
      useAuroraIntentAuditStore().record({
        input,
        status: 'approval_required',
        toolId: tool.toolId,
        toolName: tool.toolName,
        securityLevel: tool.securityLevel,
        summary: 'Tool paused for human approval.',
        payload: {
          args: tool.args,
          workingMemory: workingMemoryStore.contextSummary || undefined,
          approval: pendingApproval.value,
        },
      })
      requestGovernanceForPending(pendingApproval.value.id)
      return true
    }

    const runId = activeRunId + 1
    activeRunId = runId
    isRunning.value = true
    try {
      const payload = await tool.execute()
      if (runId !== activeRunId) return true
      const nextResult = formatAuroraResult(payload, tool)
      if (!openAppModeIfNeeded(nextResult, input, tool)) {
        result.value = nextResult
        useAuroraIntentAuditStore().record({
          input,
          status: 'completed',
          toolId: tool.toolId,
          toolName: tool.toolName,
          securityLevel: tool.securityLevel,
          summary: nextResult.summary,
          payload: {
            args: tool.args,
            result: {
              title: nextResult.title,
              subtitle: nextResult.subtitle,
              summary: nextResult.summary,
              widgetType: nextResult.widget?.type,
            },
          },
        })
      }
    } catch (err: any) {
      if (runId !== activeRunId) return true
      error.value = err?.message || 'Aurora legacy tool failed.'
      useAuroraIntentAuditStore().record({
        input,
        status: 'failed',
        toolId: tool.toolId,
        toolName: tool.toolName,
        securityLevel: tool.securityLevel,
        summary: error.value || 'Aurora legacy tool failed.',
        payload: {
          args: tool.args,
          error: error.value || 'Aurora legacy tool failed.',
        },
      })
    } finally {
      if (runId === activeRunId) {
        isRunning.value = false
      }
    }
    return true
  }

  async function approvePending() {
    if (!pendingExecution) return
    const tool = pendingExecution
    const input = pendingInput || JSON.stringify(tool.args)
    pendingApproval.value = null
    governanceApprovalId = ''
    const runId = activeRunId + 1
    activeRunId = runId
    isRunning.value = true
    error.value = null

    try {
      const payload = await tool.execute()
      if (runId !== activeRunId) return
      const nextResult = formatAuroraResult(payload, tool)
      if (!openAppModeIfNeeded(nextResult, input, tool)) {
        result.value = nextResult
        useAuroraIntentAuditStore().record({
          input,
          status: 'completed',
          toolId: tool.toolId,
          toolName: tool.toolName,
          securityLevel: tool.securityLevel,
          summary: nextResult.summary,
          payload: {
            args: tool.args,
            approvalDecision: 'approved',
            result: {
              title: nextResult.title,
              subtitle: nextResult.subtitle,
              summary: nextResult.summary,
              widgetType: nextResult.widget?.type,
            },
          },
        })
      }
    } catch (err: any) {
      if (runId !== activeRunId) return
      error.value = err?.message || 'Aurora legacy tool failed.'
      useAuroraIntentAuditStore().record({
        input,
        status: 'failed',
        toolId: tool.toolId,
        toolName: tool.toolName,
        securityLevel: tool.securityLevel,
        summary: error.value || 'Aurora legacy tool failed.',
        payload: {
          args: tool.args,
          approvalDecision: 'approved',
          error: error.value || 'Aurora legacy tool failed.',
        },
      })
    } finally {
      if (runId === activeRunId) {
        isRunning.value = false
        pendingExecution = null
        pendingInput = ''
      }
    }
  }

  function rejectPending() {
    const tool = pendingExecution
    const input = pendingInput || ''
    pendingApproval.value = null
    governanceApprovalId = ''
    pendingExecution = null
    pendingInput = ''
    useChatStore().injectSystemMessage('System: Tool execution rejected by user.', {
      commandAction: 'aurora.tool.rejected',
      commandData: {
        args: tool?.args || {},
        securityLevel: tool?.securityLevel || 'L3_Approval',
        toolName: tool?.toolName || 'Tool',
      },
    })
    result.value = {
      id: makeId('rejected'),
      title: 'Tool Rejected',
      subtitle: 'Aurora Commander',
      toolName: tool?.toolName || 'Tool',
      securityLevel: tool?.securityLevel || 'L3_Approval',
      summary: 'System: Tool execution rejected by user.',
      sections: [],
      rawJson: JSON.stringify({ ok: false, reason: 'System: Tool execution rejected by user.' }, null, 2),
    }
    useAuroraIntentAuditStore().record({
      input,
      status: 'rejected',
      toolId: tool?.toolId,
      toolName: tool?.toolName,
      securityLevel: tool?.securityLevel || 'L3_Approval',
      summary: 'System: Tool execution rejected by user.',
      payload: {
        args: tool?.args,
        approvalDecision: 'rejected',
      },
    })
  }

  return {
    isRunning,
    isVisible,
    result,
    pendingApproval,
    error,
    routeInput,
    approvePending,
    rejectPending,
    clear,
    clearPassiveResult,
  }
})
