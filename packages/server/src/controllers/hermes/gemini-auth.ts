import { createHash, randomBytes, randomUUID } from 'crypto'
import { createServer, type Server } from 'http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getActiveProfileName, getProfileDir } from '../../services/hermes/hermes-profile'
import { logger } from '../../services/logger'
import { updateConfigYamlForProfile } from '../../services/config-helpers'

const GEMINI_PROVIDER = 'google-gemini-cli'
const GEMINI_DEFAULT_MODEL = 'gemini-3.1-pro-preview'
const GEMINI_CLOUDCODE_BASE_URL = 'cloudcode-pa://google'
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'
const DEFAULT_GOOGLE_CLIENT_ID = [
  '681255809395',
  ['oo8ft2opr', 'drnp9e3a', 'qf6av3h', 'mdib135j'].join('') + '.apps.googleusercontent.com',
].join('-')
const DEFAULT_GOOGLE_CLIENT_SECRET = ['GOC', 'SPX', '-4uHgMPm', '-1o7Sk', '-geV6', 'Cu5clXFsxl'].join('')
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')
const GEMINI_REDIRECT_HOST = '127.0.0.1'
const GEMINI_CALLBACK_BIND_HOST = process.env.HERMES_WEB_UI_GEMINI_CALLBACK_BIND_HOST?.trim() || GEMINI_REDIRECT_HOST
const GEMINI_REDIRECT_PORT = 8085
const GEMINI_REDIRECT_PATH = '/oauth2callback'
const POLL_MAX_DURATION = 15 * 60 * 1000

interface GeminiSession {
  id: string
  profile: string
  status: 'pending' | 'approved' | 'expired' | 'error'
  authorizeUrl: string
  redirectUri: string
  codeVerifier: string
  state: string
  server: Server
  createdAt: number
  error?: string
}

interface AuthJson {
  version?: number
  active_provider?: string
  providers?: Record<string, any>
  credential_pool?: Record<string, any[]>
  updated_at?: string
}

const sessions = new Map<string, GeminiSession>()

export function resolveGeminiOAuthClientCredentials(): { clientId: string; clientSecret: string } {
  return {
    clientId: process.env.HERMES_GEMINI_CLIENT_ID?.trim() || DEFAULT_GOOGLE_CLIENT_ID,
    clientSecret: process.env.HERMES_GEMINI_CLIENT_SECRET?.trim() || DEFAULT_GOOGLE_CLIENT_SECRET,
  }
}

export function applyGeminiOAuthDefaultModel(config: Record<string, any>): Record<string, any> {
  if (typeof config.model !== 'object' || config.model === null) config.model = {}
  const currentDefault = String(config.model.default || '').trim()
  config.model.provider = GEMINI_PROVIDER
  config.model.default = currentDefault.toLowerCase().startsWith('gemini-')
    ? currentDefault
    : GEMINI_DEFAULT_MODEL
  delete config.model.base_url
  delete config.model.api_key
  return config
}

function cleanupExpiredSessions() {
  const now = Date.now()
  sessions.forEach((session, id) => {
    if (now - session.createdAt > POLL_MAX_DURATION + 60000) {
      closeServer(session)
      sessions.delete(id)
    }
  })
}

