import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodingAgentRunManager } from '../../packages/server/src/services/agent-runner/coding-agent-run-manager'

const describeWindows = process.platform === 'win32' ? describe : describe.skip
const roots: string[] = []

async function waitFor(
  events: Array<{ event: string; payload: any }>,
  eventName: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = events.find(event => event.event === eventName)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${eventName}: ${JSON.stringify(events)}`)
}

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describeWindows('real Windows Pi .cmd RPC launch', () => {
  it('preserves non-ASCII paths and sends long UTF-8 text and images over RPC stdin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'Hermes Pi 中文 '))
    roots.push(root)
    const binDir = join(root, '工具 目录')
    const workspaceDir = join(root, '工作区 目录')
    const sessionDir = join(root, '会话 目录')
    const imagePath = join(root, '图片 示例.png')
    await mkdir(binDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      imagePath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nksAAAAASUVORK5CYII=', 'base64'),
    )

    const fixturePath = join(binDir, 'pi-rpc-fixture.cjs')
    const commandPath = join(binDir, 'pi.cmd')
    await writeFile(fixturePath, String.raw`
const readline = require('node:readline')
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line)
  if (command.type === 'abort') {
    process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: 'abort', success: true }) + '\n')
    return
  }
  if (command.type !== 'prompt') return
  const text = 'windows-rpc:' + command.message.length + ':images=' + (command.images || []).length
  process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: 'prompt', success: true }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n')
})
`, 'utf8')
    await writeFile(commandPath, `@echo off\r\nnode "%~dp0pi-rpc-fixture.cjs" %*\r\n`, 'utf8')

    const manager = new CodingAgentRunManager(60_000)
    const events: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => 1
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => events.push({ event, payload })
    ;(manager as any).markChatRunCompleted = () => {}
    ;(manager as any).startWorkspaceRunDiff = () => {}
    ;(manager as any).completeWorkspaceRunDiff = () => undefined
    ;(manager as any).startCodingAgentMemoryExport = () => {}
    // Keep this Windows process/encoding regression independent from cold
    // tokenizer/provider initialization performed by usage accounting.
    ;(manager as any).refreshCodingAgentUsage = async () => {}

    manager.start({
      agentSessionId: 'windows-pi-agent-session',
      agentNativeSessionId: 'windows-pi-native-session',
      agentId: 'pi',
      mode: 'scoped',
      profile: '默认',
      provider: 'fixture',
      model: 'fixture-model',
      sessionId: 'windows-pi-chat-session',
      command: commandPath,
      args: ['--mode', 'rpc', '--session-dir', sessionDir],
      env: {
        PI_CODING_AGENT_DIR: join(root, '配置 目录'),
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
      },
      shellCommand: commandPath,
      workspaceDir,
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    const prompt = `Windows UTF-8：${'超长中文'.repeat(5000)}`
    manager.send('windows-pi-chat-session', prompt, {
      images: [{ name: '图片 示例.png', path: imagePath, mediaType: 'image/png' }],
    })
    await waitFor(events, 'run.completed')

    expect(events).toContainEqual(expect.objectContaining({
      event: 'message.delta',
      payload: expect.objectContaining({
        delta: `windows-rpc:${prompt.length}:images=1`,
      }),
    }))
    manager.stop('windows-pi-chat-session', { reportClosed: false })
  }, 30_000)
})
