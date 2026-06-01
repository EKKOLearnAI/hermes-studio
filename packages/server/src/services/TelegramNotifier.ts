import * as https from 'node:https'

export interface TelegramNotifierOptions {
  token?: string | null
  chatId?: string | null
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'
  fallbackMessage?: string
  disableWebPagePreview?: boolean
  timeoutMs?: number
}

export type TelegramBroadcastMode = 'plain' | 'premium_quant_alert'

export interface TelegramPremiumQuantAlert {
  ticker?: string | null
  action?: string | null
  score?: number | string | null
  price?: number | string | null
  insight: string
  riskBlock?: string | null
  title?: string
  disclaimer?: string
}

export interface TelegramNotifierResult {
  ok: boolean
  skipped: boolean
  chatId?: string
  statusCode?: number
  error?: string
  code?: string
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TELEGRAM_TEXT_LENGTH = 3900
const DEFAULT_PREMIUM_TITLE = '🔔 Hermes AI 量化視野：市場異動警示'
const DEFAULT_PREMIUM_DISCLAIMER = '免責聲明：本頻道數據由 Hermes 多智能體 AI 系統自動推演生成，僅供學術研究與量化模型觀察。金融市場具備高度風險，本資訊絕不構成任何投資建議。使用者應自負盈虧與交易風險。'

export class TelegramNotifier {
  static async sendAlert(message: string, options: TelegramNotifierOptions = {}): Promise<boolean> {
    const result = await TelegramNotifier.sendMessage(message, options)
    return result.ok
  }

  static async sendPremiumQuantAlert(alert: TelegramPremiumQuantAlert, options: TelegramNotifierOptions = {}): Promise<TelegramNotifierResult> {
    const message = formatPremiumQuantAlertHtml(alert)
    return TelegramNotifier.sendMessage(message, {
      ...options,
      parseMode: 'HTML',
      disableWebPagePreview: options.disableWebPagePreview ?? true,
      fallbackMessage: formatPremiumQuantAlertPlainText(alert),
    })
  }

  static async sendMessage(message: string, options: TelegramNotifierOptions = {}): Promise<TelegramNotifierResult> {
    const token = options.token || process.env.TELEGRAM_BOT_TOKEN
    const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID
    const requestedParseMode = options.parseMode || 'Markdown'

    if (!token || !chatId) {
      console.warn('[Telegram] 未設定 Token 或 Chat ID，略過推播。')
      return {
        ok: false,
        skipped: true,
        code: 'telegram_not_configured',
        error: 'Telegram token or chat id is missing.',
      }
    }

    const firstAttempt = await TelegramNotifier.postTelegramMessage({
      token,
      chatId,
      message,
      parseMode: requestedParseMode,
      disableWebPagePreview: options.disableWebPagePreview ?? true,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })

    // Telegram parse modes are strict. Retry plain text instead of dropping alerts when
    // Markdown/HTML parsing rejects otherwise valid operational text.
    if (!firstAttempt.ok && requestedParseMode) {
      return TelegramNotifier.postTelegramMessage({
        token,
        chatId,
        message: options.fallbackMessage || stripTelegramHtml(message),
        disableWebPagePreview: options.disableWebPagePreview ?? true,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
    }

    return firstAttempt
  }

  private static postTelegramMessage(input: {
    token: string
    chatId: string
    message: string
    parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'
    disableWebPagePreview: boolean
    timeoutMs: number
  }): Promise<TelegramNotifierResult> {
    return new Promise(resolve => {
      const payload = JSON.stringify({
        chat_id: input.chatId,
        text: input.message.slice(0, MAX_TELEGRAM_TEXT_LENGTH),
        parse_mode: input.parseMode,
        disable_web_page_preview: input.disableWebPagePreview,
      })

      const req = https.request(
        {
          hostname: 'api.telegram.org',
          port: 443,
          path: `/bot${input.token}/sendMessage`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: input.timeoutMs,
        },
        res => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', chunk => {
            body += chunk
          })
          res.on('end', () => {
            const statusCode = res.statusCode || 0
            const parsed = safeJsonParse(body)
            const ok = statusCode === 200 && parsed?.ok !== false
            resolve({
              ok,
              skipped: false,
              chatId: input.chatId,
              statusCode,
              code: ok ? undefined : 'telegram_delivery_failed',
              error: ok ? undefined : parsed?.description || `Telegram delivery failed: HTTP ${statusCode}`,
            })
          })
        }
      )

      req.on('timeout', () => {
        req.destroy(new Error('Telegram request timed out.'))
      })

      req.on('error', error => {
        console.error('[Telegram] 推播失敗:', error)
        resolve({
          ok: false,
          skipped: false,
          chatId: input.chatId,
          code: 'telegram_delivery_failed',
          error: error.message,
        })
      })

      req.write(payload)
      req.end()
    })
  }
}

