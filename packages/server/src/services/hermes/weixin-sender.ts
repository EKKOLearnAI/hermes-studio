import { randomUUID } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import axios from 'axios'
import { getProfileDir } from './hermes-profile'

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
  const journalPath = join(getProfileDir(profile || 'default'), 'weixin-delivery-attempts.jsonl')
  const journal = readReceiptJournal(journalPath)
  const receipts = journal.receipts
  return {
    async send(request) {
      if (request.recipient !== 'configured-self' || !validDeliveryId(request.deliveryId)) {
        return { status: 'unknown', providerMessageId: null }
      }
      if (!journal.reliable) return { status: 'unknown', providerMessageId: null }
      const existing = receipts.get(request.deliveryId)
      if (existing) return existing
      const credentials = resolveWeixinCredentials(profile)
      const message = request.message.trim()
      if (!credentials || !message) return { status: 'unknown', providerMessageId: null }
      // Persist an unknown tombstone before crossing the network. A restart will
      // query this state and refuse to resend blindly.
      persistReceipt(journalPath, request.deliveryId, { status: 'unknown', providerMessageId: null })
      receipts.set(request.deliveryId, { status: 'unknown', providerMessageId: null })
      const posted = await postWeixinText(credentials, message, request.deliveryId)
      const delivery: WeixinProviderDelivery = posted.status === 'accepted' && posted.providerMessageId !== null
        ? { status: 'accepted', providerMessageId: posted.providerMessageId }
        : { status: 'unknown', providerMessageId: null }
      receipts.set(request.deliveryId, delivery)
      persistReceipt(journalPath, request.deliveryId, delivery)
      return delivery
    },
    async lookup(deliveryId) {
      if (!journal.reliable) return { status: 'unknown', providerMessageId: null }
      return receipts.get(deliveryId) ?? { status: 'not_found', providerMessageId: null }
    },
  }
}

function readReceiptJournal(path: string): { receipts: Map<string, WeixinProviderDelivery>; reliable: boolean } {
  const result = new Map<string, WeixinProviderDelivery>()
  if (!existsSync(path)) return { receipts: result, reliable: true }
  try {
    const content = readFileSync(path, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > 4 * 1024 * 1024) return { receipts: result, reliable: false }
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue
      const item = JSON.parse(line) as { deliveryId?: unknown; status?: unknown; providerMessageId?: unknown }
      if (typeof item.deliveryId !== 'string' || !validDeliveryId(item.deliveryId)
        || !['accepted', 'delivered', 'unknown'].includes(String(item.status))
        || !(item.providerMessageId === null || typeof item.providerMessageId === 'string')) {
        return { receipts: new Map(), reliable: false }
      }
      result.set(item.deliveryId, { status: item.status as WeixinProviderDelivery['status'],
        providerMessageId: item.providerMessageId as string | null })
    }
  } catch { return { receipts: new Map(), reliable: false } }
  return { receipts: result, reliable: true }
}

function persistReceipt(path: string, deliveryId: string, delivery: WeixinProviderDelivery): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify({ deliveryId, ...delivery })}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
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
  } catch (err: any) {
    return { status: 'unknown', providerMessageId: null, error: err.message || 'weixin_send_failed' }
  }
}

function validDeliveryId(value: string): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value)
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
