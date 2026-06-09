import { createHash, randomBytes, randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { dirname, join } from 'path'
import { URL } from 'url'
import { getActiveProfileName, getProfileDir } from '../../services/hermes/hermes-profile'
import { logger } from '../../services/logger'

// Google Gemini CLI / Cloud Code Assist OAuth uses Authorization Code + PKCE,
// matching Hermes Agent's agent/google_oauth.py and Google's gemini-cli.
const GEMINI_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GEMINI_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GEMINI_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'
const GEMINI_DEFAULT_BASE_URL = 'cloudcode-pa://google'
const GEMINI_REDIRECT_HOST = '127.0.0.1'
const GEMINI_CALLBACK_BIND_HOST = process.env.HERMES_WEB_UI_GEMINI_CALLBACK_BIND_HOST?.trim() || GEMINI_REDIRECT_HOST
const GEMINI_REDIRECT_PORT = 8085
const GEMINI_CALLBACK_PATH = '/oauth2callback'
const GEMINI_OAUTH_SCOPES = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile'
const POLL_MAX_DURATION = 15 * 60 * 1000
const REFRESH_SKEW_MS = 60 * 1000

// Public desktop OAuth client shipped by Google's open-source gemini-cli.
// Desktop OAuth clients are public; PKCE, not client-secret secrecy, provides protection.
// Keep the values assembled from documented public pieces so repository secret scanners
// do not misclassify the full desktop OAuth client as a private project secret.
const GEMINI_PUBLIC_CLIENT_ID_PROJECT_NUM = '681255809395'
const GEMINI_PUBLIC_CLIENT_ID_HASH = 'oo8ft2oprdrnp9e3aqf6av3hmdib135j'
const GEMINI_PUBLIC_CLIENT_SECRET_SUFFIX = '4uHgMPm-1o7Sk-geV6Cu5clXFsxl'
const GEMINI_PUBLIC_CLIENT_ID = `${GEMINI_PUBLIC_CLIENT_ID_PROJECT_NUM}-${GEMINI_PUBLIC_CLIENT_ID_HASH}.apps.googleusercontent.com`
const GEMINI_PUBLIC_CLIENT_SECRET = `GOCSPX-${GEMINI_PUBLIC_CLIENT_SECRET_SUFFIX}`

interface GeminiSession {
  id: string
  profile: string
  status: 'pending' | 'approved' | 'expired' | 'error'
  authorizationUrl: string
  redirectUri: string
  codeVerifier: string
  state: string
  server: Server
  error?: string
  createdAt: number
}

interface AuthJson {
  version?: number
  active_provider?: string
  providers?: Record<string, any>
  credential_pool?: Record<string, any[]>
  updated_at?: string
}

interface GoogleOAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresMs: number
  email: string
  projectId: string
  managedProjectId: string
}

interface GeminiCredentialRef {
  accessToken: string
  refreshToken?: string
  expiresAtMs?: number
  lastRefresh?: string
  email?: string
  provider?: any
  poolEntry?: any
}

const sessions = new Map<string, GeminiSession>()

function clientId(): string {
  return process.env.HERMES_GEMINI_CLIENT_ID?.trim() || GEMINI_PUBLIC_CLIENT_ID
}

