import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import axios from 'axios'
import { getProfileDir } from './hermes-profile'

export interface WeixinSendResult {
  ok: boolean
  error?: string
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

  const body = JSON.stringify({
    msg: {
      from_user_id: '',
      to_user_id: credentials.homeChannel,
      client_id: `hermes-studio-${Date.now()}`,
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
      return { ok: false, error: String(data.error || data.errmsg || data.ret || data.errcode || 'weixin_send_failed') }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message || 'weixin_send_failed' }
  }
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
