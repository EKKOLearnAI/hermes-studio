import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { config } from '../config'

// Token stored in project data directory
const TOKEN_FILE = join(config.dataDir, '.token')

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Get or create the auth token. Returns null if auth is disabled.
 */
export async function getToken(): Promise<string | null> {
  // Auth can be disabled via env var
  if (process.env.AUTH_DISABLED === '1' || process.env.AUTH_DISABLED === 'true') {
    return null
  }

  // Custom token via env var
  if (process.env.AUTH_TOKEN) {
    return process.env.AUTH_TOKEN
  }

  try {
    const token = await readFile(TOKEN_FILE, 'utf-8')
    return token.trim()
  } catch {
    // Generate a new token
    const token = generateToken()
    await writeFile(TOKEN_FILE, token + '\n', { mode: 0o600 })
    return token
  }
}

/**
 * Koa middleware: check Authorization header for API routes.
 * Skips /health, /webhook, and static file requests.
 */
export async function authMiddleware(token: string | null) {
  return async (ctx: any, next: () => Promise<void>) => {
    // If auth is disabled, skip
    if (!token) {
      await next()
      return
    }

    // Skip non-API paths (static files, health check, SPA)
    const path = ctx.path.toLowerCase()
    if (
      path === '/health' ||
      (!path.startsWith('/api') && !path.startsWith('/v1') && path !== '/webhook' && path !== '/upload')
    ) {
      await next()
      return
    }

    const auth = ctx.headers.authorization || ''
    const provided = auth.startsWith('Bearer ')
      ? auth.slice(7)
      : (ctx.query.token as string) || ''

    if (!provided || provided !== token) {
      ctx.status = 401
      ctx.set('Content-Type', 'application/json')
      ctx.body = { error: 'Unauthorized' }
      return
    }

    await next()
  }
}
