import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
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
    const executorPath = join(localAppData, 'hermes', 'tools', 'scaleconnect.exe')
    await mkdir(join(localAppData, 'hermes', 'tools'), { recursive: true })
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
    const { getScaleSyncSettings, updateScaleSyncSettings } = await importService()

    const settings = await updateScaleSyncSettings({
      enabled: true,
      source: 'xiaomihome',
      username: 'user@example.com',
      password: 'secret-password',
      region: 'cn',
      scaleModel: 'yunmai.scales.ms103',
      scaleconnectPath: 'C:\\tools\\SmartScaleConnect.exe',
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

  it('runs SmartScaleConnect from the executor directory so token cache is stable', async () => {
    const executorPath = join(localAppData, 'hermes', 'tools', 'scaleconnect.exe')
    await mkdir(join(localAppData, 'hermes', 'tools'), { recursive: true })
    await writeFile(executorPath, '', 'utf-8')
    execFileAsyncMock.mockResolvedValue({ stdout: '[]', stderr: '' })
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
      expect.any(Array),
      expect.objectContaining({ cwd: join(localAppData, 'hermes', 'tools') }),
    )
  })
})
