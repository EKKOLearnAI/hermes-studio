import type { Context, Next } from 'koa'
import { createHmac, timingSafeEqual } from 'crypto'
import { getToken } from '../services/auth'
import {
  findUserById,
  listUserProfiles,
  touchUserLogin,
  userCanAccessProfile,
  type UserRecord,
  type UserRole,
} from '../db/hermes/users-store'

export interface AuthenticatedUser {
  id: number
  username: string
  role: UserRole
  profiles?: string[]
}

export interface RequestProfile {
  name: string
}

interface JwtPayload {
  sub: string
  username: string
  role: UserRole
  type: 'access'
  aud: 'hermes-web-ui'
  iat: number
  exp: number
}

declare module 'koa' {
  interface DefaultState {
    user?: AuthenticatedUser
    profile?: RequestProfile
    serverTokenAuth?: boolean
  }
}

const JWT_AUDIENCE = 'hermes-web-ui'
const DEFAULT_EXPIRES_SECONDS = 60 * 60 * 24 * 30

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
  } catch {
    return false
  }
}

async function getJwtSecret(): Promise<string> {
  return process.env.AUTH_JWT_SECRET || await getToken()
}

function requestToken(ctx: Context): string {
  const auth = ctx.headers.authorization || ''
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return typeof ctx.query.token === 'string' ? ctx.query.token.trim() : ''
}

const SERVER_TOKEN_MEDIA_PATHS = new Set([
  '/api/hermes/media/apikey-image-generate',
  '/api/hermes/media/grok-image-to-video',
])

async function allowServerTokenForMedia(ctx: Context, token: string): Promise<boolean> {
  if (!token || !SERVER_TOKEN_MEDIA_PATHS.has(ctx.path)) return false
  const serverToken = await getToken()
  if (token !== serverToken) return false
  ctx.state.serverTokenAuth = true
  return true
}

function isProtectedHttpPath(path: string): boolean {
  const lowerPath = path.toLowerCase()
  return lowerPath.startsWith('/api') ||
    lowerPath.startsWith('/v1') ||
    lowerPath.startsWith('/upload')
}

export function signUserJwt(user: Pick<UserRecord, 'id' | 'username' | 'role'>, secret: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000)
  const payload: JwtPayload = {
    sub: String(user.id),
    username: user.username,
    role: user.role,
    type: 'access',
    aud: JWT_AUDIENCE,
    iat,
    exp: iat + DEFAULT_EXPIRES_SECONDS,
  }
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' })
  const body = base64UrlJson(payload)
  const unsigned = `${header}.${body}`
  return `${unsigned}.${sign(unsigned, secret)}`
}

export function verifyUserJwt(token: string, secret: string, now = Date.now()): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, body, signature] = parts
  const expected = sign(`${header}.${body}`, secret)
  if (!safeEqual(signature, expected)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Partial<JwtPayload>
    if (payload.type !== 'access' || payload.aud !== JWT_AUDIENCE) return null
    if (!payload.sub || !payload.username || !payload.role || !payload.exp) return null
    if (Math.floor(now / 1000) >= payload.exp) return null
    return payload as JwtPayload
  } catch {
    return null
  }
}

export async function issueUserJwt(user: Pick<UserRecord, 'id' | 'username' | 'role'>): Promise<string> {
  const secret = await getJwtSecret()
  return signUserJwt(user, secret)
}

export function toAuthenticatedUser(user: Pick<UserRecord, 'id' | 'username' | 'role'>): AuthenticatedUser {
  const authenticated: AuthenticatedUser = {
    id: user.id,
    username: user.username,
    role: user.role,
  }
  if (user.role !== 'super_admin') {
    authenticated.profiles = listUserProfiles(user.id).map(profile => profile.profile_name)
  }
  return authenticated
}

export async function authenticateUserToken(token: string): Promise<AuthenticatedUser | null> {
  const secret = await getJwtSecret()

  const payload = token ? verifyUserJwt(token, secret) : null
  if (!payload) return null

  const user = findUserById(payload.sub)
  if (!user || user.status !== 'active') return null
  return toAuthenticatedUser(user)
}

export async function isAuthEnabled(): Promise<boolean> {
  await getJwtSecret()
  return true
}

export async function requireUserJwt(ctx: Context, next: Next): Promise<void> {
  if (!isProtectedHttpPath(ctx.path)) {
    await next()
    return
  }

  const secret = await getJwtSecret()
  const token = requestToken(ctx)
  const payload = token ? verifyUserJwt(token, secret) : null
  if (!payload) {
    if (await allowServerTokenForMedia(ctx, token)) {
      await next()
      return
    }
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const user = findUserById(payload.sub)
  if (!user || user.status !== 'active') {
    ctx.status = 403
    ctx.body = { error: 'User is disabled or does not exist' }
    return
  }

  ctx.state.user = toAuthenticatedUser(user)
  touchUserLogin(user.id)
  await next()
}

export async function requireSuperAdmin(ctx: Context, next: Next): Promise<void> {
  if (ctx.state.user?.role !== 'super_admin') {
    ctx.status = 403
    ctx.body = { error: 'Super administrator privileges are required' }
    return
  }
  await next()
}

export function resolveRequestedProfile(ctx: Context): string {
  if (ctx.path === '/api/hermes/available-models' && typeof ctx.query.profile !== 'string') {
    return ''
  }
  const headerProfile = ctx.get('x-hermes-profile')
  const queryProfile = typeof ctx.query.profile === 'string' ? ctx.query.profile : ''
  const body = ctx.request.body as { profile?: unknown } | undefined
  const bodyProfile = typeof body?.profile === 'string' ? body.profile : ''
  return (headerProfile || queryProfile || bodyProfile || '').trim()
}

export async function resolveUserProfile(ctx: Context, next: Next): Promise<void> {
  const user = ctx.state.user
  if (!user) {
    await next()
    return
  }

  const profileName = resolveRequestedProfile(ctx)
  if (!profileName) {
    await next()
    return
  }

  if (user.role !== 'super_admin' && !userCanAccessProfile(user.id, profileName)) {
    ctx.status = 403
    ctx.body = { error: `Profile "${profileName}" is not available for this user` }
    return
  }

  ctx.state.profile = { name: profileName }
  await next()
}

export async function requireUserProfile(ctx: Context, next: Next): Promise<void> {
  if (!ctx.state.profile?.name) {
    ctx.status = 400
    ctx.body = { error: 'Profile is required' }
    return
  }
  await next()
}

export const userAuthMiddleware = [requireUserJwt, resolveUserProfile]
