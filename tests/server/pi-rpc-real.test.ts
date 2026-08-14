import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodingAgentRunManager } from '../../packages/server/src/services/agent-runner/coding-agent-run-manager'

const realE2eEnabled = process.env.PI_REAL_RPC_E2E === '1'
const describeReal = realE2eEnabled ? describe : describe.skip

type RpcProcess = {
  child: ChildProcessWithoutNullStreams
  events: any[]
  stderr: string[]
  send(command: Record<string, unknown>): void
  waitFor(predicate: (event: any) => boolean, from?: number, timeoutMs?: number): Promise<any>
  close(): Promise<void>
}

function findPiCommand(): string {
  const configured = String(process.env.PI_RPC_E2E_COMMAND || '').trim()
  if (configured) return configured
  return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pi'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(Boolean) || 'pi'
}

function startRpc(args: string[], env: NodeJS.ProcessEnv): RpcProcess {
  const child = spawn(findPiCommand(), args, {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events: any[] = []
  const stderr: string[] = []
  let stdoutBuffer = ''

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8')
    while (true) {
      const newline = stdoutBuffer.indexOf('\n')
      if (newline < 0) break
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        events.push({ type: 'invalid_jsonl', line })
      }
    }
  })
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))

  return {
    child,
    events,
    stderr,
    send(command) {
      child.stdin.write(`${JSON.stringify(command)}\n`)
    },
    async waitFor(predicate, from = 0, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = events.slice(from).find(predicate)
        if (found) return found
        if (child.exitCode != null) {
          throw new Error(`Pi RPC exited with ${child.exitCode}: ${stderr.join('')}`)
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
      }
      throw new Error(`Timed out waiting for Pi RPC event. stderr=${stderr.join('')} events=${JSON.stringify(events.slice(from))}`)
    },
    async close() {
      if (child.exitCode != null) return
      child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>(resolvePromise => child.once('close', () => resolvePromise())),
        new Promise<void>(resolvePromise => setTimeout(() => {
          child.kill('SIGKILL')
          resolvePromise()
        }, 2_000)),
      ])
    },
  }
}

async function promptAndSettle(rpc: RpcProcess, id: string, message: string, images?: any[]) {
  const from = rpc.events.length
  rpc.send({ id, type: 'prompt', message, ...(images?.length ? { images } : {}) })
  await rpc.waitFor(event => event.type === 'response' && event.id === id && event.success === true, from)
  await rpc.waitFor(event => event.type === 'agent_settled', from)
  return rpc.events.slice(from)
}

function createStudioManager() {
  const manager = new CodingAgentRunManager(60_000)
  const emitted: Array<{ sessionId: string; event: string; payload: any }> = []
  ;(manager as any).ensureDbSession = () => {}
  ;(manager as any).addUserMessage = (run: any, content: string) => {
    run.state.messages.push({
      id: run.state.messages.length + 1,
      session_id: run.launch.sessionId,
      role: 'user',
      content,
      timestamp: Math.floor(Date.now() / 1000),
    })
    return run.state.messages.length
  }
  ;(manager as any).emitToChat = (sessionId: string, event: string, payload: any) => {
    emitted.push({ sessionId, event, payload })
  }
  ;(manager as any).markChatRunCompleted = () => {}
  ;(manager as any).startWorkspaceRunDiff = () => {}
  ;(manager as any).completeWorkspaceRunDiff = () => undefined
  ;(manager as any).startCodingAgentMemoryExport = () => {}
  return { manager, emitted }
}

async function waitForStudioEvent(
  emitted: Array<{ sessionId: string; event: string; payload: any }>,
  predicate: (event: { sessionId: string; event: string; payload: any }) => boolean,
  from = 0,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = emitted.slice(from).find(predicate)
    if (found) return found
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  throw new Error(`Timed out waiting for Studio Pi event: ${JSON.stringify(emitted.slice(from))}`)
}

