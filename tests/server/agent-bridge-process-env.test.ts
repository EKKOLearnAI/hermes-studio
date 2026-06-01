import { execFileSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { delimiter, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  augmentBridgePath,
  mcpCliPathPrefixes,
  prependPathEntries,
} from '../../packages/server/src/services/hermes/agent-bridge/bridge-path'
import { buildAgentBridgeProcessEnv } from '../../packages/server/src/services/hermes/agent-bridge/manager'

function assignBridgePath(env: NodeJS.ProcessEnv, homeDir = homedir(), options = {}): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  return { ...env, [pathKey]: augmentBridgePath(env, homeDir, options) }
}

describe('agent bridge PATH augmentation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prepends MCP CLI prefixes without dropping existing entries', () => {
    const merged = prependPathEntries('/usr/bin:/bin', ['/Users/test/.npm-global/bin', '/usr/bin'])
    expect(merged.startsWith('/Users/test/.npm-global/bin')).toBe(true)
    expect(merged).toContain('/usr/bin')
    expect(merged).toContain('/bin')
    expect(merged.split(delimiter).filter(entry => entry === '/usr/bin')).toHaveLength(1)
  })

  it('joins Windows-style PATH segments with semicolons', () => {
    const merged = prependPathEntries(
      'C:\\Windows\\System32;C:\\Windows',
      ['C:\\Users\\test\\AppData\\Roaming\\npm'],
      ';',
    )
    expect(merged).toContain('C:\\Users\\test\\AppData\\Roaming\\npm')
    expect(merged).toContain('C:\\Windows\\System32')
    expect(merged.split(';').filter(entry => entry === 'C:\\Windows\\System32')).toHaveLength(1)
  })

  it('includes npm-global and local bin in default prefix list', () => {
    const prefixes = mcpCliPathPrefixes('/Users/test', { resolveNpmGlobalBin: () => undefined })
    expect(prefixes).toContain('/Users/test/.npm-global/bin')
    expect(prefixes).toContain('/Users/test/.local/bin')
  })

  it('adds Homebrew paths only on darwin', () => {
    const darwinPrefixes = mcpCliPathPrefixes('/Users/test', {
      platform: 'darwin',
      resolveNpmGlobalBin: () => undefined,
    })
    expect(darwinPrefixes).toContain('/opt/homebrew/bin')
    expect(darwinPrefixes).toContain('/usr/local/bin')

    const linuxPrefixes = mcpCliPathPrefixes('/Users/test', {
      platform: 'linux',
      resolveNpmGlobalBin: () => undefined,
    })
    expect(linuxPrefixes).not.toContain('/opt/homebrew/bin')
  })

  it('uses npm global prefix directly on win32', () => {
    const prefixes = mcpCliPathPrefixes('C:\\Users\\test', {
      platform: 'win32',
      resolveNpmGlobalBin: () => 'C:\\Users\\test\\AppData\\Roaming\\npm',
    })
    expect(prefixes).toContain('C:\\Users\\test\\AppData\\Roaming\\npm')
    expect(prefixes).not.toContain('C:\\Users\\test\\AppData\\Roaming\\npm\\bin')
  })

  it('skips npm global bin gracefully when npm is unavailable', () => {
    const prefixes = mcpCliPathPrefixes('/Users/test', { resolveNpmGlobalBin: () => undefined })
    expect(prefixes.every(entry => typeof entry === 'string' && entry.length > 0)).toBe(true)
    expect(prefixes).toContain('/Users/test/.npm-global/bin')
    expect(prefixes).toContain('/Users/test/.local/bin')
  })

  it('augments a stripped desktop-style PATH for MCP stdio commands', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin' }
    const augmented = augmentBridgePath(env, '/Users/test', { resolveNpmGlobalBin: () => undefined })
    expect(augmented).toContain('/Users/test/.npm-global/bin')
    expect(augmented).toContain('/usr/bin')
  })

  it('handles missing or empty PATH without stray delimiters', () => {
    const fromEmptyObject = augmentBridgePath({}, '/Users/test', { resolveNpmGlobalBin: () => undefined })
    expect(fromEmptyObject).toContain('/Users/test/.npm-global/bin')
    expect(fromEmptyObject).not.toMatch(new RegExp(`^${delimiter}|${delimiter}$`))

    const fromEmptyString = augmentBridgePath({ PATH: '' }, '/Users/test', { resolveNpmGlobalBin: () => undefined })
    expect(fromEmptyString).toContain('/Users/test/.npm-global/bin')
    expect(fromEmptyString).not.toMatch(new RegExp(`^${delimiter}|${delimiter}$`))
  })

  it('preserves Windows-style Path key without creating a duplicate PATH key', () => {
    const homeDir = 'C:\\Users\\test'
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows\\System32' }
    const updated = assignBridgePath(env, homeDir, {
      platform: 'win32',
      resolveNpmGlobalBin: () => undefined,
    })

    expect(updated.Path).toContain(join(homeDir, '.npm-global', 'bin'))
    expect(updated.Path).toContain('C:\\Windows\\System32')
    expect(updated.PATH).toBeUndefined()
  })

  it('resolves a prepended MCP CLI on unix after augmentation', () => {
    if (process.platform === 'win32') return

    const homeDir = mkdtempSync(join(tmpdir(), 'hermes-bridge-path-'))
    const cliName = `hermes-mcp-probe-${process.pid}`
    try {
      const npmGlobalBin = join(homeDir, '.npm-global', 'bin')
      mkdirSync(npmGlobalBin, { recursive: true })
      const cliPath = join(npmGlobalBin, cliName)
      writeFileSync(cliPath, '#!/bin/sh\nexit 0\n')
      chmodSync(cliPath, 0o755)

      const augmented = augmentBridgePath({ PATH: '/usr/bin:/bin' }, homeDir, {
        resolveNpmGlobalBin: () => undefined,
      })
      const resolved = execFileSync('which', [cliName], {
        encoding: 'utf-8',
        env: { PATH: augmented },
      }).trim()

      expect(resolved).toBe(cliPath)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('buildAgentBridgeProcessEnv injects augmented PATH for bridge workers', () => {
    const previousPath = process.env.PATH
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin'
    try {
      const env = buildAgentBridgeProcessEnv('ipc:///tmp/hermes-agent-bridge.sock', '/Users/test/.hermes', undefined)
      expect(env.PATH).toContain(join(homedir(), '.npm-global', 'bin'))
      expect(env.PATH).toContain('/usr/bin')
      expect(env.HERMES_AGENT_BRIDGE_ENDPOINT).toBe('ipc:///tmp/hermes-agent-bridge.sock')
      expect(env.HERMES_HOME).toBe('/Users/test/.hermes')
    } finally {
      process.env.PATH = previousPath
    }
  })
})
