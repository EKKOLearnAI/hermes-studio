import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectHermesHome } from '../../packages/server/src/services/hermes/hermes-path'

describe('Hermes path detection', () => {
  const originalEnv = { ...process.env }
  const originalPlatform = process.platform
  let tempDir = ''

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-path-'))
    process.env = { ...originalEnv }
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

  it('falls back to ~/.hermes on Windows when LOCALAPPDATA hermes is missing', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.LOCALAPPDATA = join(tempDir, 'Local')

    expect(detectHermesHome()).toBe(resolve(homedir(), '.hermes'))
  })

  it('uses existing Windows LOCALAPPDATA hermes before APPDATA', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const localHermes = join(tempDir, 'Local', 'hermes')
    const roamingHermes = join(tempDir, 'Roaming', 'hermes')
    mkdirSync(localHermes, { recursive: true })
    mkdirSync(roamingHermes, { recursive: true })
    process.env.LOCALAPPDATA = join(tempDir, 'Local')
    process.env.APPDATA = join(tempDir, 'Roaming')

    expect(detectHermesHome()).toBe(resolve(localHermes))
  })

  it('falls back to existing Windows APPDATA hermes when LOCALAPPDATA hermes is missing', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const roamingHermes = join(tempDir, 'Roaming', 'hermes')
    mkdirSync(roamingHermes, { recursive: true })
    process.env.LOCALAPPDATA = join(tempDir, 'Local')
    process.env.APPDATA = join(tempDir, 'Roaming')

    expect(detectHermesHome()).toBe(resolve(roamingHermes))
  })
})