describeReal('real Pi RPC end-to-end', () => {
  let root = ''
  let configDir = ''
  let sessionDir = ''
  let imagePath = ''
  let rpc: RpcProcess
  const sessionId = '11111111-2222-4333-8444-555555555555'

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-real-pi-rpc-'))
    configDir = join(root, '配置 目录')
    sessionDir = join(root, '会话 目录')
    imagePath = join(root, '图片 示例.png')
    await mkdir(configDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      imagePath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nksAAAAASUVORK5CYII=', 'base64'),
    )

    const adapterEntry = resolve(
      process.env.PI_RPC_E2E_ADAPTER_ENTRY
        || join(homedir(), '.hermes-web-ui', 'coding-agent', 'pi-mcp-adapter', 'node_modules', 'pi-mcp-adapter', 'index.ts'),
    )
    if (!existsSync(adapterEntry)) throw new Error(`Pi MCP Adapter not found: ${adapterEntry}`)
    const extensionEntry = resolve('tests/fixtures/pi-rpc-e2e-extension.ts')
    const mcpServerEntry = resolve('tests/fixtures/pi-rpc-e2e-mcp-server.mjs')
    await writeFile(join(configDir, 'settings.json'), `${JSON.stringify({
      extensions: [extensionEntry, adapterEntry],
      quietStartup: true,
    }, null, 2)}\n`, 'utf8')
    await writeFile(join(configDir, 'mcp.json'), `${JSON.stringify({
      settings: {
        hostConfigDiscovery: 'off',
        directTools: false,
      },
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerEntry],
          lifecycle: 'lazy',
          directTools: false,
        },
      },
    }, null, 2)}\n`, 'utf8')

    rpc = startRpc([
      '--mode', 'rpc',
      '--provider', 'hermes-e2e',
      '--model', 'e2e-model',
      '--session-id', sessionId,
      '--session-dir', sessionDir,
      '--no-approve',
      '--offline',
    ], {
      ...process.env,
      PI_CODING_AGENT_DIR: configDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_SKIP_VERSION_CHECK: '1',
    })
    rpc.send({ id: 'initial-state', type: 'get_state' })
    await rpc.waitFor(event => event.type === 'response' && event.id === 'initial-state' && event.success === true)
  }, 30_000)

  afterAll(async () => {
    await rpc?.close()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('covers lifecycle, UTF-8, images, tools, MCP, failure, abort, multi-turn, and recovery', async () => {
    const imageData = readFile(imagePath).then(data => data.toString('base64'))
    const first = await promptAndSettle(rpc, 'prompt-image', '第一轮 E2E_IMAGE', [{
      type: 'image',
      data: await imageData,
      mimeType: 'image/png',
    }])
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent_start' }),
      expect.objectContaining({ type: 'turn_start' }),
      expect.objectContaining({
        type: 'message_end',
        message: expect.objectContaining({
          role: 'assistant',
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: expect.stringContaining('images=1') }),
          ]),
        }),
      }),
      expect.objectContaining({ type: 'turn_end' }),
      expect.objectContaining({ type: 'agent_end' }),
      expect.objectContaining({ type: 'agent_settled' }),
    ]))

    const second = await promptAndSettle(rpc, 'prompt-multi', '第二轮 E2E_MULTI')
    const secondText = JSON.stringify(second)
    expect(secondText).toContain('reply:第二轮 E2E_MULTI')
    expect(secondText).toMatch(/messages=[3-9]/)

    const localTool = await promptAndSettle(rpc, 'prompt-local-tool', 'E2E_LOCAL_TOOL')
    expect(localTool.some(event => event.type === 'tool_execution_start' && event.toolName === 'e2e_local_tool')).toBe(true)
    expect(JSON.stringify(localTool)).toContain('tool-result:local:works')

    const mcpTool = await promptAndSettle(rpc, 'prompt-mcp-tool', 'E2E_MCP_TOOL', undefined)
    expect(mcpTool.some(event => event.type === 'tool_execution_start' && event.toolName === 'mcp')).toBe(true)
    expect(JSON.stringify(mcpTool)).toContain('tool-result:mcp:mcp-works')

    const failure = await promptAndSettle(rpc, 'prompt-failure', 'E2E_FAIL')
    expect(failure.some(event => (
      event.type === 'message_end'
      && event.message?.role === 'assistant'
      && event.message?.stopReason === 'error'
      && String(event.message?.errorMessage || '').includes('intentional Pi provider failure')
    ))).toBe(true)

    const abortFrom = rpc.events.length
    rpc.send({ id: 'prompt-abort', type: 'prompt', message: 'E2E_ABORT' })
    await rpc.waitFor(event => event.type === 'agent_start', abortFrom)
    rpc.send({ id: 'abort', type: 'abort' })
    await rpc.waitFor(event => event.type === 'response' && event.id === 'abort' && event.success === true, abortFrom)
    await rpc.waitFor(event => event.type === 'agent_settled', abortFrom)
    expect(rpc.events.slice(abortFrom).some(event => (
      event.type === 'message_end'
      && event.message?.role === 'assistant'
      && event.message?.stopReason === 'aborted'
    ))).toBe(true)

    await rpc.close()
    rpc = startRpc([
      '--mode', 'rpc',
      '--provider', 'hermes-e2e',
      '--model', 'e2e-model',
      '--session-id', sessionId,
      '--session-dir', sessionDir,
      '--no-approve',
      '--offline',
    ], {
      ...process.env,
      PI_CODING_AGENT_DIR: configDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_SKIP_VERSION_CHECK: '1',
    })
    rpc.send({ id: 'resumed-state', type: 'get_state' })
    const resumed = await rpc.waitFor(event => event.type === 'response' && event.id === 'resumed-state' && event.success === true)
    expect(resumed.data.sessionId).toBe(sessionId)
    expect(resumed.data.messageCount).toBeGreaterThan(0)
    const recovered = await promptAndSettle(rpc, 'prompt-recovered', 'E2E_RECOVERED')
    expect(JSON.stringify(recovered)).toContain('reply:E2E_RECOVERED')
  }, 60_000)

  it('runs the real Pi process through CodingAgentRunManager and canonical Studio events', async () => {
    const managerSessionDir = join(root, 'Studio Manager 会话')
    await mkdir(managerSessionDir, { recursive: true })
    const nativeSessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const launch = (sessionId: string) => ({
      agentSessionId: `agent-${sessionId}`,
      agentNativeSessionId: nativeSessionId,
      agentId: 'pi' as const,
      mode: 'scoped' as const,
      profile: 'default',
      provider: 'hermes-e2e',
      model: 'e2e-model',
      sessionId,
      command: findPiCommand(),
      args: [
        '--mode', 'rpc',
        '--provider', 'hermes-e2e',
        '--model', 'e2e-model',
        '--session-id', nativeSessionId,
        '--session-dir', managerSessionDir,
        '--no-approve',
        '--offline',
      ],
      env: {
        PI_CODING_AGENT_DIR: configDir,
        PI_CODING_AGENT_SESSION_DIR: managerSessionDir,
        PI_SKIP_VERSION_CHECK: '1',
      },
      shellCommand: 'pi',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    const firstStudio = createStudioManager()
    firstStudio.manager.start(launch('studio-pi-chat-1'))

    let from = firstStudio.emitted.length
    firstStudio.manager.send('studio-pi-chat-1', 'Studio E2E image', {
      images: [{ name: '图片 示例.png', path: imagePath, mediaType: 'image/png' }],
    })
    await waitForStudioEvent(firstStudio.emitted, event => event.event === 'run.completed', from)
    expect(firstStudio.emitted.slice(from)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'run.started' }),
      expect.objectContaining({
        event: 'message.delta',
        payload: expect.objectContaining({ delta: expect.stringContaining('images=1') }),
      }),
      expect.objectContaining({ event: 'run.completed' }),
    ]))

    from = firstStudio.emitted.length
    firstStudio.manager.send('studio-pi-chat-1', 'E2E_LOCAL_TOOL')
    await waitForStudioEvent(firstStudio.emitted, event => event.event === 'run.completed', from)
    expect(firstStudio.emitted.slice(from).some(event => event.event === 'tool.started')).toBe(true)
    expect(firstStudio.emitted.slice(from).some(event => (
      event.event === 'tool.completed'
      && JSON.stringify(event.payload).includes('local:works')
    ))).toBe(true)

    from = firstStudio.emitted.length
    firstStudio.manager.send('studio-pi-chat-1', 'E2E_MCP_TOOL')
    await waitForStudioEvent(firstStudio.emitted, event => event.event === 'run.completed', from)
    expect(firstStudio.emitted.slice(from).some(event => (
      event.event === 'tool.completed'
      && JSON.stringify(event.payload).includes('mcp:mcp-works')
    ))).toBe(true)

    from = firstStudio.emitted.length
    firstStudio.manager.send('studio-pi-chat-1', 'E2E_FAIL')
    await waitForStudioEvent(firstStudio.emitted, event => event.event === 'run.failed', from)
    expect(JSON.stringify(firstStudio.emitted.slice(from))).toContain('intentional Pi provider failure')

    from = firstStudio.emitted.length
    firstStudio.manager.send('studio-pi-chat-1', 'E2E_ABORT')
    await waitForStudioEvent(firstStudio.emitted, event => event.event === 'run.started', from)
    expect(firstStudio.manager.stop('studio-pi-chat-1')).toBe(true)
    await waitForStudioEvent(firstStudio.emitted, event => event.event === 'run.failed', from)
    expect(JSON.stringify(firstStudio.emitted.slice(from))).toContain('Coding agent session closed')

    const recoveredStudio = createStudioManager()
    recoveredStudio.manager.start(launch('studio-pi-chat-2'))
    from = recoveredStudio.emitted.length
    recoveredStudio.manager.send('studio-pi-chat-2', 'E2E_RECOVERED')
    await waitForStudioEvent(recoveredStudio.emitted, event => event.event === 'run.completed', from)
    const recoveredText = recoveredStudio.emitted
      .slice(from)
      .filter(event => event.event === 'message.delta')
      .map(event => String(event.payload?.delta || ''))
      .join('')
    expect(recoveredText).toContain('reply:E2E_RECOVERED')
    expect(Number(recoveredText.match(/messages=(\d+)/)?.[1] || 0)).toBeGreaterThan(2)
    recoveredStudio.manager.stop('studio-pi-chat-2', { reportClosed: false })
  }, 60_000)
})
