import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  CodingAgentRunManager,
  codexExecTurnArgs,
  groupChatClaudePrintArgs,
  groupChatCodexExecSafetyArgs,
} from '../../packages/server/src/services/agent-runner/coding-agent-run-manager'

describe('CodingAgentRunManager external event subscriptions', () => {
  it('uses explicit unattended safe-mode flags for group-chat coding agents', () => {
    expect(groupChatCodexExecSafetyArgs('group_chat')).toEqual([
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'approval_policy="never"',
    ])
    expect(groupChatCodexExecSafetyArgs(undefined)).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ])

    const args = groupChatClaudePrintArgs('group_chat', [
      '--settings',
      '/tmp/settings.json',
      '--mcp-config',
      '/tmp/mcp.json',
      '--append-system-prompt-file',
      '/tmp/hermes-rules.md',
      '--dangerously-skip-permissions',
      '--model',
      'claude-test',
    ])
    expect(args).toEqual([
      '--permission-mode',
      'dontAsk',
      '--settings',
      '/tmp/settings.json',
      '--mcp-config',
      '/tmp/mcp.json',
      '--model',
      'claude-test',
    ])
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--append-system-prompt-file')
    expect(args).not.toContain('/tmp/hermes-rules.md')

    const ordinaryArgs = [
      '--settings',
      '/tmp/settings.json',
      '--append-system-prompt-file',
      '/tmp/hermes-rules.md',
    ]
    expect(groupChatClaudePrintArgs(undefined, ordinaryArgs)).toEqual(ordinaryArgs)
  })

  it('does not reuse a coding-agent run across ordinary and Group Chat runtime contexts', () => {
    const manager = new CodingAgentRunManager()
    const sessionId = 'shared-claude-session'
    const ordinaryRun: any = {
      id: 'ordinary-claude-run',
      launch: {
        agentId: 'claude-code',
        agentSessionId: 'ordinary-claude-run',
        agentNativeSessionId: 'native-ordinary',
        sessionId,
        mode: 'scoped',
        provider: 'provider',
        model: 'claude-test',
        apiMode: 'anthropic_messages',
        reasoningEffort: '',
        runtimeContext: undefined,
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      exited: false,
    }
    ;(manager as any).runs.set(ordinaryRun.id, ordinaryRun)
    ;(manager as any).sessionIndex.set(sessionId, ordinaryRun.id)
    ;(manager as any).managedMcpConfigIsCurrent = vi.fn(() => true)

    const common = {
      agentId: 'claude-code',
      mode: 'scoped' as const,
      provider: 'provider',
      model: 'claude-test',
      apiMode: 'anthropic_messages' as const,
      reasoningEffort: '',
    }
    expect(manager.isSessionLaunchCompatible(sessionId, common)).toBe(true)
    expect(manager.isSessionLaunchCompatible(sessionId, { ...common, agentSessionId: 'stale-run' })).toBe(false)
    expect(manager.isSessionLaunchCompatible(sessionId, { ...common, agentSessionId: 'ordinary-claude-run' })).toBe(true)
    expect(manager.isSessionLaunchCompatible(sessionId, { ...common, agentNativeSessionId: 'stale-native' })).toBe(false)
    expect(manager.isSessionLaunchCompatible(sessionId, { ...common, agentNativeSessionId: 'native-ordinary' })).toBe(true)
    expect(manager.isSessionLaunchCompatible(sessionId, { ...common, runtimeContext: 'group_chat' })).toBe(false)

    ordinaryRun.launch.runtimeContext = 'group_chat'
    expect(manager.isSessionLaunchCompatible(sessionId, { ...common, runtimeContext: 'group_chat' })).toBe(true)
    expect(manager.isSessionLaunchCompatible(sessionId, common)).toBe(false)
    manager.shutdown()
  })

  it('uses resume-compatible sandbox configuration on both initial and resumed Codex turns', () => {
    const commonArgs = ['--json', ...groupChatCodexExecSafetyArgs('group_chat')]
    const initial = codexExecTurnArgs(commonArgs, '/tmp/workspace', 'first')
    const resumed = codexExecTurnArgs(commonArgs, '/tmp/workspace', 'second', 'native-session', true)

    expect(initial).toEqual([
      'exec', '--json', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"',
      '--cd', '/tmp/workspace', 'first',
    ])
    expect(resumed).toEqual([
      'exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"',
      'native-session', 'second',
    ])
    expect(resumed).not.toContain('--sandbox')
  })

  it('publishes normalized events only to listeners for the matching session', () => {
    const manager = new CodingAgentRunManager()
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = manager.subscribe('session-1', first)
    manager.subscribe('session-2', second)

    ;(manager as any).emitToChat('session-1', 'message.delta', { delta: 'hello' })

    expect(first).toHaveBeenCalledWith('message.delta', { delta: 'hello' })
    expect(second).not.toHaveBeenCalled()

    unsubscribe()
    ;(manager as any).emitToChat('session-1', 'run.completed', { output: 'done' })
    expect(first).toHaveBeenCalledTimes(1)
    manager.shutdown()
  })

  it('fences listeners with the token captured when the event was produced', () => {
    const manager = new CodingAgentRunManager()
    const listener = vi.fn()
    manager.subscribe('session-fenced', listener, 'turn-2')

    ;(manager as any).emitToChat('session-fenced', 'message.delta', { delta: 'late turn one' }, 'turn-1')
    ;(manager as any).emitToChat('session-fenced', 'message.delta', { delta: 'current turn two' }, 'turn-2')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: 'current turn two',
      event_token: 'turn-2',
    }))
    manager.shutdown()
  })

  it('rejects overlapping input before rotating the active event token', () => {
    const manager = new CodingAgentRunManager()
    const currentChild = {
      exitCode: null,
      signalCode: null,
      killed: false,
    } as any
    const run = {
      id: 'runner-overlap',
      launch: {
        agentId: 'codex',
        sessionId: 'session-overlap',
      },
      state: { messages: [], isWorking: true, events: [], queue: [] },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      exited: false,
      currentChild,
      activeEventToken: 'turn-1',
      pendingChatCompletionEvent: 'run.completed',
    }
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)

    expect(() => manager.send(run.launch.sessionId, 'second input', { eventToken: 'turn-2' } as any))
      .toThrow('Codex is still processing the previous input')
    expect(run.activeEventToken).toBe('turn-1')
    expect(run.pendingChatCompletionEvent).toBe('run.completed')
    manager.shutdown()
  })

  it('rejects a new input until terminal finalization has settled', async () => {
    const manager = new CodingAgentRunManager()
    let resolveUsage!: () => void
    const usageRefresh = new Promise<void>((resolve) => { resolveUsage = resolve })
    const run = {
      id: 'runner-finalizing',
      launch: {
        agentId: 'codex',
        sessionId: 'session-finalizing',
      },
      state: { messages: [], isWorking: true, events: [], queue: [] },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      exited: false,
      activeEventToken: 'turn-1',
      turnFenceInitialized: true,
      terminalEventHandled: true,
      terminalUsageRefresh: usageRefresh,
      pendingChatCompletionEvent: 'run.completed',
    }
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)
    ;(manager as any).ensureDbSession = vi.fn()
    ;(manager as any).addUserMessage = vi.fn()
    ;(manager as any).touch = vi.fn()
    ;(manager as any).emitTerminalStatus = vi.fn()
    ;(manager as any).startWorkspaceRunDiff = vi.fn()
    ;(manager as any).startCodexExecTurn = vi.fn()
    ;(manager as any).emitAndMarkPrintChatRunCompleted = vi.fn()
    const listener = vi.fn()
    manager.subscribe(run.launch.sessionId, listener, 'turn-1')

    const finalizing = (manager as any).emitAndMarkPrintChatRunCompletedAfterUsage(
      run,
      'run.completed',
      { output: 'first turn' },
      'turn-1',
    )
    await (manager as any).emitAndMarkPrintChatRunCompletedAfterUsage(
      run,
      'run.completed',
      { output: 'duplicate completion' },
      'turn-1',
    )
    expect((manager as any).emitAndMarkPrintChatRunCompleted).not.toHaveBeenCalled()

    expect(() => manager.send(run.launch.sessionId, 'second input', { eventToken: 'turn-2' } as any))
      .toThrow('Codex is still processing the previous input')
    expect(manager.isSessionProcessing(run.launch.sessionId)).toBe(true)
    expect(run.activeEventToken).toBe('turn-1')
    manager.handleResponseEvent(run.id, {
      type: 'response.output_text.delta',
      data: { delta: 'late after terminal event' },
    }, 'turn-1')
    expect(listener).not.toHaveBeenCalled()

    resolveUsage()
    await finalizing

    expect(manager.isSessionProcessing(run.launch.sessionId)).toBe(false)
    manager.handleResponseEvent(run.id, {
      type: 'response.output_text.delta',
      data: { delta: 'late after completion' },
    }, 'turn-1')
    expect(listener).not.toHaveBeenCalled()
    expect(() => manager.send(run.launch.sessionId, 'second input', { eventToken: 'turn-2' } as any))
      .not.toThrow()
    expect(run.activeEventToken).toBe('turn-2')
    manager.shutdown()
  })

  it('abandons terminal finalization after the run incarnation is replaced', async () => {
    const manager = new CodingAgentRunManager()
    let resolveUsage!: () => void
    const usageRefresh = new Promise<void>((resolve) => { resolveUsage = resolve })
    const oldRun = {
      id: 'runner-finalizer-replaced',
      incarnationToken: 'incarnation-old',
      launch: { agentId: 'codex', sessionId: 'session-finalizer-replaced' },
      state: { messages: [], isWorking: true, events: [], queue: [] },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      exited: false,
      activeEventToken: 'turn-old',
      terminalUsageRefresh: usageRefresh,
    }
    ;(manager as any).runs.set(oldRun.id, oldRun)
    ;(manager as any).sessionIndex.set(oldRun.launch.sessionId, oldRun.id)
    ;(manager as any).emitAndMarkPrintChatRunCompleted = vi.fn()

    const finalizing = (manager as any).emitAndMarkPrintChatRunCompletedAfterUsage(
      oldRun,
      'run.completed',
      { output: 'old output' },
      'turn-old',
    )
    const replacement = {
      ...oldRun,
      incarnationToken: 'incarnation-new',
      activeEventToken: 'turn-new',
      terminalUsageRefresh: undefined,
      terminalFinalizationEventToken: undefined,
    }
    ;(manager as any).runs.set(replacement.id, replacement)
    ;(manager as any).sessionIndex.set(replacement.launch.sessionId, replacement.id)

    resolveUsage()
    await finalizing

    expect((manager as any).emitAndMarkPrintChatRunCompleted).not.toHaveBeenCalled()
    manager.shutdown()
  })

  it('generates a unique event fence for ordinary coding-agent turns', () => {
    const manager = new CodingAgentRunManager()
    const run = {
      id: 'runner-generated-token',
      launch: {
        agentId: 'codex',
        sessionId: 'session-generated-token',
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      exited: false,
      activeEventToken: undefined as string | undefined,
    }
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)
    ;(manager as any).ensureDbSession = vi.fn()
    ;(manager as any).addUserMessage = vi.fn()
    ;(manager as any).touch = vi.fn()
    ;(manager as any).emitTerminalStatus = vi.fn()
    ;(manager as any).startWorkspaceRunDiff = vi.fn()
    ;(manager as any).startCodexExecTurn = vi.fn()

    manager.send(run.launch.sessionId, 'first input')
    const firstToken = run.activeEventToken
    manager.send(run.launch.sessionId, 'second input')
    const secondToken = run.activeEventToken

    expect(firstToken).toEqual(expect.any(String))
    expect(secondToken).toEqual(expect.any(String))
    expect(secondToken).not.toBe(firstToken)
    manager.shutdown()
  })

  it('drops stale response events before they mutate the active turn', () => {
    const manager = new CodingAgentRunManager()
    const listener = vi.fn()
    const run = {
      id: 'runner-stale-event',
      launch: {
        agentId: 'codex',
        mode: 'scoped',
        profile: 'default',
        provider: 'openai',
        model: 'gpt-test',
        sessionId: 'session-stale-event',
      },
      state: { messages: [], isWorking: true, events: [], queue: [] },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      exited: false,
      activeEventToken: 'turn-2',
      turnFenceInitialized: true,
    }
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)
    manager.subscribe(run.launch.sessionId, listener, 'turn-2')

    manager.handleResponseEvent(run.id, {
      type: 'response.output_text.delta',
      data: { delta: 'late turn one' },
    }, 'turn-1')

    expect(listener).not.toHaveBeenCalled()
    expect(run.state.messages).toEqual([])
    manager.shutdown()
  })

  it('rejects delayed proxy events from a replaced run incarnation', () => {
    const manager = new CodingAgentRunManager()
    const listener = vi.fn()
    const replacement = {
      id: 'runner-reused-id',
      incarnationToken: 'incarnation-new',
      launch: {
        agentId: 'codex',
        mode: 'scoped',
        profile: 'default',
        provider: 'openai',
        model: 'gpt-test',
        sessionId: 'session-reused-id',
      },
      state: { messages: [], isWorking: true, events: [], queue: [] },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      exited: false,
      activeEventToken: 'same-explicit-token',
      turnFenceInitialized: true,
    }
    ;(manager as any).runs.set(replacement.id, replacement)
    ;(manager as any).sessionIndex.set(replacement.launch.sessionId, replacement.id)
    manager.subscribe(replacement.launch.sessionId, listener, 'same-explicit-token')

    manager.handleResponseEvent(replacement.id, {
      type: 'response.output_text.delta',
      data: { delta: 'late output from replaced run' },
    }, 'same-explicit-token', 'incarnation-old')
    manager.handleResponseEvent(replacement.id, {
      type: 'response.output_text.delta',
      data: { delta: 'event without a run incarnation' },
    }, 'same-explicit-token')

    expect(listener).not.toHaveBeenCalled()
    expect(replacement.state.messages).toEqual([])
    manager.shutdown()
  })

  it('rejects child callbacks from a detached run incarnation', () => {
    const manager = new CodingAgentRunManager()
    const child = { pid: 11 } as any
    const oldRun = {
      id: 'runner-child-reused',
      incarnationToken: 'incarnation-old',
      launch: { sessionId: 'session-child-reused' },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      exited: true,
      currentChild: child,
      activeEventToken: 'same-token',
    }
    const replacement = {
      ...oldRun,
      incarnationToken: 'incarnation-new',
      currentChild: { pid: 12 } as any,
    }
    ;(manager as any).runs.set(replacement.id, replacement)
    ;(manager as any).sessionIndex.set(replacement.launch.sessionId, replacement.id)

    expect((manager as any).isCurrentChildTurn(oldRun, child, 'same-token')).toBe(false)
    expect((manager as any).isCurrentChildTurn(replacement, replacement.currentChild, 'same-token')).toBe(true)
    manager.shutdown()
  })

  it('preserves the active turn token on a reported session-close event', () => {
    const manager = new CodingAgentRunManager()
    const listener = vi.fn()
    const run = {
      id: 'runner-close-token',
      launch: { sessionId: 'session-close-token' },
      state: { messages: [], isWorking: true, events: [], queue: [] },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      exited: false,
      activeEventToken: 'turn-close',
    }
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)
    manager.subscribe(run.launch.sessionId, listener, 'turn-close')

    ;(manager as any).cleanupRun(run, { kill: false })

    expect(listener).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      error: 'Coding agent session closed',
      event_token: 'turn-close',
    }))
  })

  it('isolates listener failures from the coding-agent run', () => {
    const manager = new CodingAgentRunManager()
    const healthy = vi.fn()
    manager.subscribe('session-1', () => { throw new Error('observer failed') })
    manager.subscribe('session-1', healthy)

    expect(() => {
      ;(manager as any).emitToChat('session-1', 'run.completed', { output: 'done' })
    }).not.toThrow()
    expect(healthy).toHaveBeenCalledWith('run.completed', { output: 'done' })
    manager.shutdown()
  })

  it('honors the requested graceful-stop window before force killing a child', async () => {
    vi.useFakeTimers()
    try {
      const manager = new CodingAgentRunManager()
      const child = new EventEmitter() as EventEmitter & {
        pid: number
        exitCode: number | null
        signalCode: NodeJS.Signals | null
        killed: boolean
      }
      Object.assign(child, {
        pid: 4242,
        exitCode: null,
        signalCode: null,
        killed: false,
      })
      const run = {
        id: 'run-1',
        launch: { sessionId: 'session-1' },
        state: { isWorking: true },
        startedAt: Date.now(),
        lastActiveAt: Date.now(),
        exited: false,
        currentChild: child,
      }
      ;(manager as any).runs.set(run.id, run)
      ;(manager as any).sessionIndex.set('session-1', run.id)
      ;(manager as any).cleanupRun = vi.fn((managedRun: any) => {
        managedRun.stoppedByUser = true
        managedRun.state.isWorking = false
      })

      const stopping = manager.stopAndWait('session-1', { reportClosed: false, graceMs: 15_000 })
      await vi.advanceTimersByTimeAsync(1_500)
      expect((manager as any).cleanupRun).not.toHaveBeenCalled()
      expect(manager.runIdForSession('session-1')).toBe(run.id)
      expect(child.killed).toBe(false)

      child.exitCode = 0
      child.emit('exit', 0)
      await expect(stopping).resolves.toBe(true)
      expect((manager as any).cleanupRun).toHaveBeenCalledWith(run, {
        kill: false,
        reportClosed: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not confirm a forced stop until the child actually exits', async () => {
    vi.useFakeTimers()
    try {
      const manager = new CodingAgentRunManager()
      const child = new EventEmitter() as EventEmitter & {
        pid: number
        exitCode: number | null
        signalCode: NodeJS.Signals | null
        killed: boolean
      }
      Object.assign(child, { pid: 4343, exitCode: null, signalCode: null, killed: false })
      const run = {
        id: 'run-force', launch: { sessionId: 'session-force' }, state: { isWorking: true },
        startedAt: Date.now(), lastActiveAt: Date.now(), exited: false, currentChild: child,
      }
      ;(manager as any).runs.set(run.id, run)
      ;(manager as any).sessionIndex.set('session-force', run.id)
      ;(manager as any).cleanupRun = vi.fn((managedRun: any) => { managedRun.state.isWorking = false })

      const stopping = manager.stopAndWait('session-force', { reportClosed: false, graceMs: 100 })
      let settled = false
      void stopping.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(100)
      expect(settled).toBe(false)

      child.signalCode = 'SIGKILL'
      child.emit('close', null, 'SIGKILL')
      await expect(stopping).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
