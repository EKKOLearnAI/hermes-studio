import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

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
})
