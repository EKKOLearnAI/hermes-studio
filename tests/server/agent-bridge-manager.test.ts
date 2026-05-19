import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
})
