import Router from '@koa/router'
import { execFile } from 'child_process'
import { promisify } from 'util'

export const auroraExternalOpenRoutes = new Router()

const execFileAsync = promisify(execFile)
const MAX_URL_LENGTH = 2048
const ALLOWED_TRADINGVIEW_HOSTS = new Set(['tradingview.com', 'www.tradingview.com'])

function normalizeTradingViewUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    if (!ALLOWED_TRADINGVIEW_HOSTS.has(url.hostname.toLowerCase())) return null
    return url.toString()
  } catch {
    return null
  }
}

async function openUrl(url: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [url], { timeout: 5000, windowsHide: true })
    return
  }

  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', url], { timeout: 5000, windowsHide: true })
    return
  }

  await execFileAsync('xdg-open', [url], { timeout: 5000, windowsHide: true })
}

auroraExternalOpenRoutes.post('/api/aurora/open-external', async (ctx) => {
  const url = normalizeTradingViewUrl((ctx.request.body as any)?.url)
  if (!url) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'Only HTTPS TradingView URLs can be opened externally.' }
    return
  }

  try {
    await openUrl(url)
    ctx.body = { ok: true, url }
  } catch (error) {
    ctx.status = 500
    ctx.body = {
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to open the system browser.',
    }
  }
})
