import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('agent bridge manager command resolution', () => {
  const originalEnv = { ...process.env }
  let tempDir = ''

  beforeEach(() => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-agent-bridge-manager-'))
    process.env = { ...originalEnv }
    delete process.env.HERMES_AGENT_ROOT
    delete process.env.HERMES_AGENT_BRIDGE_PYTHON
    delete process.env.HERMES_AGENT_BRIDGE_UV
    delete process.env.UV
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('uses the installed hermes command Python when no source root exists', async () => {
    const binDir = join(tempDir, 'bin')
    const homeDir = join(tempDir, 'home')
    const fakePython = join(binDir, 'python')
    const fakeHermes = join(binDir, 'hermes')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    writeFileSync(fakePython, '#!/bin/sh\n')
    chmodSync(fakePython, 0o755)
    writeFileSync(fakeHermes, `#!${fakePython}\n`)
    chmodSync(fakeHermes, 0o755)
    process.env.HERMES_HOME = homeDir
    process.env.HERMES_BIN = fakeHermes

    const { resolveAgentBridgeCommand } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
    const command = resolveAgentBridgeCommand()

    expect(command).toEqual({
      command: fakePython,
      argsPrefix: [],
      agentRoot: undefined,
      hermesHome: homeDir,
    })
  })

  it('discovers hermes-agent from a global lib install next to the hermes command', async () => {
    const installDir = join(tempDir, 'usr', 'local')
    const binDir = join(installDir, 'bin')
    const agentRoot = join(installDir, 'lib', 'hermes-agent')
    const fakePython = join(binDir, 'python')
    const fakeHermes = join(binDir, 'hermes')
    const homeDir = join(tempDir, 'home')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(agentRoot, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    writeFileSync(join(agentRoot, 'run_agent.py'), '')
    writeFileSync(fakePython, '#!/bin/sh\n')
    chmodSync(fakePython, 0o755)
    writeFileSync(fakeHermes, `#!${fakePython}\n`)
    chmodSync(fakeHermes, 0o755)
    process.env.HERMES_HOME = homeDir
    process.env.HERMES_BIN = fakeHermes

    const { resolveAgentBridgeCommand } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
    const command = resolveAgentBridgeCommand()

    expect(command.agentRoot).toBe(agentRoot)
  })

  it('falls back to system Python instead of uv when no source root exists', async () => {
    const homeDir = join(tempDir, 'home')
    const fakePython = join(tempDir, 'python3')
    mkdirSync(homeDir, { recursive: true })
    writeFileSync(fakePython, '#!/bin/sh\n')
    chmodSync(fakePython, 0o755)
    process.env.HERMES_HOME = homeDir
    process.env.HERMES_BIN = join(tempDir, 'missing-hermes')
    process.env.PYTHON = fakePython

    const { resolveAgentBridgeCommand } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
    const command = resolveAgentBridgeCommand()

    expect(command).toEqual({
      command: fakePython,
      argsPrefix: [],
      agentRoot: undefined,
      hermesHome: homeDir,
    })
  })

  it('injects Web UI OpenRouter attribution into the bridge process env by default', async () => {
    const { buildAgentBridgeProcessEnv } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
    const env = buildAgentBridgeProcessEnv('ipc:///tmp/test.sock', '/tmp/hermes-home', '/tmp/hermes-agent')

    expect(env.HERMES_OPENROUTER_APP_REFERER).toBe('https://hermes-studio.ai')
    expect(env.HERMES_OPENROUTER_APP_TITLE).toBe('Hermes Studio')
    expect(env.HERMES_OPENROUTER_APP_CATEGORIES).toBe('cli-agent,personal-agent')
  })

  it('keeps explicit OpenRouter attribution env values when starting the bridge', async () => {
    process.env.HERMES_OPENROUTER_APP_REFERER = 'https://example.invalid/app'
    process.env.HERMES_OPENROUTER_APP_TITLE = 'Custom App'
    process.env.HERMES_OPENROUTER_APP_CATEGORIES = 'custom-category'

    const { buildAgentBridgeProcessEnv } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
    const env = buildAgentBridgeProcessEnv('ipc:///tmp/test.sock', '/tmp/hermes-home', undefined)

    expect(env.HERMES_OPENROUTER_APP_REFERER).toBe('https://example.invalid/app')
    expect(env.HERMES_OPENROUTER_APP_TITLE).toBe('Custom App')
    expect(env.HERMES_OPENROUTER_APP_CATEGORIES).toBe('custom-category')
  })

  it('uses an isolated default bridge endpoint while running under Vitest', async () => {
    const { DEFAULT_AGENT_BRIDGE_ENDPOINT } = await import('../../packages/server/src/services/hermes/agent-bridge/client')

    expect(DEFAULT_AGENT_BRIDGE_ENDPOINT).toContain(`hermes-agent-bridge-test-${process.pid}`)
    expect(DEFAULT_AGENT_BRIDGE_ENDPOINT).not.toBe('ipc:///tmp/hermes-agent-bridge.sock')
  })

  it('honors the bridge connect retry environment override', async () => {
    process.env.HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS = '120000'

    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1' })

    expect(client.connectRetryMs).toBe(120000)
  })

  it('waits briefly for a restarting bridge socket before failing', async () => {
    const endpoint = `tcp://127.0.0.1:${32000 + (process.pid % 10000)}`
    let server: Server | undefined

    const ready = new Promise<void>((resolve) => {
      setTimeout(() => {
        server = createServer((socket) => {
          socket.once('data', () => {
            socket.end(`${JSON.stringify({ ok: true, pong: true })}\n`)
          })
        })
        if (endpoint.startsWith('ipc://')) {
          server.listen(endpoint.slice('ipc://'.length), resolve)
        } else {
          const url = new URL(endpoint)
          server.listen(Number(url.port), url.hostname, resolve)
        }
      }, 150)
    })

    try {
      const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
      const client = new AgentBridgeClient({ endpoint, connectRetryMs: 1000, timeoutMs: 1000 })
      await expect(client.ping()).resolves.toMatchObject({ ok: true, pong: true })
      await ready
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
    }
  })

  it('reports readiness when a fake TCP server answers ping with pong', async () => {
    const endpoint = `tcp://127.0.0.1:${33000 + (process.pid % 10000)}`
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.end(`${JSON.stringify({ ok: true, pong: true })}\n`)
      })
    })

    await new Promise<void>((resolve) => {
      const url = new URL(endpoint)
      server.listen(Number(url.port), url.hostname, resolve)
    })

    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
      const manager = new AgentBridgeManager({ endpoint })

      await expect(manager.checkReadiness({ timeoutMs: 250, connectRetryMs: 0 })).resolves.toMatchObject({
        endpoint,
        endpointKind: 'tcp',
        status: 'ready',
        reachable: true,
        ready: true,
        running: true,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 0,
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('reports unreachable instead of throwing when endpoint is missing', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
    const manager = new AgentBridgeManager()
    manager.endpoint = ''

    await expect(manager.checkReadiness()).resolves.toMatchObject({
      endpoint: '',
      endpointKind: 'unknown',
      status: 'unreachable',
      reachable: false,
      ready: false,
      running: false,
      attached: false,
      starting: false,
      stopping: false,
      restartScheduled: false,
      restartAttempts: 0,
      error: 'agent bridge endpoint is not configured',
    })
  })

  it('reports starting readiness without pinging the bridge', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const { AgentBridgeManager } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
    const pingSpy = vi.spyOn(AgentBridgeClient.prototype, 'ping')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6553' })

    ;(manager as any).starting = Promise.resolve()

    await expect(manager.checkReadiness()).resolves.toMatchObject({
      endpoint: 'tcp://127.0.0.1:6553',
      endpointKind: 'tcp',
      status: 'starting',
      reachable: false,
      ready: false,
      running: false,
      attached: false,
      starting: true,
      stopping: false,
      restartScheduled: false,
      restartAttempts: 0,
    })
    expect(pingSpy).not.toHaveBeenCalled()
  })

  it('reports stopping readiness without pinging the bridge', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const { AgentBridgeManager } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
    const pingSpy = vi.spyOn(AgentBridgeClient.prototype, 'ping')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6554' })

    ;(manager as any).attached = true
    ;(manager as any).ready = true
    ;(manager as any).stopping = true

    await expect(manager.checkReadiness()).resolves.toMatchObject({
      endpoint: 'tcp://127.0.0.1:6554',
      endpointKind: 'tcp',
      status: 'stopping',
      reachable: false,
      ready: false,
      running: false,
      attached: true,
      starting: false,
      stopping: true,
      restartScheduled: false,
      restartAttempts: 0,
    })
    expect(pingSpy).not.toHaveBeenCalled()
  })

  it('reports restarting readiness without pinging the bridge', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const { AgentBridgeManager } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
    const pingSpy = vi.spyOn(AgentBridgeClient.prototype, 'ping')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6555' })

    ;(manager as any).restartAttempts = 2
    ;(manager as any).restartTimer = setTimeout(() => undefined, 1000)

    try {
      await expect(manager.checkReadiness()).resolves.toMatchObject({
        endpoint: 'tcp://127.0.0.1:6555',
        endpointKind: 'tcp',
        status: 'restarting',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: true,
        restartAttempts: 2,
      })
    } finally {
      clearTimeout((manager as any).restartTimer)
      ;(manager as any).restartTimer = null
    }

    expect(pingSpy).not.toHaveBeenCalled()
  })

  it('attaches to an already running bridge instead of spawning a replacement', async () => {
    const endpoint = `tcp://127.0.0.1:${34000 + (process.pid % 10000)}`
    const actions: string[] = []
    const server = createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').trim())
        actions.push(request.action)
        socket.end(`${JSON.stringify({ ok: true, pong: request.action === 'ping' })}\n`)
      })
    })

    await new Promise<void>((resolve) => {
      if (endpoint.startsWith('ipc://')) {
        server.listen(endpoint.slice('ipc://'.length), resolve)
      } else {
        const url = new URL(endpoint)
        server.listen(Number(url.port), url.hostname, resolve)
      }
    })

    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
      const manager = new AgentBridgeManager({ endpoint, startupTimeoutMs: 100 })

      await manager.start()

      expect(actions).toEqual(['ping'])
      expect(manager.getRuntimeState()).toMatchObject({
        endpoint,
        ready: true,
        running: true,
        attached: true,
        pid: undefined,
      })
      await manager.stop()
      expect(actions).toEqual(['ping', 'shutdown'])
      expect(manager.getRuntimeState()).toMatchObject({
        ready: false,
        running: false,
        attached: false,
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('requests shutdown when stopping an attached bridge', async () => {
    const endpoint = `tcp://127.0.0.1:${35000 + (process.pid % 10000)}`
    const actions: string[] = []
    const server = createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').trim())
        actions.push(request.action)
        socket.end(`${JSON.stringify({ ok: true, pong: request.action === 'ping' })}\n`)
      })
    })

    await new Promise<void>((resolve) => {
      const url = new URL(endpoint)
      server.listen(Number(url.port), url.hostname, resolve)
    })

    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
      const manager = new AgentBridgeManager({ endpoint, startupTimeoutMs: 100 })

      await manager.start()
      await manager.stop()

      expect(actions).toEqual(['ping', 'shutdown'])
      expect(manager.getRuntimeState()).toMatchObject({
        ready: false,
        running: false,
        attached: false,
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('clears stopping after stop completes for an attached bridge', async () => {
    const endpoint = `tcp://127.0.0.1:${36000 + (process.pid % 10000)}`
    const actions: string[] = []
    const server = createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').trim())
        actions.push(request.action)
        socket.end(`${JSON.stringify({ ok: true, pong: request.action === 'ping' })}\n`, () => {
          if (request.action === 'shutdown') {
            server.close()
          }
        })
      })
    })
    const serverClosed = new Promise<void>((resolve) => server.once('close', () => resolve()))

    await new Promise<void>((resolve) => {
      const url = new URL(endpoint)
      server.listen(Number(url.port), url.hostname, resolve)
    })

    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/services/hermes/agent-bridge/manager')
      const manager = new AgentBridgeManager({ endpoint, startupTimeoutMs: 100 })

      await manager.start()
      await manager.stop()
      await serverClosed

      expect(actions).toEqual(['ping', 'shutdown'])
      expect(manager.getRuntimeState()).toMatchObject({
        ready: false,
        running: false,
        attached: false,
        stopping: false,
      })
      await expect(manager.checkReadiness({ timeoutMs: 250, connectRetryMs: 0 })).resolves.toMatchObject({
        endpoint,
        endpointKind: 'tcp',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 0,
      })
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  })
})
