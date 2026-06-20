import type { Context } from 'koa'
import { createReadStream } from 'fs'
import { stat, readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { resolve } from 'path'

interface FirmwareInfo {
  path: string
  channel: 'development' | 'production'
  size: number
  sha256: string
  md5: string
}

const FIRMWARE_ROUTE = '/api/hermes/mcu/firmware.bin'
const DIST_FIRMWARE_PATH = resolve(process.cwd(), 'dist', 'mcu', 'firmware.bin')
const DEV_FIRMWARE_PATH = resolve(
  process.cwd(),
  'packages/esp32-c3/.pio/build/esp32-c3-devkitm-1/firmware.bin',
)

function firmwareSource(): Pick<FirmwareInfo, 'path' | 'channel'> {
  if (process.env.NODE_ENV === 'production') {
    return { path: DIST_FIRMWARE_PATH, channel: 'production' }
  }
  return { path: DEV_FIRMWARE_PATH, channel: 'development' }
}

async function findFirmware(): Promise<FirmwareInfo | null> {
  const source = firmwareSource()
  try {
    const info = await stat(source.path)
    if (!info.isFile()) {
      return null
    }
    const data = await readFile(source.path)
    return {
      path: source.path,
      channel: source.channel,
      size: info.size,
      sha256: createHash('sha256').update(data).digest('hex'),
      md5: createHash('md5').update(data).digest('hex'),
    }
  } catch {
    return null
  }
}

export async function manifest(ctx: Context) {
  const firmware = await findFirmware()
  if (!firmware) {
    ctx.status = 404
    ctx.body = { updateAvailable: false, error: 'mcu firmware not found' }
    return
  }

  ctx.set('Cache-Control', 'no-store')
  ctx.body = {
    updateAvailable: true,
    target: 'hstudio-esp32-c3',
    channel: firmware.channel,
    version: firmware.sha256.slice(0, 12),
    size: firmware.size,
    sha256: firmware.sha256,
    md5: firmware.md5,
    url: FIRMWARE_ROUTE,
  }
}

export async function download(ctx: Context) {
  const firmware = await findFirmware()
  if (!firmware) {
    ctx.status = 404
    ctx.body = { error: 'mcu firmware not found' }
    return
  }

  ctx.set('Content-Type', 'application/octet-stream')
  ctx.set('Content-Length', String(firmware.size))
  ctx.set('Cache-Control', 'no-store')
  ctx.set('X-Firmware-Version', firmware.sha256.slice(0, 12))
  ctx.set('X-Firmware-SHA256', firmware.sha256)
  ctx.set('X-Firmware-MD5', firmware.md5)
  ctx.body = createReadStream(firmware.path)
}