function safeJsonParse(value: string): { ok?: boolean; description?: string } | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function formatPremiumQuantAlertHtml(alert: TelegramPremiumQuantAlert): string {
  const ticker = normalizeTickerLabel(alert.ticker)
  const action = normalizeDisplayValue(alert.action, 'WATCH')
  const score = formatScore(alert.score)
  const price = formatPrice(alert.price)
  const title = alert.title?.trim() || DEFAULT_PREMIUM_TITLE
  const insight = normalizeTelegramBlock(alert.insight, 1500)
  const riskBlock = normalizeTelegramBlock(alert.riskBlock || '', 900)
  const disclaimer = normalizeTelegramBlock(alert.disclaimer || DEFAULT_PREMIUM_DISCLAIMER, 900)

  return [
    `<b>${escapeHtml(title)}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `🎯 <b>關注標的：</b> #${escapeHtml(ticker)}`,
    `📊 <b>系統判定：</b> ${escapeHtml(action)}訊號確立 (AI 信心指數：${escapeHtml(score)}/100)`,
    `💰 <b>基準進場價：</b> ${escapeHtml(price)}`,
    '',
    '🧠 <b>核心洞察 (AI Insight)：</b>',
    escapeHtml(insight),
    ...(riskBlock
      ? [
          '',
          '🛡️ <b>系統防禦動態：</b>',
          escapeHtml(riskBlock),
        ]
      : []),
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    `<i>${escapeHtml(disclaimer)}</i>`,
  ].join('\n').slice(0, MAX_TELEGRAM_TEXT_LENGTH)
}

export function formatPremiumQuantAlertPlainText(alert: TelegramPremiumQuantAlert): string {
  const ticker = normalizeTickerLabel(alert.ticker)
  const action = normalizeDisplayValue(alert.action, 'WATCH')
  const score = formatScore(alert.score)
  const price = formatPrice(alert.price)
  const insight = normalizeTelegramBlock(alert.insight, 1500)
  const riskBlock = normalizeTelegramBlock(alert.riskBlock || '', 900)
  const disclaimer = normalizeTelegramBlock(alert.disclaimer || DEFAULT_PREMIUM_DISCLAIMER, 900)
  return [
    alert.title?.trim() || DEFAULT_PREMIUM_TITLE,
    '━━━━━━━━━━━━━━━━━━━━',
    `🎯 關注標的：#${ticker}`,
    `📊 系統判定：${action}訊號確立 (AI 信心指數：${score}/100)`,
    `💰 基準進場價：${price}`,
    '',
    '🧠 核心洞察 (AI Insight)：',
    insight,
    ...(riskBlock
      ? [
          '',
          '🛡️ 系統防禦動態：',
          riskBlock,
        ]
      : []),
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    `_${disclaimer}_`,
  ].join('\n').slice(0, MAX_TELEGRAM_TEXT_LENGTH)
}

function normalizeTickerLabel(value: string | null | undefined): string {
  const ticker = String(value || '').trim().replace(/^#/, '').toUpperCase()
  return ticker || 'MARKET'
}

function normalizeDisplayValue(value: string | number | null | undefined, fallback: string): string {
  const normalized = String(value ?? '').trim()
  return normalized || fallback
}

function formatScore(value: number | string | null | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value).toString()
  const normalized = String(value ?? '').trim()
  return normalized || 'N/A'
}

function formatPrice(value: number | string | null | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `$${value.toFixed(2)}`
  const normalized = String(value ?? '').trim()
  if (!normalized) return 'N/A'
  return normalized.startsWith('$') ? normalized : `$${normalized}`
}

function normalizeTelegramBlock(value: string, maxLength: number): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength)
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function stripTelegramHtml(value: string): string {
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
