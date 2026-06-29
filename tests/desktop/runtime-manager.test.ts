import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockElectronApp = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getVersion: () => '0.6.21',
  getLocale: () => 'en',
}))

vi.mock('electron', () => ({
  app: mockElectronApp,
}))

const originalEnv = { ...process.env }
const tempDirs: string[] = []
const servers: Server[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function createRuntimeFiles(root: string) {
  if (process.platform === 'win32') {
    mkdirSync(join(root, 'python', 'Scripts'), { recursive: true })
    mkdirSync(join(root, 'node'), { recursive: true })
    mkdirSync(join(root, 'git', 'cmd'), { recursive: true })
    writeFileSync(join(root, 'python', 'python.exe'), '')
    writeFileSync(join(root, 'python', 'Scripts', 'hermes.exe'), '')
    writeFileSync(join(root, 'node', 'node.exe'), '')
    writeFileSync(join(root, 'git', 'cmd', 'git.exe'), '')
  } else {
    mkdirSync(join(root, 'python', 'bin'), { recursive: true })
    mkdirSync(join(root, 'node', 'bin'), { recursive: true })
    writeFileSync(join(root, 'python', 'bin', 'python3'), '')
    writeFileSync(join(root, 'python', 'bin', 'hermes'), '')
    writeFileSync(join(root, 'node', 'bin', 'node'), '')
  }
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
    schema: 1,
    platform: process.platform,
    hermesAgentVersion: '0.17.0',
    asset: { name: 'hermes-runtime-test.tar.gz' },
  }))
}

async function createRuntimeArchive(): Promise<string> {
  const source = tempDir('hermes-runtime-source-')
  const archive = join(tempDir('hermes-runtime-archive-'), 'hermes-runtime-test.tar.gz')
  createRuntimeFiles(source)
  await tar.c({ gzip: true, cwd: source, file: archive }, ['.'])
  return archive
}

async function serveFile(file: string): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== '/hermes-runtime-test.tar.gz') {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/gzip' })
    createReadStream(file).pipe(response)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a port')
  return `http://127.0.0.1:${address.port}/hermes-runtime-test.tar.gz`
}

describe('desktop runtime manager', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    process.env.HERMES_WEB_UI_HOME = tempDir('hermes-runtime-home-')
    process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG = 'hermes-0.17.0-runtime'
    mockElectronApp.isPackaged = false
    mockElectronApp.getAppPath = () => process.cwd()
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    vi.resetModules()
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('downloads through a unique temp file instead of reusing a stale runtime .download path', async () => {
    const archive = await createRuntimeArchive()
    process.env.HERMES_DESKTOP_RUNTIME_URL = await serveFile(archive)

    const { runtimePlatformKey } = await import('../../packages/desktop/src/main/runtime-paths')
    const staleDownloadPath = join(
      process.env.HERMES_WEB_UI_HOME!,
      'desktop-runtime',
      'hermes',
      '0.17.0',
      'hermes-runtime-test.tar.gz.download',
    )
    mkdirSync(staleDownloadPath, { recursive: true })

    const { ensureDesktopRuntime } = await import('../../packages/desktop/src/main/runtime-manager')
    await ensureDesktopRuntime()

    const runtimeRoot = join(
      process.env.HERMES_WEB_UI_HOME!,
      'desktop-runtime',
      'hermes',
      '0.17.0',
      runtimePlatformKey(),
    )
    expect(existsSync(staleDownloadPath)).toBe(true)
    expect(existsSync(join(runtimeRoot, 'runtime-manifest.json'))).toBe(true)
    expect(existsSync(join(process.env.HERMES_WEB_UI_HOME!, 'desktop-runtime', 'active-version.json'))).toBe(true)
  })
})
