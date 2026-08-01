import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findCachedRuntime,
  runtimePlatformKey,
  runtimeReady,
} from '../../scripts/desktop-runtime-detection.mjs'

const tempDirs: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-desktop-dev-runtime-'))
  tempDirs.push(directory)
  return directory
}

function createRuntime(root: string, version: string, layout: 'legacy' | 'source'): void {
  const pythonRoot = layout === 'source' ? join(root, 'python', 'venv') : join(root, 'python')
  if (process.platform === 'win32') {
    mkdirSync(join(pythonRoot, 'Scripts'), { recursive: true })
    mkdirSync(join(root, 'node'), { recursive: true })
    mkdirSync(join(root, 'git', 'cmd'), { recursive: true })
    writeFileSync(join(pythonRoot, 'python.exe'), '')
    writeFileSync(join(pythonRoot, 'Scripts', 'hermes.cmd'), '')
    writeFileSync(join(root, 'node', 'node.exe'), '')
    writeFileSync(join(root, 'git', 'cmd', 'git.exe'), '')
  } else {
    mkdirSync(join(pythonRoot, 'bin'), { recursive: true })
    mkdirSync(join(root, 'node', 'bin'), { recursive: true })
    writeFileSync(join(pythonRoot, 'bin', 'python3'), '')
    writeFileSync(join(pythonRoot, 'bin', 'hermes'), '')
    writeFileSync(join(root, 'node', 'bin', 'node'), '')
  }
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
    schema: layout === 'source' ? 2 : 1,
    hermesAgentVersion: version,
    platform: runtimePlatformKey(),
  }))
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('desktop development Runtime detection', () => {
  it('uses the legacy Python layout below Hermes 0.19.1', () => {
    const legacyRuntime = tempDir()
    const sourceRuntime = tempDir()
    createRuntime(legacyRuntime, '0.19.0', 'legacy')
    createRuntime(sourceRuntime, '0.19.0', 'source')

    expect(runtimeReady(legacyRuntime)).toBe(true)
    expect(runtimeReady(sourceRuntime)).toBe(false)
  })

  it('uses the source venv layout for Hermes 0.19.1 and newer', () => {
    const sourceRuntime = tempDir()
    const legacyRuntime = tempDir()
    createRuntime(sourceRuntime, '0.19.1', 'source')
    createRuntime(legacyRuntime, '0.19.1', 'legacy')

    expect(runtimeReady(sourceRuntime)).toBe(true)
    expect(runtimeReady(legacyRuntime)).toBe(false)
  })

  it('keeps the active source Runtime from a custom storage root', () => {
    const webUiHome = tempDir()
    const customRoot = tempDir()
    const activeRuntime = join(customRoot, 'hermes', '0.19.1', runtimePlatformKey())
    createRuntime(activeRuntime, '0.19.1', 'source')
    mkdirSync(join(webUiHome, 'desktop-runtime'), { recursive: true })
    writeFileSync(join(webUiHome, 'desktop-runtime', 'active-version.json'), JSON.stringify({
      schema: 1,
      hermesRuntimeVersion: '0.19.1',
      runtimeDirectory: activeRuntime,
      runtimeRootDirectory: customRoot,
      platform: runtimePlatformKey(),
    }))

    expect(findCachedRuntime(webUiHome)).toBe(activeRuntime)
  })
})
