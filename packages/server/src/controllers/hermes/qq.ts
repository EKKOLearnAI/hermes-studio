/**
 * QQ Bot QR code onboard controller.
 *
 * Mirrors the weixin controller pattern:
 *   GET  /api/hermes/qq/qrcode        — create bind task, return QR code URL
 *   GET  /api/hermes/qq/qrcode/status — poll bind result
 *   POST /api/hermes/qq/save          — save credentials to .env and restart gateway
 */

import axios from 'axios'
import { readFile, writeFile, chmod } from 'fs/promises'
import crypto from 'crypto'
import YAML from 'js-yaml'
import { restartGateway } from '../../services/hermes/hermes-cli'
import { getActiveConfigPath, getActiveEnvPath } from '../../services/hermes/hermes-profile'

const envPath = () => getActiveEnvPath()
const configYamlPath = () => getActiveConfigPath()

// ---------------------------------------------------------------------------
// In-memory task store (single-user web UI)
// ---------------------------------------------------------------------------
interface QqTask {
  task_id: string
  aes_key: string
  qrcode_url: string
  created_at: number
  status: 'idle' | 'loading' | 'waiting' | 'scanned' | 'confirmed' | 'error' | 'expired'
  app_id?: string
  client_secret?: string
  user_openid?: string
}

const activeTasks: Record<string, QqTask> = {}

// ---------------------------------------------------------------------------
// QQ Open Platform portal API helpers
// ---------------------------------------------------------------------------
const PORTAL_HOST = process.env.QQ_PORTAL_HOST || 'q.qq.com'
const ONBOARD_CREATE_PATH = '/lite/create_bind_task'
const ONBOARD_POLL_PATH = '/lite/poll_bind_result'
const QR_URL_TEMPLATE =
  'https://q.qq.com/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2&source=hermes'

async function createBindTask(): Promise<[string, string]> {
  const url = `https://${PORTAL_HOST}${ONBOARD_CREATE_PATH}`
  const aes_key = Buffer.from(crypto.randomBytes(32)).toString('base64')

  const resp = await axios.post(url, { key: aes_key }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 })
  const data = resp.data

  if (data.retcode !== 0) {
    throw new Error(data.msg || 'create_bind_task failed')
  }

  const task_id = data?.data?.task_id
  if (!task_id) {
    throw new Error('create_bind_task: missing task_id in response')
  }

  return [task_id, aes_key]
}

async function pollBindResult(
  task_id: string,
): Promise<[number, string, string, string]> {
  const url = `https://${PORTAL_HOST}${ONBOARD_POLL_PATH}`

  const resp = await axios.post(url, { task_id }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 })
  const data = resp.data

  if (data.retcode !== 0) {
    throw new Error(data.msg || 'poll_bind_result failed')
  }

  const d = data?.data || {}
  return [
    Number(d.status || 0),
    String(d.bot_appid || ''),
    d.bot_encrypt_secret || '',
    d.user_openid || '',
  ]
}

function decryptSecret(encrypted: string, aesKey: string): string {
  try {
    const key = Buffer.from(aesKey, 'base64')
    const raw = Buffer.from(encrypted, 'base64')
    const iv = raw.subarray(0, 16)
    const ct = raw.subarray(16)

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    const padLen = pt[pt.length - 1]
    return pt.subarray(0, pt.length - padLen).toString('utf-8')
  } catch {
    return encrypted
  }
}

function buildQrUrl(task_id: string): string {
  return QR_URL_TEMPLATE.replace('{task_id}', encodeURIComponent(task_id))
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------
export async function getQrcode(ctx: any) {
  try {
    const [task_id, aes_key] = await createBindTask()
    const qrcode_url = buildQrUrl(task_id)

    activeTasks[task_id] = {
      task_id,
      aes_key,
      qrcode_url,
      created_at: Date.now(),
      status: 'waiting',
    }

    ctx.body = { qrcode: task_id, qrcode_url }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to create QQ bind task' }
  }
}

export async function pollStatus(ctx: any) {
  const task_id = ctx.query.qrcode as string
  if (!task_id) {
    ctx.status = 400
    ctx.body = { error: 'Missing qrcode parameter' }
    return
  }

  const task = activeTasks[task_id]
  if (!task) {
    ctx.status = 404
    ctx.body = { error: 'Task not found or expired' }
    return
  }

  try {
    const [status, app_id, encrypted_secret, user_openid] = await pollBindResult(task_id)

    if (status === 2) {
      const client_secret = decryptSecret(encrypted_secret, task.aes_key)
      task.status = 'confirmed'
      task.app_id = app_id
      task.client_secret = client_secret
      task.user_openid = user_openid
      ctx.body = { status: 'confirmed', app_id, client_secret, user_openid }
    } else if (status === 3) {
      task.status = 'expired'
      ctx.body = { status: 'expired' }
    } else if (status === 1) {
      task.status = 'scanned'
      ctx.body = { status: 'scanned' }
    } else {
      ctx.body = { status: 'wait' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to poll QQ bind status' }
  }
}

export async function save(ctx: any) {
  const { app_id, client_secret } = ctx.request.body as {
    app_id: string
    client_secret: string
  }
  if (!app_id || !client_secret) {
    ctx.status = 400
    ctx.body = { error: 'Missing app_id or client_secret' }
    return
  }

  try {
    // 1. Write .env
    let raw: string
    try {
      raw = await readFile(envPath(), 'utf-8')
    } catch {
      raw = ''
    }

    const entries: Record<string, string> = {
      QQ_APP_ID: app_id,
      QQ_CLIENT_SECRET: client_secret,
    }

    const lines = raw.split('\n')
    const existingKeys = new Set<string>()
    const result: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#')) {
        result.push(line)
        continue
      }
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim()
        if (key in entries) {
          result.push(`${key}=${entries[key]}`)
          existingKeys.add(key)
          continue
        }
      }
      result.push(line)
    }

    for (const [key, val] of Object.entries(entries)) {
      if (!existingKeys.has(key)) {
        result.push(`${key}=${val}`)
      }
    }

    let output = result.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n'
    const ep = envPath()
    await writeFile(ep, output, 'utf-8')
    try {
      await chmod(ep, 0o600)
    } catch {
      /* ignore */
    }

    // 2. Write config.yaml platforms.qq
    try {
      const cfgRaw = await readFile(configYamlPath(), 'utf-8')
      const cfg = (YAML.load(cfgRaw) as Record<string, any>) || {}
      if (!cfg.platforms) cfg.platforms = {}
      if (!cfg.platforms.qq) cfg.platforms.qq = {}
      if (!cfg.platforms.qq.extra) cfg.platforms.qq.extra = {}
      cfg.platforms.qq.enabled = true
      cfg.platforms.qq.extra.app_id = app_id
      cfg.platforms.qq.extra.client_secret = client_secret
      const yamlStr = YAML.dump(cfg, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false })
      await writeFile(configYamlPath(), yamlStr, 'utf-8')
    } catch (yamlErr: any) {
      // .env already written; log but don't fail the request
      console.error('[qq.save] config.yaml write failed:', yamlErr.message)
    }

    await restartGateway()
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
