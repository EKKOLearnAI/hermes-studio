import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Cookie, CookiesGetFilter, CookiesSetDetails } from 'electron'

const SNAPSHOT_SCHEMA = 1
const SNAPSHOT_FILE = '.hermes-session-cookies.json'
const LEGACY_ENCRYPTED_SNAPSHOT_FILE = '.hermes-session-cookies.enc'
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

interface StoredSessionCookie {
  name: string
  value: string
  domain: string
  path: string
  hostOnly: boolean
  httpOnly: boolean
  secure: boolean
  sameSite: Cookie['sameSite']
  expirationDate?: number
}

interface StoredSessionCookies {
  schema: typeof SNAPSHOT_SCHEMA
  cookies: StoredSessionCookie[]
}

export interface BrowserCookies {
  get(filter: CookiesGetFilter): Promise<Cookie[]>
  set(details: CookiesSetDetails): Promise<void>
}

function isSameSite(value: unknown): value is Cookie['sameSite'] {
  return value === 'unspecified' || value === 'no_restriction' || value === 'lax' || value === 'strict'
}

function storedCookie(value: unknown): StoredSessionCookie | null {
  if (!value || typeof value !== 'object') return null
  const cookie = value as Partial<StoredSessionCookie>
  if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string') return null
  if (typeof cookie.path !== 'string' || !isSameSite(cookie.sameSite)) return null
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    hostOnly: cookie.hostOnly === true,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    sameSite: cookie.sameSite,
    ...(typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)
      ? { expirationDate: cookie.expirationDate }
      : {}),
  }
}

function cookieDetails(cookie: StoredSessionCookie): CookiesSetDetails | null {
  if (cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now() / 1_000) return null
  const hostname = cookie.domain.trim().replace(/^\./, '')
  if (!hostname) return null
  const path = cookie.path.startsWith('/') ? cookie.path : '/'
  let url: string
  try {
    url = new URL(`${cookie.secure ? 'https' : 'http'}://${hostname}${path}`).toString()
  } catch {
    return null
  }
  return {
    url,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  }
}

export class BrowserSessionCookieStore {
  filePath(sessionPath: string): string {
    return join(sessionPath, SNAPSHOT_FILE)
  }

  async restore(sessionPath: string, cookies: BrowserCookies): Promise<{ restored: number; failed: number }> {
    const pathname = this.filePath(sessionPath)
    let serialized: string
    try {
      const info = await stat(pathname)
      if (info.size > MAX_SNAPSHOT_BYTES) throw new Error('Session cookie snapshot is too large')
      serialized = await readFile(pathname, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { restored: 0, failed: 0 }
      throw error
    }
    const snapshot = JSON.parse(serialized) as Partial<StoredSessionCookies>
    if (snapshot.schema !== SNAPSHOT_SCHEMA || !Array.isArray(snapshot.cookies)) {
      throw new Error('Session cookie snapshot has an unsupported format')
    }
    const details = snapshot.cookies.map(storedCookie).filter((cookie): cookie is StoredSessionCookie => cookie !== null)
      .map(cookieDetails).filter((cookie): cookie is CookiesSetDetails => cookie !== null)
    const results = await Promise.allSettled(details.map(cookie => cookies.set(cookie)))
    return {
      restored: results.filter(result => result.status === 'fulfilled').length,
      failed: results.filter(result => result.status === 'rejected').length,
    }
  }

  async persist(sessionPath: string, cookies: BrowserCookies): Promise<void> {
    const current = await cookies.get({})
    const sessionCookies: StoredSessionCookie[] = current.filter(cookie => !!cookie.domain).map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || '',
      path: cookie.path || '/',
      hostOnly: cookie.hostOnly === true,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      sameSite: cookie.sameSite,
      ...(typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)
        ? { expirationDate: cookie.expirationDate }
        : {}),
    }))
    const pathname = this.filePath(sessionPath)
    await rm(join(sessionPath, LEGACY_ENCRYPTED_SNAPSHOT_FILE), { force: true })
    if (sessionCookies.length === 0) {
      await rm(pathname, { force: true })
      return
    }
    const tempPath = `${pathname}.${process.pid}.tmp`
    await mkdir(sessionPath, { recursive: true, mode: 0o700 })
    try {
      await writeFile(tempPath, `${JSON.stringify({
        schema: SNAPSHOT_SCHEMA,
        cookies: sessionCookies,
      } satisfies StoredSessionCookies)}\n`, { mode: 0o600 })
      await rename(tempPath, pathname)
      await chmod(pathname, 0o600)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async clear(sessionPath: string): Promise<void> {
    await Promise.all([
      rm(this.filePath(sessionPath), { force: true }),
      rm(join(sessionPath, LEGACY_ENCRYPTED_SNAPSHOT_FILE), { force: true }),
    ])
  }
}
