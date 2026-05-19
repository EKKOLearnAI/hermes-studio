import { createHash, randomBytes, randomUUID } from 'crypto'
import { createServer, type Server } from 'http'
import { request as httpsRequest, type RequestOptions } from 'https'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { URL } from 'url'
import { getActiveAuthPath } from '../../services/hermes/hermes-profile'
import { logger } from '../../services/logger'
import { updateConfigYaml } from '../../services/config-helpers'

const XAI_OAUTH_ISSUER = 'https://auth.x.ai'
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1'
const XAI_REDIRECT_HOST = '127.0.0.1'
const XAI_REDIRECT_PORT = 56121
const XAI_REDIRECT_PATH = '/callback'
const POLL_MAX_DURATION = 15 * 60 * 1000

interface XaiSession {
  id: string
  status: 'pending' | 'approved' | 'expired' | 'error'
  authorizeUrl: string
  redirectUri: string
  codeVerifier: string
  state: string
  tokenEndpoint: string
  discovery: Record<string, string>
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

const sessions = new Map<string, XaiSession>()

function cleanupExpiredSessions() {
  const now = Date.now()
  sessions.forEach((session, id) => {
    if (now - session.createdAt > POLL_MAX_DURATION + 60000) {
      closeServer(session)
      sessions.delete(id)
    }
  })
}

function closeServer(session: XaiSession) {
  try { session.server.close() } catch {}
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeCodeVerifier(): string {
  return base64Url(randomBytes(48))
}

function makeCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

function validateXaiEndpoint(raw: string, field: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'https:') throw new Error(`xAI discovery returned non-HTTPS ${field}`)
  const host = url.hostname.toLowerCase()
  if (host !== 'x.ai' && !host.endsWith('.x.ai')) {
    throw new Error(`xAI discovery ${field} host is not on x.ai`)
  }
  return raw
}

async function requestJson(url: string, options: {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
} = {}): Promise<{ status: number; text: string; json: any }> {
  const target = new URL(url)
  const timeoutMs = options.timeoutMs || 15000
  const body = options.body || ''
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers || {}),
  }
  if (body && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(body).toString()

  const requestOptions: RequestOptions = {
    hostname: target.hostname,
    port: Number(target.port || 443),
    path: `${target.pathname}${target.search}`,
    method: options.method || 'GET',
    headers,
    timeout: timeoutMs,
  }

  return await new Promise((resolve, reject) => {
    const req = httpsRequest(requestOptions, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        let json: any = null
        try { json = text ? JSON.parse(text) : null } catch {}
        resolve({ status: res.statusCode || 0, text, json })
      })
    })
    req.once('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)))
    req.once('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function discoverXai(): Promise<Record<string, string>> {
  const res = await requestJson(XAI_OAUTH_DISCOVERY_URL, { timeoutMs: 15000 })
  if (res.status < 200 || res.status >= 300) throw new Error(`xAI discovery failed: ${res.status}`)
  const payload = res.json as Record<string, unknown>
  if (!payload || typeof payload !== 'object') throw new Error('xAI discovery returned invalid JSON')
  const authorizationEndpoint = String(payload.authorization_endpoint || '').trim()
  const tokenEndpoint = String(payload.token_endpoint || '').trim()
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error('xAI discovery missing endpoints')
  return {
    authorization_endpoint: validateXaiEndpoint(authorizationEndpoint, 'authorization_endpoint'),
    token_endpoint: validateXaiEndpoint(tokenEndpoint, 'token_endpoint'),
  }
}

function loadAuthJson(authPath: string): AuthJson {
  try { return JSON.parse(readFileSync(authPath, 'utf-8')) as AuthJson } catch { return { version: 1 } }
}

function saveAuthJson(authPath: string, data: AuthJson): void {
  data.updated_at = new Date().toISOString()
  const dir = authPath.substring(0, authPath.lastIndexOf('/'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(authPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

async function saveTokens(session: XaiSession, tokenData: any) {
  const accessToken = String(tokenData.access_token || '').trim()
  const refreshToken = String(tokenData.refresh_token || '').trim()
  if (!accessToken || !refreshToken) throw new Error('xAI token response missing access_token or refresh_token')

  const lastRefresh = new Date().toISOString()
  const tokens = {
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: String(tokenData.id_token || '').trim(),
    expires_in: tokenData.expires_in,
    token_type: String(tokenData.token_type || 'Bearer').trim() || 'Bearer',
  }

  const authPath = getActiveAuthPath()
  const auth = loadAuthJson(authPath)
  if (!auth.providers) auth.providers = {}
  auth.providers['xai-oauth'] = {
    tokens,
    last_refresh: lastRefresh,
    auth_mode: 'oauth_pkce',
    discovery: session.discovery,
    redirect_uri: session.redirectUri,
  }
  if (!auth.credential_pool) auth.credential_pool = {}
  auth.credential_pool['xai-oauth'] = [{
    id: `xai-oauth-${Date.now()}`,
    label: 'xAI Grok OAuth (SuperGrok Subscription)',
    auth_type: 'oauth',
    source: 'loopback_pkce',
    priority: 0,
    access_token: accessToken,
    refresh_token: refreshToken,
    base_url: XAI_DEFAULT_BASE_URL,
  }]
  saveAuthJson(authPath, auth)

  await updateConfigYaml((config) => {
    if (typeof config.model !== 'object' || config.model === null) config.model = {}
    config.model.provider = 'xai-oauth'
    config.model.default = config.model.default || 'grok-4.3'
    delete config.model.base_url
    delete config.model.api_key
    return config
  })
}

async function exchangeCode(session: XaiSession, code: string) {
  const res = await requestJson(session.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: session.redirectUri,
      client_id: XAI_OAUTH_CLIENT_ID,
      code_verifier: session.codeVerifier,
    }).toString(),
    timeoutMs: 20000,
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`xAI token exchange failed: ${res.status}${res.text ? ` ${res.text}` : ''}`)
  }
  await saveTokens(session, res.json)
}

function startCallbackServer(sessionId: string, preferredPort = XAI_REDIRECT_PORT): Promise<{ server: Server; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const session = sessions.get(sessionId)
      const url = new URL(req.url || '/', `http://${XAI_REDIRECT_HOST}`)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': 'https://auth.x.ai',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        })
        res.end()
        return
      }
      if (!session || url.pathname !== XAI_REDIRECT_PATH) {
        res.writeHead(404)
        res.end('Not found.')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>')

      void (async () => {
        try {
          const error = url.searchParams.get('error')
          if (error) throw new Error(url.searchParams.get('error_description') || error)
          if (url.searchParams.get('state') !== session.state) throw new Error('xAI OAuth state mismatch')
          const code = url.searchParams.get('code')
          if (!code) throw new Error('xAI OAuth callback missing code')
          await exchangeCode(session, code)
          session.status = 'approved'
          closeServer(session)
        } catch (err: any) {
          logger.error(err, 'xAI OAuth callback failed')
          session.status = 'error'
          session.error = err?.message || String(err)
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
    server.listen(preferredPort, XAI_REDIRECT_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : preferredPort
      resolve({ server, redirectUri: `http://${XAI_REDIRECT_HOST}:${port}${XAI_REDIRECT_PATH}` })
    })
  })
}

export async function start(ctx: any) {
  try {
    cleanupExpiredSessions()
    const sessionId = randomUUID()
    const discovery = await discoverXai()
    const codeVerifier = makeCodeVerifier()
    const state = randomUUID().replace(/-/g, '')
    const nonce = randomUUID().replace(/-/g, '')
    const { server, redirectUri } = await startCallbackServer(sessionId)
    const authorizeUrl = `${discovery.authorization_endpoint}?${new URLSearchParams({
      response_type: 'code',
      client_id: XAI_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: XAI_OAUTH_SCOPE,
      code_challenge: makeCodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      plan: 'generic',
      referrer: 'hermes-web-ui',
    }).toString()}`
    sessions.set(sessionId, {
      id: sessionId,
      status: 'pending',
      authorizeUrl,
      redirectUri,
      codeVerifier,
      state,
      tokenEndpoint: discovery.token_endpoint,
      discovery,
      server,
      createdAt: Date.now(),
    })
    ctx.body = { session_id: sessionId, authorization_url: authorizeUrl, expires_in: 900 }
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
    const auth = loadAuthJson(getActiveAuthPath())
    const provider = auth.providers?.['xai-oauth']
    const pool = auth.credential_pool?.['xai-oauth']
    ctx.body = {
      authenticated: !!(
        provider?.tokens?.access_token ||
        provider?.access_token ||
        (Array.isArray(pool) && pool.some((entry: any) => entry?.access_token))
      ),
      last_refresh: provider?.last_refresh,
    }
  } catch {
    ctx.body = { authenticated: false }
  }
}
