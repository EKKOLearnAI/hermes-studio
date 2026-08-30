import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
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

  it('uses ~/.hermes with a Hermes config before LOCALAPPDATA and APPDATA', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const userHermes = join(process.env.USERPROFILE!, '.hermes')
    mkdirSync(userHermes, { recursive: true })
    writeFileSync(join(userHermes, 'config.yaml'), 'model: test\n')
    process.env.LOCALAPPDATA = join(tempDir, 'Local')
    process.env.APPDATA = join(tempDir, 'Roaming')

    expect(detectHermesHome()).toBe(resolve(userHermes))
  })

  it('uses a legacy ~/.hermes with a known data directory', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const userHermes = join(process.env.USERPROFILE!, '.hermes')
    mkdirSync(join(userHermes, 'sessions'), { recursive: true })
    process.env.LOCALAPPDATA = join(tempDir, 'Local')

    expect(detectHermesHome()).toBe(resolve(userHermes))
  })

  it('ignores an empty ~/.hermes directory', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const userHermes = join(process.env.USERPROFILE!, '.hermes')
    const localHermes = join(tempDir, 'Local', 'hermes')
    mkdirSync(userHermes, { recursive: true })
    process.env.LOCALAPPDATA = join(tempDir, 'Local')

    expect(detectHermesHome()).toBe(resolve(localHermes))
  })

  it('ignores ~/.hermes with unrelated entries or marker names of the wrong type', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const userHermes = join(process.env.USERPROFILE!, '.hermes')
    const localHermes = join(tempDir, 'Local', 'hermes')
    mkdirSync(join(userHermes, 'config.yaml'), { recursive: true })
    writeFileSync(join(userHermes, 'notes.txt'), 'not Hermes data\n')
    process.env.LOCALAPPDATA = join(tempDir, 'Local')

    expect(detectHermesHome()).toBe(resolve(localHermes))
  })

  it('falls back to Windows LOCALAPPDATA when ~/.hermes is missing', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const localHermes = join(tempDir, 'Local', 'hermes')
    process.env.LOCALAPPDATA = join(tempDir, 'Local')
    process.env.APPDATA = join(tempDir, 'Roaming')

    expect(detectHermesHome()).toBe(resolve(localHermes))
  })

  it('falls back to Windows APPDATA when LOCALAPPDATA is unavailable', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const roamingHermes = join(tempDir, 'Roaming', 'hermes')
    process.env.APPDATA = join(tempDir, 'Roaming')

    expect(detectHermesHome()).toBe(resolve(roamingHermes))
  })

  it('uses ~/.hermes on Windows when AppData environment variables are unavailable', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    expect(detectHermesHome()).toBe(resolve(process.env.USERPROFILE!, '.hermes'))
  })
})
