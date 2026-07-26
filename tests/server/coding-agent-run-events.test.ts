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
