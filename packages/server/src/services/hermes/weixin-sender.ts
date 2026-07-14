import { createHash, randomUUID } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import axios from 'axios'
import { getProfileDir } from './hermes-profile'
import { isFabricSensitiveString } from './action-fabric/audit'

export interface WeixinSendResult {
  ok: boolean
  error?: string
}

export interface WeixinProviderDelivery {
  status: 'accepted' | 'delivered' | 'unknown'
  providerMessageId: string | null
}
export type WeixinDeliveryLookup = WeixinProviderDelivery | { status: 'not_found'; providerMessageId: null }

export interface WeixinReceiptSender {
  send(request: { deliveryId: string; recipient: 'configured-self'; message: string }): Promise<WeixinProviderDelivery>
  lookup(deliveryId: string): Promise<WeixinDeliveryLookup>
}

interface WeixinCredentials {
  accountId: string
  token: string
  homeChannel: string
  baseUrl: string
}

const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const WEIXIN_SEND_ENDPOINT = 'ilink/bot/sendmessage'
const CHANNEL_VERSION = '2.2.0'
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8)

export function buildWeixinSendUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${WEIXIN_SEND_ENDPOINT}`
}

export async function sendWeixinTextReminder(profile: string, message: string): Promise<WeixinSendResult> {
  const credentials = resolveWeixinCredentials(profile)
  const text = message.trim()
  if (!credentials || !text) return { ok: false, error: 'missing_weixin_credentials' }

  const result = await postWeixinText(credentials, text, `hermes-studio-${Date.now()}`)
  return result.status === 'unknown'
    ? { ok: false, error: result.error ?? 'weixin_send_failed' }
    : { ok: true }
}

/**
 * Receipt-aware transport used by Action Fabric. A durable unknown tombstone is
 * written before network I/O; the stable provider client id is defense in depth.
 */
export function createWeixinReceiptSender(profile: string): WeixinReceiptSender {
  return {
    async send(request) {
      if (request.recipient !== 'configured-self' || !validDeliveryId(request.deliveryId)) {
        return { status: 'unknown', providerMessageId: null }
      }
      const credentials = resolveWeixinCredentials(profile)
      const message = request.message.trim()
      if (!credentials || !message) return { status: 'unknown', providerMessageId: null }
      const materialDigest = createHash('sha256').update(JSON.stringify({
        deliveryId: request.deliveryId, recipient: request.recipient, message,
      })).digest('hex')
      const claim = claimDelivery(profile, request.deliveryId, materialDigest)
      if (!claim.reliable || !claim.claimed) return claim.delivery
      const posted = await postWeixinText(credentials, message, request.deliveryId)
      const safeIdentity = validProviderMessageId(posted.providerMessageId) ? posted.providerMessageId : null
      const delivery: WeixinProviderDelivery = posted.status === 'accepted' && safeIdentity !== null
        ? { status: 'accepted', providerMessageId: safeIdentity }
        : { status: 'unknown', providerMessageId: null }
      return delivery.status === 'accepted'
        ? completeDelivery(profile, request.deliveryId, materialDigest, delivery)
        : delivery
    },
    async lookup(deliveryId) {
      if (!validDeliveryId(deliveryId)) return { status: 'unknown', providerMessageId: null }
      return lookupDelivery(profile, deliveryId)
    },
  }
}

interface DeliveryRow { material_digest: string; status: string; provider_message_id: string | null }

function withDeliveryDb<T>(profile: string, callback: (db: DatabaseSync) => T): T {
  const path = join(getProfileDir(profile || 'default'), 'weixin-deliveries.sqlite')
  mkdirSync(dirname(path), { recursive: true })
  const existed = existsSync(path)
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=1024;')
    db.exec(`CREATE TABLE IF NOT EXISTS weixin_delivery_claims (
      delivery_id TEXT PRIMARY KEY,
      material_digest TEXT NOT NULL CHECK(length(material_digest)=64 AND material_digest NOT GLOB '*[^0-9a-f]*'),
      status TEXT NOT NULL CHECK(status IN ('unknown','accepted','delivered')),
      provider_message_id TEXT,
      claimed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`)
    if (!existed) { try { chmodSync(path, 0o600) } catch { /* profile ACL remains authoritative */ } }
    return callback(db)
  } finally { db.close() }
}

function claimDelivery(profile: string, deliveryId: string, materialDigest: string): {
  reliable: boolean; claimed: boolean; delivery: WeixinProviderDelivery
} {
  try {
    return withDeliveryDb(profile, db => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = db.prepare(`SELECT material_digest,status,provider_message_id
          FROM weixin_delivery_claims WHERE delivery_id=?`).get(deliveryId) as unknown as DeliveryRow | undefined
        if (existing) {
          db.exec('COMMIT')
          if (existing.material_digest !== materialDigest) return { reliable: true, claimed: false,
            delivery: { status: 'unknown', providerMessageId: null } as WeixinProviderDelivery }
          return { reliable: true, claimed: false, delivery: rowDelivery(existing) }
        }
        const now = new Date().toISOString()
        db.prepare(`INSERT INTO weixin_delivery_claims
          (delivery_id,material_digest,status,provider_message_id,claimed_at,updated_at)
          VALUES(?,?,'unknown',NULL,?,?)`).run(deliveryId, materialDigest, now, now)
        db.exec('COMMIT')
        return { reliable: true, claimed: true,
          delivery: { status: 'unknown', providerMessageId: null } as WeixinProviderDelivery }
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error }
    })
  } catch { return { reliable: false, claimed: false, delivery: { status: 'unknown', providerMessageId: null } } }
}

function completeDelivery(profile: string, deliveryId: string, materialDigest: string,
  delivery: WeixinProviderDelivery): WeixinProviderDelivery {
  if (delivery.status !== 'accepted' || !validProviderMessageId(delivery.providerMessageId)) {
    return { status: 'unknown', providerMessageId: null }
  }
  try {
    return withDeliveryDb(profile, db => {
      const changed = db.prepare(`UPDATE weixin_delivery_claims SET status='accepted',provider_message_id=?,updated_at=?
        WHERE delivery_id=? AND material_digest=? AND status='unknown' AND provider_message_id IS NULL`)
        .run(delivery.providerMessageId, new Date().toISOString(), deliveryId, materialDigest)
      return changed.changes === 1 ? delivery : { status: 'unknown', providerMessageId: null }
    })
  } catch { return { status: 'unknown', providerMessageId: null } }
}

function lookupDelivery(profile: string, deliveryId: string): WeixinDeliveryLookup {
  try {
    return withDeliveryDb(profile, db => {
      const row = db.prepare(`SELECT material_digest,status,provider_message_id FROM weixin_delivery_claims
        WHERE delivery_id=?`).get(deliveryId) as unknown as DeliveryRow | undefined
      return row ? rowDelivery(row) : { status: 'not_found', providerMessageId: null }
    })
  } catch { return { status: 'unknown', providerMessageId: null } }
}

function rowDelivery(row: DeliveryRow): WeixinProviderDelivery {
  if ((row.status === 'accepted' || row.status === 'delivered') && validProviderMessageId(row.provider_message_id)) {
    return { status: row.status, providerMessageId: row.provider_message_id }
  }
  return { status: 'unknown', providerMessageId: null }
}

async function postWeixinText(credentials: WeixinCredentials, text: string, clientId: string): Promise<{
  status: 'accepted' | 'unknown'; providerMessageId: string | null; error?: string
}> {

  const body = JSON.stringify({
    msg: {
      from_user_id: '',
      to_user_id: credentials.homeChannel,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [
        {
          type: 1,
          text_item: { text },
        },
      ],
    },
    base_info: { channel_version: CHANNEL_VERSION },
  })

  try {
    const response = await axios.post(buildWeixinSendUrl(credentials.baseUrl), body, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        Authorization: `Bearer ${credentials.token}`,
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomWeixinUin(),
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
      },
    })
    const data = response.data || {}
    if (data.error || data.errcode < 0 || data.ret < 0) {
      return { status: 'unknown', providerMessageId: null,
        error: String(data.error || data.errmsg || data.ret || data.errcode || 'weixin_send_failed') }
    }
    const providerMessageId = typeof data.msgid === 'string' && data.msgid.trim()
      ? data.msgid.trim().slice(0, 256) : null
    return { status: 'accepted', providerMessageId }
  } catch (error: unknown) {
    return { status: 'unknown', providerMessageId: null,
      error: error instanceof Error ? error.message : 'weixin_send_failed' }
  }
}

function validDeliveryId(value: string): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value)
}

function validProviderMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && !isFabricSensitiveString(value)
}

function resolveWeixinCredentials(profile: string): WeixinCredentials | null {
  const env = readProfileEnv(profile)
  const accountId = env.WEIXIN_ACCOUNT_ID?.trim() || ''
  const token = env.WEIXIN_TOKEN?.trim() || ''
  const homeChannel = env.WEIXIN_HOME_CHANNEL?.trim() || ''
  if (!accountId || !token || !homeChannel) return null
  return {
    accountId,
    token,
    homeChannel,
    baseUrl: env.WEIXIN_BASE_URL?.trim() || DEFAULT_ILINK_BASE_URL,
  }
}

function readProfileEnv(profile: string): Record<string, string> {
  const path = join(getProfileDir(profile || 'default'), '.env')
  if (!existsSync(path)) return {}
  const env: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return env
}

function randomWeixinUin(): string {
  return Buffer.from(randomUUID().replace(/-/g, '').slice(0, 10)).toString('base64')
}