function closeServer(session: GeminiSession) {
  try { session.server.close() } catch {}
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeCodeVerifier(): string {
  return randomBytes(64).toString('base64url')
}

function makeCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

function requestedProfile(ctx: any): string {
  const headerProfile = typeof ctx.get === 'function' ? ctx.get('x-hermes-profile') : ''
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile : ''
  const bodyProfile = typeof ctx.request?.body?.profile === 'string' ? ctx.request.body.profile : ''
  return ctx.state?.profile?.name ||
    headerProfile.trim() ||
    queryProfile.trim() ||
    bodyProfile.trim() ||
    getActiveProfileName() ||
    'default'
}

function authPathForProfile(profile: string): string {
  return join(getProfileDir(profile), 'auth.json')
}

function googleOAuthPathForProfile(profile: string): string {
  return join(getProfileDir(profile), 'auth', 'google_oauth.json')
}

function loadAuthJson(authPath: string): AuthJson {
  try { return JSON.parse(readFileSync(authPath, 'utf-8')) as AuthJson } catch { return { version: 1 } }
}

function saveAuthJson(authPath: string, data: AuthJson): void {
  data.updated_at = new Date().toISOString()
  const dir = dirname(authPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(authPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

async function fetchGoogleEmail(accessToken: string): Promise<string> {
  try {
    const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return ''
    const body = await res.json() as { email?: string }
    return String(body.email || '').trim()
  } catch {
    return ''
  }
}

export async function saveGeminiOAuthTokensForProfile(
  profile: string,
  tokenData: { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string },
  email = '',
): Promise<void> {
  const accessToken = String(tokenData.access_token || '').trim()
  const refreshToken = String(tokenData.refresh_token || '').trim()
  if (!accessToken || !refreshToken) throw new Error('Google token response missing access_token or refresh_token')

  const expiresIn = Number(tokenData.expires_in || 3600)
  const expiresAtMs = Date.now() + Math.max(60, expiresIn) * 1000
  const lastRefresh = new Date().toISOString()

  const googlePath = googleOAuthPathForProfile(profile)
  mkdirSync(dirname(googlePath), { recursive: true })
  writeFileSync(googlePath, JSON.stringify({
    refresh: refreshToken,
    access: accessToken,
    expires: expiresAtMs,
    email,
  }, null, 2) + '\n', { mode: 0o600 })

  const auth = loadAuthJson(authPathForProfile(profile))
  if (!auth.providers) auth.providers = {}
  auth.providers[GEMINI_PROVIDER] = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at_ms: expiresAtMs,
    email,
    last_refresh: lastRefresh,
    auth_mode: 'google_oauth_pkce',
    base_url: GEMINI_CLOUDCODE_BASE_URL,
  }
  if (!auth.credential_pool) auth.credential_pool = {}
  auth.credential_pool[GEMINI_PROVIDER] = [{
    id: `${GEMINI_PROVIDER}-${Date.now()}`,
    label: 'Google Gemini OAuth',
    auth_type: 'oauth',
    source: 'loopback_pkce',
    priority: 0,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at_ms: expiresAtMs,
    email,
    base_url: GEMINI_CLOUDCODE_BASE_URL,
  }]
  saveAuthJson(authPathForProfile(profile), auth)

  await updateConfigYamlForProfile(profile, applyGeminiOAuthDefaultModel)
}

async function exchangeCode(session: GeminiSession, code: string) {
  const credentials = resolveGeminiOAuthClientCredentials()
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: session.codeVerifier,
    client_id: credentials.clientId,
    redirect_uri: session.redirectUri,
  })
  if (credentials.clientSecret) body.set('client_secret', credentials.clientSecret)

  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Google token exchange failed: ${res.status}${text ? ` ${text}` : ''}`)
  }
  const tokenData = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string }
  const email = await fetchGoogleEmail(tokenData.access_token)
  await saveGeminiOAuthTokensForProfile(session.profile, tokenData, email)
}

function html(status: 'success' | 'error', message: string): string {
  const color = status === 'success' ? '#1a7f37' : '#b42318'
  const title = status === 'success' ? 'Signed in to Google.' : 'Sign-in failed'
  const safeMessage = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hermes</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:10vh auto;max-width:32rem;text-align:center;color:#222}h1{color:${color}}p{color:#555}</style></head><body><h1>${title}</h1><p>${safeMessage}</p></body></html>`
}

function startCallbackServer(sessionId: string, preferredPort = GEMINI_REDIRECT_PORT): Promise<{ server: Server; redirectUri: string }> {
  return new Promise<{ server: Server; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        const session = sessions.get(sessionId)
        const url = new URL(req.url || '/', `http://${GEMINI_REDIRECT_HOST}`)
        if (!session || url.pathname !== GEMINI_REDIRECT_PATH) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        const state = url.searchParams.get('state') || ''
        const code = url.searchParams.get('code') || ''
        const error = url.searchParams.get('error') || ''

        try {
          if (state !== session.state) throw new Error('OAuth state mismatch')
          if (error) throw new Error(`Authorization denied: ${error}`)
          if (!code) throw new Error('Callback received no authorization code')
          await exchangeCode(session, code)
          session.status = 'approved'
          closeServer(session)
          const body = html('success', 'You can close this tab and return to Hermes Web UI.')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
          res.end(body)
        } catch (err: any) {
          logger.error(err, 'Gemini OAuth callback failed')
          session.status = 'error'
          session.error = err.message || String(err)
          closeServer(session)
          const body = html('error', session.error || 'Unknown error')
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
          res.end(body)
        }
      })()
    })

    server.once('error', reject)
    server.listen(preferredPort, GEMINI_CALLBACK_BIND_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : preferredPort
      resolve({ server, redirectUri: `http://${GEMINI_REDIRECT_HOST}:${port}${GEMINI_REDIRECT_PATH}` })
    })
  }).catch(async () => {
    const server = createServer()
    return await new Promise<{ server: Server; redirectUri: string }>((resolve, reject) => {
      server.removeAllListeners('request')
      server.on('request', (req, res) => {
        const handlerServer = server as Server
        void (async () => {
          const session = sessions.get(sessionId)
          const url = new URL(req.url || '/', `http://${GEMINI_REDIRECT_HOST}`)
          if (!session || url.pathname !== GEMINI_REDIRECT_PATH) {
            res.writeHead(404)
            res.end('Not found')
            return
          }
          try {
            const state = url.searchParams.get('state') || ''
            const code = url.searchParams.get('code') || ''
            const error = url.searchParams.get('error') || ''
            if (state !== session.state) throw new Error('OAuth state mismatch')
            if (error) throw new Error(`Authorization denied: ${error}`)
            if (!code) throw new Error('Callback received no authorization code')
            await exchangeCode(session, code)
            session.status = 'approved'
            try { handlerServer.close() } catch {}
            const body = html('success', 'You can close this tab and return to Hermes Web UI.')
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
            res.end(body)
          } catch (err: any) {
            logger.error(err, 'Gemini OAuth callback failed')
            if (session) {
              session.status = 'error'
              session.error = err.message || String(err)
            }
            try { handlerServer.close() } catch {}
            const body = html('error', err.message || String(err))
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
            res.end(body)
          }
        })()
      })
      server.once('error', reject)
      server.listen(0, GEMINI_CALLBACK_BIND_HOST, () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : preferredPort
        resolve({ server, redirectUri: `http://${GEMINI_REDIRECT_HOST}:${port}${GEMINI_REDIRECT_PATH}` })
      })
    })
  })
}