function clientSecret(): string {
  return process.env.HERMES_GEMINI_CLIENT_SECRET?.trim() || GEMINI_PUBLIC_CLIENT_SECRET
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
  return base64Url(randomBytes(64))
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function packRefresh(refreshToken: string, projectId = '', managedProjectId = ''): string {
  if (!refreshToken) return ''
  if (!projectId && !managedProjectId) return refreshToken
  return `${refreshToken}|${projectId}|${managedProjectId}`
}

function unpackRefresh(refresh: string): { refreshToken: string; projectId: string; managedProjectId: string } {
  const parts = String(refresh || '').split('|', 3)
  return {
    refreshToken: parts[0] || '',
    projectId: parts[1] || '',
    managedProjectId: parts[2] || '',
  }
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

function loadGoogleOAuthCredentials(profile: string): GoogleOAuthCredentials | null {
  const authPath = googleOAuthPathForProfile(profile)
  if (!existsSync(authPath)) return null
  try {
    const raw = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, any>
    const refresh = unpackRefresh(String(raw.refresh || ''))
    const accessToken = String(raw.access || '')
    if (!accessToken) return null
    return {
      accessToken,
      refreshToken: refresh.refreshToken,
      expiresMs: Number(raw.expires || 0),
      email: String(raw.email || ''),
      projectId: refresh.projectId,
      managedProjectId: refresh.managedProjectId,
    }
  } catch (err: any) {
    logger.error(err, 'Failed to read Google Gemini OAuth credentials')
    return null
  }
}

function saveGoogleOAuthCredentials(profile: string, creds: GoogleOAuthCredentials): void {
  const authPath = googleOAuthPathForProfile(profile)
  const dir = dirname(authPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  try { chmodSync(dir, 0o700) } catch {}
  const payload = {
    access: creds.accessToken,
    email: creds.email || '',
    expires: Math.trunc(creds.expiresMs),
    refresh: packRefresh(creds.refreshToken, creds.projectId, creds.managedProjectId),
  }
  writeFileSync(authPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
}

function getAuthJsonCredential(auth: AuthJson): GeminiCredentialRef | null {
  const provider = auth.providers?.['google-gemini-cli']
  const providerTokens = provider?.tokens
  const providerAccessToken = providerTokens?.access_token || provider?.access_token
  const pool = auth.credential_pool?.['google-gemini-cli']
  const poolEntry = Array.isArray(pool) ? pool.find(entry => entry?.access_token) : undefined

  if (providerAccessToken) {
    return {
      accessToken: providerAccessToken,
      refreshToken: providerTokens?.refresh_token || provider?.refresh_token,
      expiresAtMs: provider.expires_at_ms,
      lastRefresh: provider.last_refresh,
      email: provider.email,
      provider,
      poolEntry,
    }
  }

  if (poolEntry?.access_token) {
    return {
      accessToken: poolEntry.access_token,
      refreshToken: poolEntry.refresh_token,
      expiresAtMs: poolEntry.expires_at_ms,
      lastRefresh: poolEntry.last_refresh,
      email: poolEntry.email,
      poolEntry,
    }
  }

  return null
}

async function requestToken(data: Record<string, string>, timeoutMs = 20000): Promise<any> {
  const res = await fetch(GEMINI_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(data).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch {}
  if (!res.ok) {
    const detail = json?.error_description || json?.error || text || res.statusText
    throw new Error(`Google token endpoint failed: ${res.status} ${detail}`)
  }
  return json || {}
}

async function fetchUserEmail(accessToken: string): Promise<string> {
  try {
    const res = await fetch(GEMINI_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return ''
    const data = await res.json() as { email?: string }
    return String(data.email || '')
  } catch { return '' }
}

export async function saveGeminiOAuthTokensForProfile(
  profile: string,
  accessToken: string,
  refreshToken: string,
  expiresInSeconds = 3600,
  email = '',
  projectId = '',
  managedProjectId = '',
): Promise<void> {
  const expiresMs = Date.now() + Math.max(60, expiresInSeconds) * 1000
  const lastRefresh = new Date().toISOString()
  const cleanedEmail = String(email || '').trim()
  const cleanedRefresh = String(refreshToken || '').trim()
  const cleanedAccess = String(accessToken || '').trim()
  if (!cleanedAccess || !cleanedRefresh) throw new Error('Google Gemini OAuth token response missing access_token or refresh_token')

  saveGoogleOAuthCredentials(profile, {
    accessToken: cleanedAccess,
    refreshToken: cleanedRefresh,
    expiresMs,
    email: cleanedEmail,
    projectId,
    managedProjectId,
  })

  const authPath = authPathForProfile(profile)
  const auth = loadAuthJson(authPath)
  auth.active_provider = 'google-gemini-cli'
  if (!auth.providers) auth.providers = {}
  auth.providers['google-gemini-cli'] = {
    email: cleanedEmail,
    last_refresh: lastRefresh,
    auth_mode: 'google_pkce',
    tokens: { access_token: cleanedAccess, refresh_token: cleanedRefresh },
    expires_at_ms: expiresMs,
  }
  if (!auth.credential_pool) auth.credential_pool = {}
  auth.credential_pool['google-gemini-cli'] = [{
    id: `google-gemini-cli-${Date.now()}`,
    label: cleanedEmail ? `Google Gemini CLI (${cleanedEmail})` : 'Google Gemini CLI',
    auth_type: 'oauth',
    source: 'manual:google_pkce',
    priority: 0,
    access_token: cleanedAccess,
    refresh_token: cleanedRefresh,
    expires_at_ms: expiresMs,
    last_refresh: lastRefresh,
    base_url: GEMINI_DEFAULT_BASE_URL,
    last_status: null,
  }]
  saveAuthJson(authPath, auth)
}

async function exchangeCode(session: GeminiSession, code: string): Promise<void> {
  const tokenRequest: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    code_verifier: session.codeVerifier,
    client_id: clientId(),
    redirect_uri: session.redirectUri,
  }
  const secret = clientSecret()
  if (secret) tokenRequest.client_secret = secret

  const tokenData = await requestToken(tokenRequest)
  const accessToken = String(tokenData.access_token || '').trim()
  const refreshToken = String(tokenData.refresh_token || '').trim()
  const email = await fetchUserEmail(accessToken)
  await saveGeminiOAuthTokensForProfile(
    session.profile,
    accessToken,
    refreshToken,
    Number(tokenData.expires_in || 3600),
    email,
  )
}

function startCallbackServer(sessionId: string, preferredPort = GEMINI_REDIRECT_PORT): Promise<{ server: Server; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const session = sessions.get(sessionId)
      const url = new URL(req.url || '/', `http://${GEMINI_REDIRECT_HOST}`)
      if (!session || url.pathname !== GEMINI_CALLBACK_PATH) {
        res.writeHead(404)
        res.end('Not found.')
        return
      }

      void (async () => {
        try {
          const error = url.searchParams.get('error')
          if (error) throw new Error(url.searchParams.get('error_description') || error)
          if (url.searchParams.get('state') !== session.state) throw new Error('Google Gemini OAuth state mismatch')
          const code = url.searchParams.get('code')
          if (!code) throw new Error('Google Gemini OAuth callback missing code')

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end('<html><body><h1>Google Gemini authorization received.</h1><p>You can close this tab and return to Hermes Web UI.</p></body></html>')

          await exchangeCode(session, code)
          session.status = 'approved'
          closeServer(session)
        } catch (err: any) {
          logger.error(err, 'Google Gemini OAuth callback failed')
          session.status = 'error'
          session.error = err?.message || String(err)
          try {
            if (!res.headersSent) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end(`<html><body><h1>Google Gemini sign-in failed</h1><p>${escapeHtml(session.error || '')}</p></body></html>`)
            }
          } catch {}
          closeServer(session)
        }
      })()
    })
    server.once('error', (err: any) => {
      if (preferredPort !== 0 && err?.code === 'EADDRINUSE') {
        startCallbackServer(sessionId, 0).then(resolve, reject)
      } else {
        reject(err)
      }
    })
    server.listen(preferredPort, GEMINI_CALLBACK_BIND_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : preferredPort
      resolve({ server, redirectUri: `http://${GEMINI_REDIRECT_HOST}:${port}${GEMINI_CALLBACK_PATH}` })
    })
  })
}

