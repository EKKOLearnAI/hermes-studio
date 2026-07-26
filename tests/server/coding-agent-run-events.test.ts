import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  CodingAgentRunManager,
  groupChatClaudePrintArgs,
  groupChatCodexExecSafetyArgs,
} from '../../packages/server/src/services/agent-runner/coding-agent-run-manager'

describe('CodingAgentRunManager external event subscriptions', () => {
  it('uses explicit unattended safe-mode flags for group-chat coding agents', () => {
    expect(groupChatCodexExecSafetyArgs('group_chat')).toEqual([
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
    ])
    expect(groupChatCodexExecSafetyArgs(undefined)).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ])

    const args = groupChatClaudePrintArgs('group_chat', [
      '--dangerously-skip-permissions',
      '--model',
      'claude-test',
    ])
    expect(args).toEqual([
      '--permission-mode',
      'dontAsk',
      '--model',
      'claude-test',
    ])
    expect(args).not.toContain('--dangerously-skip-permissions')
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
      expect((manager as any).cleanupRun).toHaveBeenCalledWith(run, {
        kill: true,
        reportClosed: false,
        childKillGraceMs: 15_000,
      })
      expect(child.killed).toBe(false)

      child.exitCode = 0
      child.emit('exit', 0)
      await expect(stopping).resolves.toBe(true)
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
