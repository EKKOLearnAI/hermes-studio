import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { spawn } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { getRecordedUsageTotals } from '../../packages/server/src/modules/studio/repositories/usage-store'

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: vi.fn(),
}))

describe('OpenCode turns', () => {
  let manager: CodingAgentRunManager
  let workspace: string
  let sessionId: string
  let agentSessionId: string
  let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: null }
  let emitted: ReturnType<typeof vi.fn>

  beforeEach(() => {
    initAllHermesTables()
    workspace = mkdtempSync(join(tmpdir(), 'opencode-turn-'))
    sessionId = `chat-${workspace}`
    agentSessionId = `run-${workspace}`
    manager = new CodingAgentRunManager()
    emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    ;(manager as any).markChatRunCompleted = () => {}
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    })
    vi.mocked(spawn).mockReturnValue(child as any)
  })

  afterEach(() => {
    manager.shutdown()
    rmSync(workspace, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function start(mode: 'global' | 'scoped' = 'global') {
    manager.start({
      agentSessionId, sessionId, agentId: 'opencode', mode,
      profile: 'default', provider: mode === 'global' ? 'global' : 'test', model: 'test-model',
      command: 'opencode', args: ['--model', 'test/model'], shellCommand: 'opencode', workspaceDir: workspace,
    })
  }

  function step(id: string, input: number, output: number) {
    child.stdout.write(`${JSON.stringify({
      type: 'step_finish', sessionID: 'ses_native',
      part: { id, type: 'step-finish', tokens: { input, output, reasoning: 3, cache: { read: 10, write: 2 } } },
    })}\n`)
  }

  function close(code = 0) {
    child.exitCode = code
    child.emit('close', code)
  }

  it('separates attachment paths from messages including option-like text', () => {
    start()
    const files = [join(workspace, 'first image.png'), join(workspace, 'second.png')]
    manager.send(sessionId, '--describe these images', {
      images: files.map((path, index) => ({ path, name: `image-${index}.png`, mediaType: 'image/png' })),
    })
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual([
      'run', '--format', 'json', '--agent', 'build', '--auto', '--thinking',
      '--model', 'test/model', '--file', files[0], '--file', files[1], '--', '--describe these images',
    ])
    close()
  })

  it.each([0, 1])('records every global step once when the child exits %i', async code => {
    start()
    manager.send(sessionId, 'work')
    step('step-one', 100, 20)
    step('step-one', 100, 20)
    step('step-two', 50, 10)
    close(code)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(
      sessionId, code === 0 ? 'run.completed' : 'run.failed', expect.anything(),
    ))
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toEqual({
      inputTokens: 150, outputTokens: 36, reasoningTokens: 6,
      cacheReadTokens: 20, cacheWriteTokens: 4, apiCalls: 2,
    })
    expect(emitted).toHaveBeenCalledWith(sessionId, 'usage.updated', expect.objectContaining({
      inputTokens: 150, outputTokens: 36,
    }))
  })

  it('uses only proxy usage for scoped runs', async () => {
    start('scoped')
    manager.send(sessionId, 'work')
    manager.handleProxyUsageEvent(agentSessionId, {
      type: 'response.completed',
      data: { response: { id: 'proxy-step', usage: { input_tokens: 100, output_tokens: 20 } } },
    })
    step('native-step', 100, 20)
    close()
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.anything()))
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({
      inputTokens: 100, outputTokens: 20, apiCalls: 1,
    })
  })
})
