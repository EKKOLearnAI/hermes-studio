import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const originalEnv = { ...process.env }
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-desktop-runtime-paths-'))
  tempDirs.push(dir)
  return dir
}

describe('desktop runtime paths', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    const resourcesPath = tempDir()
    process.resourcesPath = resourcesPath
    process.env.HERMES_WEB_UI_HOME = tempDir()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the downloaded runtime in packaged builds even when stale install resources exist', async () => {
    mkdirSync(join(process.resourcesPath, 'python'), { recursive: true })
    mkdirSync(join(process.resourcesPath, 'node'), { recursive: true })
    mkdirSync(join(process.resourcesPath, 'git'), { recursive: true })

    const { resolveRuntimeResourceDir } = await import('../../packages/desktop/src/main/runtime-paths')
    const runtimeRoot = tempDir()

    expect(resolveRuntimeResourceDir('python', true, process.resourcesPath, runtimeRoot)).toBe(join(runtimeRoot, 'python'))
    expect(resolveRuntimeResourceDir('node', true, process.resourcesPath, runtimeRoot)).toBe(join(runtimeRoot, 'node'))
    expect(resolveRuntimeResourceDir('git', true, process.resourcesPath, runtimeRoot)).toBe(join(runtimeRoot, 'git'))
  })

  it('uses app resources for development runtime paths', async () => {
    const appPath = tempDir()
    const { resolveRuntimeResourceDir, runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const runtimeRoot = tempDir()

    expect(resolveRuntimeResourceDir('python', false, appPath, runtimeRoot)).toBe(join(appPath, 'resources', 'python', runtimePlatformKey()))
    expect(resolveRuntimeResourceDir('node', false, appPath, runtimeRoot)).toBe(join(appPath, 'resources', 'node', runtimePlatformKey()))
    expect(resolveRuntimeResourceDir('git', false, appPath, runtimeRoot)).toBe(join(appPath, 'resources', 'git', runtimePlatformKey()))
  })
})