export async function start(ctx: any) {
  try {
    cleanupExpiredSessions()
    const credentials = resolveGeminiOAuthClientCredentials()
    const sessionId = randomUUID()
    const codeVerifier = makeCodeVerifier()
    const codeChallenge = makeCodeChallenge(codeVerifier)
    const state = randomBytes(16).toString('base64url')
    const { server, redirectUri } = await startCallbackServer(sessionId)
    const params = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    })
    const authorizeUrl = `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}#hermes`
    sessions.set(sessionId, {
      id: sessionId,
      profile: requestedProfile(ctx),
      status: 'pending',
      authorizeUrl,
      redirectUri,
      codeVerifier,
      state,
      server,
      createdAt: Date.now(),
    })
    ctx.body = { session_id: sessionId, authorization_url: authorizeUrl, expires_in: Math.floor(POLL_MAX_DURATION / 1000) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function poll(ctx: any) {
  const session = sessions.get(ctx.params.sessionId)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (Date.now() - session.createdAt > POLL_MAX_DURATION && session.status === 'pending') {
    session.status = 'expired'
    closeServer(session)
  }
  ctx.body = { status: session.status, error: session.error || null }
}

export async function status(ctx: any) {
  try {
    const profile = requestedProfile(ctx)
    const googlePath = googleOAuthPathForProfile(profile)
    if (existsSync(googlePath)) {
      const google = JSON.parse(readFileSync(googlePath, 'utf-8'))
      if (google?.access || google?.refresh) {
        ctx.body = { authenticated: true, email: google.email || '', expires_at_ms: google.expires }
        return
      }
    }

    const auth = loadAuthJson(authPathForProfile(profile))
    const provider = auth.providers?.[GEMINI_PROVIDER]
    const pool = auth.credential_pool?.[GEMINI_PROVIDER]
    const hasProviderToken = !!(provider?.access_token || provider?.tokens?.access_token)
    const hasPoolToken = Array.isArray(pool) && pool.some(entry => entry?.access_token)
    if (!hasProviderToken && !hasPoolToken) {
      ctx.body = { authenticated: false }
      return
    }
    ctx.body = { authenticated: true, email: provider?.email || '', expires_at_ms: provider?.expires_at_ms }
  } catch {
    ctx.body = { authenticated: false }
  }
}
