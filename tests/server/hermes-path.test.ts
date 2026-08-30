import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectHermesHome } from '../../packages/server/src/modules/hermes/services/runtime/path'

describe('Hermes path detection', () => {
  const originalEnv = { ...process.env }
  const originalPlatform = process.platform
  let tempDir = ''

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-path-'))
    process.env = { ...originalEnv }
    process.env.USERPROFILE = join(tempDir, 'User')
    delete process.env.HERMES_HOME
    delete process.env.LOCALAPPDATA
    delete process.env.APPDATA
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = { ...originalEnv }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = ''
  })

  it('keeps explicit HERMES_HOME even when the path does not exist', () => {
    process.env.HERMES_HOME = join(tempDir, 'custom-home')

    expect(detectHermesHome()).toBe(resolve(tempDir, 'custom-home'))
  })

  it('always uses USERPROFILE/.hermes on Windows even when AppData Hermes directories exist', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const userHermes = join(process.env.USERPROFILE!, '.hermes')
    process.env.LOCALAPPDATA = join(tempDir, 'Local')
    process.env.APPDATA = join(tempDir, 'Roaming')
    mkdirSync(join(process.env.LOCALAPPDATA, 'hermes'), { recursive: true })
    mkdirSync(join(process.env.APPDATA, 'hermes'), { recursive: true })

    expect(detectHermesHome()).toBe(resolve(userHermes))
  })

  it('uses USERPROFILE/.hermes on Windows even when the directory does not exist', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const userHermes = join(process.env.USERPROFILE!, '.hermes')

    expect(detectHermesHome()).toBe(resolve(userHermes))
  })

  it('falls back to the OS home on Windows when USERPROFILE is blank', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.USERPROFILE = '   '

    expect(detectHermesHome()).toBe(resolve(homedir(), '.hermes'))
  })

  it('uses the OS home on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    expect(detectHermesHome()).toBe(resolve(homedir(), '.hermes'))
  })
})
