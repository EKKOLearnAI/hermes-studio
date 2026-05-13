import { randomUUID } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { getActiveAuthPath } from '../../services/hermes/hermes-profile'
import { logger } from '../../services/logger'

// --- OAuth Constants ---
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_DEVICE_AUTH_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const CODEX_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const CODEX_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'
const CODEX_VERIFICATION_URL = 'https://auth.openai.com/codex/device'
const CODEX_HOME = join(homedir(), '.codex')
const POLL_MAX_DURATION = 15 * 60 * 1000
const POLL_DEFAULT_INTERVAL = 5000

// --- Session Store ---
interface CodexSession {
  id: string; userCode: string; deviceAuthId: string
  status: 'pending' | 'approved' | 'expired' | 'error'
  error?: string; accessToken?: string; refreshToken?: string; createdAt: number
}

const sessions = new Map<string, CodexSession>()

function cleanupExpiredSessions() {
  const now = Date.now()
  sessions.forEach((session, id) => { if (now - session.createdAt > POLL_MAX_DURATION + 60000) { sessions.delete(id) } })
}

// --- Auth file helpers ---
interface AuthJson { version?: number; active_provider?: string; providers?: Record<string, any>; credential_pool?: Record<string, any[]>; updated_at?: string }
interface CodexCredentialRef {
  accessToken: string
  refreshToken?: string
  lastRefresh?: string
  provider?: any
  poolEntry?: any
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

function saveCodexCliTokens(accessToken: string, refreshToken: string): void {
  const codexHome = process.env.CODEX_HOME || CODEX_HOME
  const codexAuthPath = join(codexHome, 'auth.json')
  const dir = codexAuthPath.substring(0, codexAuthPath.lastIndexOf('/'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(codexAuthPath, JSON.stringify({ tokens: { access_token: accessToken, refresh_token: refreshToken }, last_refresh: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
}

function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
    const claims = JSON.parse(payload)
    return typeof claims.exp === 'number' ? claims.exp : null
  } catch { return null }
}

function getCodexCredential(auth: AuthJson): CodexCredentialRef | null {
  const provider = auth.providers?.['openai-codex']
  const providerTokens = provider?.tokens
  const providerAccessToken = providerTokens?.access_token || provider?.access_token
  const pool = auth.credential_pool?.['openai-codex']
  const poolEntry = Array.isArray(pool) ? pool.find(entry => entry?.access_token) : undefined

  if (providerAccessToken) {
    return {
      accessToken: providerAccessToken,
      refreshToken: providerTokens?.refresh_token || provider?.refresh_token,
      lastRefresh: provider.last_refresh,
      provider,
      poolEntry,
    }
  }

  if (poolEntry?.access_token) {
    return {
      accessToken: poolEntry.access_token,
      refreshToken: poolEntry.refresh_token,
      lastRefresh: poolEntry.last_refresh,
      poolEntry,
    }
  }

  return null
}

// --- Background login worker ---
async function codexLoginWorker(session: CodexSession, authPath: string): Promise<void> {
  const startTime = Date.now()
  const interval = POLL_DEFAULT_INTERVAL
  while (Date.now() - startTime < POLL_MAX_DURATION) {
    await new Promise(resolve => setTimeout(resolve, interval))
    if (session.status !== 'pending') return
    try {
      const pollRes = await fetch(CODEX_DEVICE_TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }),
        signal: AbortSignal.timeout(10000),
      })
      if (pollRes.status === 200) {
        const pollData = await pollRes.json() as { authorization_code: string; code_verifier: string }
        const tokenRes = await fetch(CODEX_OAUTH_TOKEN_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: pollData.authorization_code, redirect_uri: CODEX_REDIRECT_URI, client_id: CODEX_CLIENT_ID, code_verifier: pollData.code_verifier }).toString(),
          signal: AbortSignal.timeout(15000),
        })
        if (!tokenRes.ok) { const errText = await tokenRes.text(); logger.error('Token exchange failed: %d %s', tokenRes.status, errText); session.status = 'error'; session.error = `Token exchange failed: ${tokenRes.status}`; return }
        const tokenData = await tokenRes.json() as { access_token: string; refresh_token?: string }
        const refreshToken = tokenData.refresh_token || ''
        session.accessToken = tokenData.access_token; session.refreshToken = refreshToken; session.status = 'approved'
        const auth = loadAuthJson(authPath)
        if (!auth.providers) auth.providers = {}
        auth.providers['openai-codex'] = { tokens: { access_token: tokenData.access_token, refresh_token: refreshToken }, last_refresh: new Date().toISOString(), auth_mode: 'chatgpt' }
        if (!auth.credential_pool) auth.credential_pool = {}
        auth.credential_pool['openai-codex'] = [{ id: `openai-codex-${Date.now()}`, label: 'OpenAI Codex', base_url: CODEX_DEFAULT_BASE_URL, access_token: tokenData.access_token, last_status: null }]
        saveAuthJson(authPath, auth)
        saveCodexCliTokens(tokenData.access_token, refreshToken)
        logger.info('Login successful')
        return
      }
      if (pollRes.status === 403 || pollRes.status === 404) { continue }
      logger.error('Poll failed: %d', pollRes.status); session.status = 'error'; session.error = `Poll failed: ${pollRes.status}`; return
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') { continue }
      logger.error(err, 'Poll error'); session.status = 'error'; session.error = err.message; return
    }
  }
  session.status = 'expired'
}

