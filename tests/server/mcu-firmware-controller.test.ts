import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalCwd = process.cwd()
let tempRoot = ''

beforeEach(async () => {
  vi.resetModules()
  tempRoot = ''
})

afterEach(async () => {
  process.chdir(originalCwd)
  vi.unstubAllEnvs()
  vi.resetModules()
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

describe('MCU firmware controller', () => {
  it('serves a version-isolated v1 manifest', async () => {
    tempRoot = await makeTempRoot()
    process.chdir(tempRoot)
    vi.stubEnv('NODE_ENV', 'production')

    const firmware = Buffer.from('firmware-v1')
    await writeFile(path.join(tempRoot, 'dist/mcu/v1/firmware.bin'), firmware)
    const ctrl = await import('../../packages/server/src/controllers/hermes/mcu-firmware')
    const ctx = makeCtx({ version: 'v1' })

    await ctrl.manifest(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(ctx.body).toMatchObject({
      updateAvailable: true,
      target: 'hstudio-esp32-c3',
      channel: 'production',
      firmwareVersion: 'v1',
      size: firmware.length,
      sha256: createHash('sha256').update(firmware).digest('hex'),
      md5: createHash('md5').update(firmware).digest('hex'),
      url: '/api/hermes/mcu/firmware/v1/firmware.bin',
    })
  })

  it('keeps the unversioned manifest pinned to v1 for already-shipped devices', async () => {
    tempRoot = await makeTempRoot()
    process.chdir(tempRoot)
    vi.stubEnv('NODE_ENV', 'production')

    const firmware = Buffer.from('legacy-device-v1')
    await writeFile(path.join(tempRoot, 'dist/mcu/v1/firmware.bin'), firmware)
    const ctrl = await import('../../packages/server/src/controllers/hermes/mcu-firmware')
    const ctx = makeCtx({})

    await ctrl.legacyManifest(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      updateAvailable: true,
      firmwareVersion: 'v1',
      url: '/api/hermes/mcu/firmware/v1/firmware.bin',
      md5: createHash('md5').update(firmware).digest('hex'),
    })
  })

  it('serves v2 from its isolated firmware directory', async () => {
    tempRoot = await makeTempRoot()
    process.chdir(tempRoot)
    vi.stubEnv('NODE_ENV', 'production')

    const firmware = Buffer.from('firmware-v2')
    await writeFile(path.join(tempRoot, 'dist/mcu/v2/firmware.bin'), firmware)
    const ctrl = await import('../../packages/server/src/controllers/hermes/mcu-firmware')
    const ctx = makeCtx({ version: 'v2' })

    await ctrl.manifest(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      updateAvailable: true,
      firmwareVersion: 'v2',
      size: firmware.length,
      md5: createHash('md5').update(firmware).digest('hex'),
      url: '/api/hermes/mcu/firmware/v2/firmware.bin',
    })
  })

  it('rejects unsupported firmware versions', async () => {
    tempRoot = await makeTempRoot()
    process.chdir(tempRoot)
    vi.stubEnv('NODE_ENV', 'production')

    const ctrl = await import('../../packages/server/src/controllers/hermes/mcu-firmware')
    const ctx = makeCtx({ version: 'v3' })

    await ctrl.manifest(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({
      updateAvailable: false,
      error: 'unsupported mcu firmware version',
    })
  })
})

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcu-firmware-'))
  await mkdir(path.join(root, 'dist/mcu/v1'), { recursive: true })
  await mkdir(path.join(root, 'dist/mcu/v2'), { recursive: true })
  return root
}

function makeCtx(params: Record<string, unknown>) {
  return {
    params,
    status: 200,
    body: null as unknown,
    set: vi.fn(),
  } as any
}
