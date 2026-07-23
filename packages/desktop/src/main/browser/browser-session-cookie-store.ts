import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Cookie, CookiesGetFilter, CookiesSetDetails } from 'electron'

const SNAPSHOT_SCHEMA = 1
const SNAPSHOT_FILE = '.hermes-session-cookies.enc'
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

interface EncryptedSessionCookies {
  schema: typeof SNAPSHOT_SCHEMA
  payload: string
}

export interface BrowserCookieCrypto {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Promise<Buffer>
  decryptString(value: Buffer): Promise<string>
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
  constructor(private readonly crypto: BrowserCookieCrypto) {}

  filePath(sessionPath: string): string {
    return join(sessionPath, SNAPSHOT_FILE)
  }

  async restore(sessionPath: string, cookies: BrowserCookies): Promise<{ restored: number; failed: number }> {
    if (!this.crypto.isEncryptionAvailable()) return { restored: 0, failed: 0 }
    const pathname = this.filePath(sessionPath)
    let serialized: string
    try {
      const info = await stat(pathname)
      if (info.size > MAX_SNAPSHOT_BYTES) throw new Error('Encrypted session cookie snapshot is too large')
      serialized = await readFile(pathname, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { restored: 0, failed: 0 }
      throw error
    }
    const envelope = JSON.parse(serialized) as Partial<EncryptedSessionCookies>
    if (envelope.schema !== SNAPSHOT_SCHEMA || typeof envelope.payload !== 'string') {
      throw new Error('Encrypted session cookie snapshot has an unsupported format')
    }
    const decrypted = await this.crypto.decryptString(Buffer.from(envelope.payload, 'base64'))
    const snapshot = JSON.parse(decrypted) as Partial<StoredSessionCookies>
    if (snapshot.schema !== SNAPSHOT_SCHEMA || !Array.isArray(snapshot.cookies)) {
      throw new Error('Decrypted session cookie snapshot has an unsupported format')
    }
    const details = snapshot.cookies.map(storedCookie).filter((cookie): cookie is StoredSessionCookie => cookie !== null)
      .map(cookieDetails).filter((cookie): cookie is CookiesSetDetails => cookie !== null)
    const results = await Promise.allSettled(details.map(cookie => cookies.set(cookie)))
    return {
      restored: results.filter(result => result.status === 'fulfilled').length,
      failed: results.filter(result => result.status === 'rejected').length,
    }
  }

  async persist(sessionPath: string, cookies: BrowserCookies): Promise<boolean> {
    if (!this.crypto.isEncryptionAvailable()) return false
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
    if (sessionCookies.length === 0) {
      await rm(pathname, { force: true })
      return true
    }
    const encrypted = await this.crypto.encryptString(JSON.stringify({
      schema: SNAPSHOT_SCHEMA,
      cookies: sessionCookies,
    } satisfies StoredSessionCookies))
    const tempPath = `${pathname}.${process.pid}.tmp`
    await mkdir(sessionPath, { recursive: true, mode: 0o700 })
    try {
      await writeFile(tempPath, `${JSON.stringify({
        schema: SNAPSHOT_SCHEMA,
        payload: encrypted.toString('base64'),
      } satisfies EncryptedSessionCookies)}\n`, { mode: 0o600 })
      await rename(tempPath, pathname)
      await chmod(pathname, 0o600)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
    return true
  }

  async clear(sessionPath: string): Promise<void> {
    await rm(this.filePath(sessionPath), { force: true })
  }
}
