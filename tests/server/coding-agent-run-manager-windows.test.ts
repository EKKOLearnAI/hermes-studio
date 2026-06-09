import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
  class TestEmitter {
    private readonly handlers = new Map<string, Array<(...args: any[]) => void>>()

    on(event: string, handler: (...args: any[]) => void) {
      const handlers = this.handlers.get(event) || []
      handlers.push(handler)
      this.handlers.set(event, handlers)
      return this
    }

    emit(event: string, ...args: any[]) {
      for (const handler of this.handlers.get(event) || []) handler(...args)
      return true
    }
  }

  return {
    spawnCalls: [] as Array<{ command: string; args: string[]; options: any; child: any }>,
    TestEmitter,
  }
})

vi.mock('child_process', () => ({
  spawn: vi.fn((command: string, args: string[], options: any) => {
    const child = new testState.TestEmitter() as any
    child.stdout = new testState.TestEmitter()
    child.stderr = new testState.TestEmitter()
    child.pid = 1234
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.kill = vi.fn(() => {
      child.killed = true
    })
    testState.spawnCalls.push({ command, args, options, child })
    return child
  }),
}))

import { CodingAgentRunManager } from '../../packages/server/src/services/agent-runner/coding-agent-run-manager'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform })
}

beforeEach(() => {
  testState.spawnCalls.length = 0
  setPlatform('win32')
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

describe('coding agent Windows process launch', () => {
  it('runs npm .cmd shims through cmd.exe for hidden Claude Code chat turns', () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-1',
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'claude-test',
      sessionId: 'chat-session-1',
      command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\claude.cmd',
      args: ['--settings', 'C:\\Users\\Administrator\\.hermes-web-ui\\settings.json'],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-1', 'test')

    expect(testState.spawnCalls[0]).toMatchObject({
      command: 'cmd.exe',
      args: expect.arrayContaining(['/d', '/s', '/c']),
    })
    expect(testState.spawnCalls[0].args[3]).toContain('C:\\Users\\Administrator\\AppData\\Roaming\\npm\\claude.cmd')
    expect(testState.spawnCalls[0].args[3]).toContain('^"--settings^"')
    expect(testState.spawnCalls[0].args[3]).toContain('^"test^"')
    expect(testState.spawnCalls[0].options).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: true,
      windowsHide: true,
    })

    const run = (manager as any).runs.get('agent-session-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('runs npm .cmd shims through cmd.exe for hidden Codex chat turns', () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-1',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-test',
      sessionId: 'chat-session-codex-1',
      command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['--model', 'gpt-test'],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-codex-1', 'test')

    expect(testState.spawnCalls[0]).toMatchObject({
      command: 'cmd.exe',
      args: expect.arrayContaining(['/d', '/s', '/c']),
    })
    expect(testState.spawnCalls[0].args[3]).toContain('C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd')
    expect(testState.spawnCalls[0].args[3]).toContain('^"exec^"')
    expect(testState.spawnCalls[0].args[3]).toContain('^"-c^"')
    expect(testState.spawnCalls[0].args[3]).toContain('model_reasoning_summary=\\^"auto\\^"')
    expect(testState.spawnCalls[0].args[3]).toContain('^"--model^"')
    expect(testState.spawnCalls[0].args[3]).toContain('^"test^"')
    expect(testState.spawnCalls[0].options).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: true,
      windowsHide: true,
    })

    const run = (manager as any).runs.get('agent-session-codex-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('preserves non-ASCII Windows .cmd paths when launching hidden chat turns', () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-unicode-1',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-test',
      sessionId: 'chat-session-codex-unicode-1',
      command: 'C:\\用户\\管理员\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['--model', 'gpt-test'],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-codex-unicode-1', 'test')

    expect(testState.spawnCalls[0]).toMatchObject({
      command: 'cmd.exe',
      args: expect.arrayContaining(['/d', '/s', '/c']),
    })
    expect(testState.spawnCalls[0].args[3]).toContain('C:\\用户\\管理员\\AppData\\Roaming\\npm\\codex.cmd')

    const run = (manager as any).runs.get('agent-session-codex-unicode-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('normalizes already quoted Windows .cmd paths before launching hidden chat turns', () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-quoted-1',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-test',
      sessionId: 'chat-session-codex-quoted-1',
      command: '"C:\\nvm4w\\nodejs\\codex.cmd"',
      args: ['--model', 'gpt-test'],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-codex-quoted-1', 'test')

    expect(testState.spawnCalls[0]).toMatchObject({
      command: 'cmd.exe',
      args: expect.arrayContaining(['/d', '/s', '/c']),
    })
    expect(testState.spawnCalls[0].args[3]).toContain('C:\\nvm4w\\nodejs\\codex.cmd')
    expect(testState.spawnCalls[0].args[3]).not.toContain('"C:\\nvm4w\\nodejs\\codex.cmd"')

    const run = (manager as any).runs.get('agent-session-codex-quoted-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('emits a readable failed run when a hidden Claude Code process cannot start', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event: 'marked', payload: { event } })
    }
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }

    manager.start({
      agentSessionId: 'agent-session-error-1',
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'claude-test',
      sessionId: 'chat-session-error-1',
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-error-1', 'test')
    testState.spawnCalls[0].child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))

    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'run.failed',
      payload: expect.objectContaining({
        error: expect.objectContaining({
          message: 'spawn claude ENOENT',
        }),
      }),
    }))

    const run = (manager as any).runs.get('agent-session-error-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('includes decoded stderr detail when a hidden Codex process exits non-zero', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event: 'marked', payload: { event } })
    }
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }

    manager.start({
      agentSessionId: 'agent-session-codex-error-1',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-test',
      sessionId: 'chat-session-codex-error-1',
      command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['--model', 'gpt-test'],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-codex-error-1', 'test')
    testState.spawnCalls[0].child.stderr.emit('data', Buffer.from([0xb2, 0xbb, 0xca, 0xc7]))
    testState.spawnCalls[0].child.emit('exit', 1)

    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'run.failed',
      payload: expect.objectContaining({
        error: expect.objectContaining({
          message: 'Codex exited with code 1: 不是',
        }),
      }),
    }))

    const run = (manager as any).runs.get('agent-session-codex-error-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })
})