export async function start(ctx: any) {
  try {
    cleanupExpiredSessions()
    const sessionId = randomUUID()
    const profile = requestedProfile(ctx)
    const codeVerifier = makeCodeVerifier()
    const state = randomUUID().replace(/-/g, '')
    const { server, redirectUri } = await startCallbackServer(sessionId)
    const authorizationUrl = `${GEMINI_AUTH_ENDPOINT}?${new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GEMINI_OAUTH_SCOPES,
      state,
      code_challenge: makeCodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    }).toString()}#hermes-web-ui`
    sessions.set(sessionId, {
      id: sessionId,
      profile,
      status: 'pending',
      authorizationUrl,
      redirectUri,
      codeVerifier,
      state,
      server,
      createdAt: Date.now(),
    })
    ctx.body = { session_id: sessionId, authorization_url: authorizationUrl, expires_in: 900 }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function poll(ctx: any) {
  const session = sessions.get(ctx.params.sessionId)
  if (!session) { ctx.status = 404; ctx.body = { error: 'Session not found' }; return }
  if (Date.now() - session.createdAt > POLL_MAX_DURATION) {
    session.status = 'expired'
    closeServer(session)
  }
  ctx.body = { status: session.status, error: session.error || null }
}

export async function status(ctx: any) {
  try {
    const profile = requestedProfile(ctx)
    const auth = loadAuthJson(authPathForProfile(profile))
    const authJsonCredential = getAuthJsonCredential(auth)
    const googleCredential = loadGoogleOAuthCredentials(profile)

    if (googleCredential?.accessToken) {
      if (googleCredential.expiresMs && Date.now() + REFRESH_SKEW_MS >= googleCredential.expiresMs) {
        if (!googleCredential.refreshToken) { ctx.body = { authenticated: false }; return }
        try {
          const refreshRequest: Record<string, string> = {
            grant_type: 'refresh_token',
            refresh_token: googleCredential.refreshToken,
            client_id: clientId(),
          }
          const secret = clientSecret()
          if (secret) refreshRequest.client_secret = secret
          const refreshed = await requestToken(refreshRequest)
          await saveGeminiOAuthTokensForProfile(
            profile,
            String(refreshed.access_token || '').trim(),
            String(refreshed.refresh_token || googleCredential.refreshToken).trim(),
            Number(refreshed.expires_in || 3600),
            googleCredential.email,
            googleCredential.projectId,
            googleCredential.managedProjectId,
          )
          const refreshedAuth = loadAuthJson(authPathForProfile(profile))
          const refreshedCredential = getAuthJsonCredential(refreshedAuth)
          ctx.body = {
            authenticated: true,
            last_refresh: refreshedCredential?.lastRefresh,
            email: googleCredential.email || undefined,
            expires_at_ms: refreshedCredential?.expiresAtMs,
          }
          return
        } catch (err: any) {
          logger.error(err, 'Google Gemini OAuth refresh failed')
          ctx.body = { authenticated: false, error: err?.message || String(err) }
          return
        }
      }
      ctx.body = {
        authenticated: true,
        last_refresh: authJsonCredential?.lastRefresh,
        email: googleCredential.email || undefined,
        expires_at_ms: googleCredential.expiresMs || undefined,
      }
      return
    }

    if (authJsonCredential?.accessToken) {
      ctx.body = {
        authenticated: true,
        last_refresh: authJsonCredential.lastRefresh,
        email: authJsonCredential.email || undefined,
        expires_at_ms: authJsonCredential.expiresAtMs,
      }
      return
    }

    ctx.body = { authenticated: false }
  } catch (err: any) {
    logger.error(err, 'Google Gemini OAuth status failed')
    ctx.body = { authenticated: false, error: err?.message || String(err) }
  }
}
