import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { checkToken, recordTokenFailure, extractIp } from './login-limiter'
import { config } from '../config'

const APP_HOME = config.appHome
const TOKEN_FILE = join(APP_HOME, '.token')
const GROUP_CHAT_LOCAL_IDENTITY_SECRET_FILE = join(APP_HOME, '.group-chat-local-identity-secret')

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code
}

/**
 * Get or create the auth token.
 */
export async function getToken(): Promise<string> {
  if (process.env.AUTH_TOKEN) {
    return process.env.AUTH_TOKEN
  }

  try {
    const token = await readFile(TOKEN_FILE, 'utf-8')
    return token.trim()
  } catch {
    const token = generateToken()
    await mkdir(APP_HOME, { recursive: true })
    // Only set mode on Unix systems (Windows ignores this)
    const options: { mode?: number } = {}
    if (process.platform !== 'win32') {
      options.mode = 0o600
    }
    await writeFile(TOKEN_FILE, token + '\n', options)
    return token
  }
}

let groupChatLocalIdentitySecretPromise: Promise<string> | null = null

async function readOrCreateGroupChatLocalIdentitySecret(): Promise<string> {
  if (process.env.GROUP_CHAT_LOCAL_IDENTITY_SECRET) {
    const configured = process.env.GROUP_CHAT_LOCAL_IDENTITY_SECRET
    if (!/^[0-9a-f]{64}$/i.test(configured)) {
      throw new Error('GROUP_CHAT_LOCAL_IDENTITY_SECRET must be exactly 32 bytes encoded as 64 hex characters')
    }
    return configured
  }
  try {
    const secret = (await readFile(GROUP_CHAT_LOCAL_IDENTITY_SECRET_FILE, 'utf-8')).trim()
    if (!/^[0-9a-f]{64}$/i.test(secret)) {
      throw new Error(`Invalid group chat local identity secret at ${GROUP_CHAT_LOCAL_IDENTITY_SECRET_FILE}`)
    }
    return secret
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
  }

  const secret = generateToken()
  await mkdir(APP_HOME, { recursive: true })
  const options: { flag: 'wx'; mode?: number } = { flag: 'wx' }
  if (process.platform !== 'win32') options.mode = 0o600
  try {
    await writeFile(GROUP_CHAT_LOCAL_IDENTITY_SECRET_FILE, secret + '\n', options)
    return secret
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'EEXIST')) throw error
    const existing = (await readFile(GROUP_CHAT_LOCAL_IDENTITY_SECRET_FILE, 'utf-8')).trim()
    if (!/^[0-9a-f]{64}$/i.test(existing)) {
      throw new Error(`Invalid group chat local identity secret at ${GROUP_CHAT_LOCAL_IDENTITY_SECRET_FILE}`)
    }
    return existing
  }
}

export function getGroupChatLocalIdentitySecret(): Promise<string> {
  groupChatLocalIdentitySecretPromise ??= readOrCreateGroupChatLocalIdentitySecret()
  return groupChatLocalIdentitySecretPromise
}

/**
 * Koa middleware: check Authorization header or query token.
 * No path whitelisting — applied globally after public routes.
 */
export function requireAuth(token: string | null) {
  return async (ctx: any, next: () => Promise<void>) => {
    const auth = ctx.headers.authorization || ''
    const provided = auth.startsWith('Bearer ')
      ? auth.slice(7)
      : (ctx.query.token as string) || ''

    if (!provided || provided !== token) {
      // Skip auth for non-API paths (SPA static files)
      const lowerPath = ctx.path.toLowerCase()
      if (!lowerPath.startsWith('/api') && !lowerPath.startsWith('/v1') && !lowerPath.startsWith('/upload')) {
        await next()
        return
      }

      // Check rate limiter for token auth failures (separate IP counters from password login)
      const ip = extractIp(ctx)
      const result = checkToken(ip)
      if (!result.allowed) {
        ctx.status = result.status
        ctx.set('Content-Type', 'application/json')
        ctx.body = { error: 'Too many login attempts, please try again later' }
        return
      }

      recordTokenFailure(ip)
      ctx.status = 401
      ctx.set('Content-Type', 'application/json')
      ctx.body = { error: 'Unauthorized' }
      return
    }

    await next()
  }
}
