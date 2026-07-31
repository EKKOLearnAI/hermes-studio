import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const homeMock = vi.hoisted(() => ({ dir: '' }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => homeMock.dir }
})

const originalPath = process.env.PATH
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
let home = ''

function installCli(...parts: string[]): string {
  const path = join(home, ...parts)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
  return path
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hermes-home-'))
  homeMock.dir = home
  Object.defineProperty(process, 'platform', { value: 'linux' })
  delete process.env.HERMES_BIN
  vi.resetModules()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  process.env.PATH = originalPath
  delete process.env.HERMES_BIN
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

/**
 * A `systemd --user` unit inherits a minimal PATH that usually leaves out
 * ~/.local/bin, where the CLI installs itself. Every hermes call from the Web
 * UI then fails after a reboot on a machine where hermes is plainly installed.
 */
describe('locating the Hermes CLI', () => {
  it('uses the bare name when PATH can resolve it', async () => {
    const binDir = join(home, 'usr-bin')
    mkdirSync(binDir, { recursive: true })
    const onPath = join(binDir, 'hermes')
    writeFileSync(onPath, '#!/bin/sh\n')
    chmodSync(onPath, 0o755)
    process.env.PATH = binDir

    const { resolveHermesBin } = await import('../../packages/server/src/services/hermes/hermes-process')
    expect(resolveHermesBin()).toBe('hermes')
  })

  it('falls back to ~/.local/bin when PATH cannot', async () => {
    const installed = installCli('.local', 'bin', 'hermes')
    process.env.PATH = '/nonexistent'

    const { resolveHermesBin } = await import('../../packages/server/src/services/hermes/hermes-process')
    expect(resolveHermesBin()).toBe(installed)
  })

  it('also finds the CLI shipped under ~/.hermes', async () => {
    const installed = installCli('.hermes', 'node', 'bin', 'hermes')
    process.env.PATH = '/nonexistent'

    const { resolveHermesBin } = await import('../../packages/server/src/services/hermes/hermes-process')
    expect(resolveHermesBin()).toBe(installed)
  })

  it('keeps HERMES_BIN authoritative', async () => {
    installCli('.local', 'bin', 'hermes')
    process.env.PATH = '/nonexistent'
    process.env.HERMES_BIN = '/opt/custom/hermes'

    const { resolveHermesBin } = await import('../../packages/server/src/services/hermes/hermes-process')
    expect(resolveHermesBin()).toBe('/opt/custom/hermes')
  })

  it('still reports the bare name when nothing is installed', async () => {
    process.env.PATH = '/nonexistent'

    const { resolveHermesBin } = await import('../../packages/server/src/services/hermes/hermes-process')
    expect(resolveHermesBin()).toBe('hermes')
  })
})
