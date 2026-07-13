import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
const execFileSyncMock = vi.hoisted(() => vi.fn())
const execFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}))

const originalHermesHome = process.env.HERMES_HOME
const originalLocalAppData = process.env.LOCALAPPDATA
let hermesHome = ''
let localAppData = ''
const executableName = process.platform === 'win32' ? 'scaleconnect.exe' : 'scaleconnect'

function toolsRoot(): string {
  return process.platform === 'win32'
    ? join(localAppData, 'hermes', 'tools')
    : join(hermesHome, 'tools')
}

async function importService() {
  process.env.HERMES_HOME = hermesHome
  process.env.LOCALAPPDATA = localAppData
  return import('../../packages/server/src/services/hermes/scale-sync')
}

describe('scale sync service', () => {
  beforeEach(async () => {
    vi.resetModules()
    execFileMock.mockReset()
    execFileAsyncMock.mockReset()
    execFileSyncMock.mockReset()
    ;(execFileMock as any)[promisify.custom] = execFileAsyncMock
    hermesHome = await mkdtemp(join(tmpdir(), 'hermes-scale-sync-'))
    localAppData = await mkdtemp(join(tmpdir(), 'hermes-scale-tools-'))
    await mkdir(hermesHome, { recursive: true })
  })

  afterEach(async () => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = originalLocalAppData
    await rm(hermesHome, { recursive: true, force: true })
    await rm(localAppData, { recursive: true, force: true })
  })

  it('defaults sync on and auto-detects the local Hermes executor', async () => {
    const executorPath = join(toolsRoot(), executableName)
    await mkdir(toolsRoot(), { recursive: true })
    await writeFile(executorPath, '', 'utf-8')
    const { getScaleSyncSettings } = await importService()

    await expect(getScaleSyncSettings('default')).resolves.toMatchObject({
      enabled: true,
      source: 'xiaomihome',
      region: 'cn',
      scaleModel: 'yunmai.scales.ms103',
      scaleconnectPath: executorPath,
      configured: false,
    })
  }, 20000)

  it('stores Xiaomi credentials locally and only returns masked password state', async () => {
    const executorPath = join(toolsRoot(), executableName)
    await mkdir(toolsRoot(), { recursive: true })
    await writeFile(executorPath, '', 'utf-8')
    const { getScaleSyncSettings, updateScaleSyncSettings } = await importService()

    const settings = await updateScaleSyncSettings({
      enabled: true,
      source: 'xiaomihome',
      username: 'user@example.com',
      password: 'secret-password',
      region: 'cn',
      scaleModel: 'yunmai.scales.ms103',
      scaleconnectPath: executorPath,
    }, 'default')

    expect(settings).toMatchObject({
      enabled: true,
      source: 'xiaomihome',
      username: 'user@example.com',
      hasPassword: true,
      passwordMasked: '********',
      configured: true,
    })
    expect(JSON.stringify(settings)).not.toContain('secret-password')
    expect(await getScaleSyncSettings('default')).toMatchObject({ configured: true, hasPassword: true })
    expect(await readFile(join(hermesHome, '.env'), 'utf-8')).toContain('S400_XIAOMI_PASSWORD=secret-password')
  })

  it('skips sync with a clear reason before SmartScaleConnect is configured', async () => {
    const { runScaleSync, updateScaleSyncSettings } = await importService()
    await updateScaleSyncSettings({ enabled: true, username: 'user@example.com', password: 'secret-password' }, 'default')

    await expect(runScaleSync('default', 'tester')).resolves.toMatchObject({
      status: 'skipped',
      reason: 'missing_scaleconnect_path',
      importedCount: 0,
    })
  })

  it('normalizes Windows proxy registry formats for scaleconnect', async () => {
    const { normalizeWindowsProxyServer } = await importService()

    expect(normalizeWindowsProxyServer('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891')).toBe('http://127.0.0.1:7891')
    expect(normalizeWindowsProxyServer('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('runs trusted SmartScaleConnect with a private temporary config and no secret-bearing argv', async () => {
    const executorPath = join(toolsRoot(), executableName)
    await mkdir(toolsRoot(), { recursive: true })
    await writeFile(executorPath, '', 'utf-8')
    let executionCwd = ''
    execFileAsyncMock.mockImplementation(async (_file: string, args: string[], options: { cwd: string }) => {
      executionCwd = options.cwd
      expect(args).toEqual([])
      const configPath = join(options.cwd, 'scaleconnect.yaml')
      const config = await readFile(configPath, 'utf-8')
      expect(config).toContain('secret-password')
      if (process.platform !== 'win32') {
        expect((await stat(configPath)).mode & 0o777).toBe(0o600)
      }
      return { stdout: '[]', stderr: '' }
    })
    const { runScaleSync, updateScaleSyncSettings } = await importService()
    await updateScaleSyncSettings({
      enabled: true,
      username: 'user@example.com',
      password: 'secret-password',
      scaleconnectPath: executorPath,
    }, 'default')

    await expect(runScaleSync('default', 'tester')).resolves.toMatchObject({ status: 'synced' })
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      executorPath,
      [],
      expect.objectContaining({ cwd: expect.not.stringContaining(toolsRoot()) }),
    )
    await expect(access(executionCwd)).rejects.toThrow()
  })

  it('rejects an executor outside the trusted Hermes tools root', async () => {
    const outsidePath = join(localAppData, executableName)
    await writeFile(outsidePath, '', 'utf-8')
    const { updateScaleSyncSettings } = await importService()

    await expect(updateScaleSyncSettings({ scaleconnectPath: outsidePath }, 'default'))
      .rejects.toThrow('trusted Hermes tools')
  })

  it('rejects an executable with the wrong platform basename inside the trusted root', async () => {
    const wrongPath = join(toolsRoot(), process.platform === 'win32' ? 'python.exe' : 'python')
    await mkdir(toolsRoot(), { recursive: true })
    await writeFile(wrongPath, '', 'utf-8')
    const { updateScaleSyncSettings } = await importService()

    await expect(updateScaleSyncSettings({ scaleconnectPath: wrongPath }, 'default'))
      .rejects.toThrow(executableName)
  })

  it('rejects a trusted-root junction that resolves outside the tools root', async () => {
    const outsideRoot = join(localAppData, 'outside-tools')
    await mkdir(toolsRoot(), { recursive: true })
    await mkdir(outsideRoot, { recursive: true })
    await writeFile(join(outsideRoot, executableName), '', 'utf-8')
    await symlink(outsideRoot, join(toolsRoot(), 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const { updateScaleSyncSettings } = await importService()

    await expect(updateScaleSyncSettings({ scaleconnectPath: join(toolsRoot(), 'escape', executableName) }, 'default'))
      .rejects.toThrow('trusted Hermes tools')
  })

  it('refuses an untrusted executable injected directly into the profile env', async () => {
    const outsidePath = join(localAppData, executableName)
    await writeFile(outsidePath, '', 'utf-8')
    await writeFile(join(hermesHome, '.env'), [
      'S400_SYNC_ENABLED=true',
      'S400_XIAOMI_USERNAME=user@example.com',
      'S400_XIAOMI_PASSWORD=secret-password',
      `S400_SCALECONNECT_PATH=${outsidePath}`,
    ].join('\n'), 'utf-8')
    const { runScaleSync } = await importService()

    await expect(runScaleSync('default', 'tester')).resolves.toMatchObject({
      status: 'failed',
      reason: 'untrusted_scaleconnect_path',
      importedCount: 0,
    })
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('cleans the private config directory and redacts evidence when execution times out', async () => {
    const executorPath = join(toolsRoot(), executableName)
    await mkdir(toolsRoot(), { recursive: true })
    await writeFile(executorPath, '', 'utf-8')
    let executionCwd = ''
    const password = 'secret-"password'
    const escapedPassword = JSON.stringify(password).slice(1, -1)
    execFileAsyncMock.mockImplementation(async (_file: string, args: string[], options: { cwd: string }) => {
      executionCwd = options.cwd
      expect(args).toEqual([])
      throw Object.assign(new Error(`timed out in ${options.cwd} with ${escapedPassword}`), {
        code: 'ETIMEDOUT',
        stderr: `config ${join(options.cwd, 'scaleconnect.yaml')} ${escapedPassword}`,
      })
    })
    const { runScaleSync, updateScaleSyncSettings } = await importService()
    await updateScaleSyncSettings({
      enabled: true,
      username: 'user@example.com',
      password,
      scaleconnectPath: executorPath,
    }, 'default')

    const result = await runScaleSync('default', 'tester')

    expect(result).toMatchObject({ status: 'failed', reason: 'scaleconnect_failed', importedCount: 0 })
    expect(JSON.stringify(result)).not.toContain('secret-')
    expect(JSON.stringify(result)).not.toContain(executionCwd)
    expect(JSON.stringify(result)).not.toContain('scaleconnect.yaml')
    await expect(access(executionCwd)).rejects.toThrow()
  })
})