// --- Controller functions ---

export async function start(ctx: any) {
  try {
    cleanupExpiredSessions()
    const res = await fetch(CODEX_DEVICE_AUTH_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'node-fetch' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }), signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      let errorBody: any = null; try { errorBody = await res.json() } catch { }
      logger.error('Device code request failed: %d %s', res.status, errorBody)
      let errorMessage = `Device code request failed: ${res.status}`
      if (errorBody?.error?.code === 'unsupported_country_region_territory') { errorMessage = 'OpenAI does not support your region. You may need to use a proxy or VPN to access Codex.' }
      ctx.status = 502; ctx.body = { error: errorMessage, code: errorBody?.error?.code }; return
    }
    const data = await res.json() as { user_code: string; device_auth_id: string; interval?: string }
    const sessionId = randomUUID()
    const session: CodexSession = { id: sessionId, userCode: data.user_code, deviceAuthId: data.device_auth_id, status: 'pending', createdAt: Date.now() }
    sessions.set(sessionId, session)
    const authPath = getActiveAuthPath()
    codexLoginWorker(session, authPath).catch(err => { logger.error(err, 'Worker error'); session.status = 'error'; session.error = err.message })
    ctx.body = { session_id: sessionId, user_code: data.user_code, verification_url: CODEX_VERIFICATION_URL, expires_in: 900 }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function poll(ctx: any) {
  const session = sessions.get(ctx.params.sessionId)
  if (!session) { ctx.status = 404; ctx.body = { error: 'Session not found' }; return }
  ctx.body = { status: session.status, error: session.error || null }
}

export async function status(ctx: any) {
  try {
    const authPath = getActiveAuthPath()
    const auth = loadAuthJson(authPath)
    const credential = getCodexCredential(auth)
    if (!credential) { ctx.body = { authenticated: false }; return }
    const exp = decodeJwtExp(credential.accessToken)
    if (exp && exp <= Date.now() / 1000 + 120) {
      if (credential.refreshToken) {
        try {
          const refreshRes = await fetch(CODEX_OAUTH_TOKEN_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_id: CODEX_CLIENT_ID }).toString(),
            signal: AbortSignal.timeout(15000),
          })
          if (refreshRes.ok) {
            const newTokens = await refreshRes.json() as { access_token: string; refresh_token?: string }
            const lastRefresh = new Date().toISOString()
            if (credential.provider?.tokens) {
              credential.provider.tokens.access_token = newTokens.access_token
              if (newTokens.refresh_token) { credential.provider.tokens.refresh_token = newTokens.refresh_token }
              credential.provider.last_refresh = lastRefresh
            } else if (credential.provider) {
              credential.provider.access_token = newTokens.access_token
              if (newTokens.refresh_token) { credential.provider.refresh_token = newTokens.refresh_token }
              credential.provider.last_refresh = lastRefresh
            }
            if (credential.poolEntry) {
              credential.poolEntry.access_token = newTokens.access_token
              if (newTokens.refresh_token) { credential.poolEntry.refresh_token = newTokens.refresh_token }
              credential.poolEntry.last_refresh = lastRefresh
            }
            saveAuthJson(authPath, auth)
            saveCodexCliTokens(newTokens.access_token, newTokens.refresh_token || credential.refreshToken)
            ctx.body = { authenticated: true, last_refresh: lastRefresh }; return
          }
        } catch { }
      }
      ctx.body = { authenticated: false }; return
    }
    ctx.body = { authenticated: true, last_refresh: credential.lastRefresh }
  } catch { ctx.body = { authenticated: false } }
}
