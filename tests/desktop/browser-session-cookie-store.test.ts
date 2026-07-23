import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Cookie, CookiesSetDetails } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserSessionCookieStore,
  type BrowserCookieCrypto,
  type BrowserCookies,
} from '../../packages/desktop/src/main/browser/browser-session-cookie-store'

const roots: string[] = []

const testCrypto: BrowserCookieCrypto = {
  isEncryptionAvailable: () => true,
  async encryptString(value) {
    return Buffer.from(`test-encrypted:${Buffer.from(value).toString('base64')}`)
  },
  async decryptString(value) {
    const encoded = value.toString().replace(/^test-encrypted:/, '')
    return Buffer.from(encoded, 'base64').toString()
  },
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop browser session cookie store', () => {
  it('encrypts all profile cookies and restores their host/domain and expiration semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-session-cookies-'))
    roots.push(root)
    const persistentExpiration = Date.now() / 1_000 + 86_400
    const sourceCookies: Cookie[] = [{
      name: '__Host-session',
      value: 'host-session-secret',
      domain: 'accounts.google.com',
      path: '/',
      hostOnly: true,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      session: true,
    }, {
      name: 'domain-session',
      value: 'domain-session-secret',
      domain: '.google.com',
      path: '/signin',
      hostOnly: false,
      httpOnly: true,
      secure: true,
      sameSite: 'no_restriction',
      session: true,
    }, {
      name: 'persistent',
      value: 'normal-cookie-secret',
      domain: '.google.com',
      path: '/',
      secure: true,
      sameSite: 'lax',
      session: false,
      expirationDate: persistentExpiration,
    }]
    const source: BrowserCookies = {
      async get() {
        return sourceCookies
      },
      async set() {},
    }
    const store = new BrowserSessionCookieStore(testCrypto)

    expect(await store.persist(root, source)).toBe(true)
    const encrypted = await readFile(store.filePath(root), 'utf8')
    expect(encrypted).not.toContain('host-session-secret')
    expect(encrypted).not.toContain('domain-session-secret')
    expect(encrypted).not.toContain('normal-cookie-secret')
    if (process.platform !== 'win32') expect((await stat(store.filePath(root))).mode & 0o077).toBe(0)

    const restored: CookiesSetDetails[] = []
    const destination: BrowserCookies = {
      async get() {
        return []
      },
      async set(details) {
        restored.push(details)
      },
    }
    await expect(store.restore(root, destination)).resolves.toEqual({ restored: 3, failed: 0 })
    expect(restored).toEqual([
      {
        url: 'https://accounts.google.com/',
        name: '__Host-session',
        value: 'host-session-secret',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      },
      {
        url: 'https://google.com/signin',
        name: 'domain-session',
        value: 'domain-session-secret',
        domain: '.google.com',
        path: '/signin',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
      },
      {
        url: 'https://google.com/',
        name: 'persistent',
        value: 'normal-cookie-secret',
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'lax',
        expirationDate: persistentExpiration,
      },
    ])
    expect(restored.slice(0, 2).every(cookie => cookie.expirationDate === undefined)).toBe(true)
  })

  it('removes a stale snapshot after the last session cookie is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-session-cookie-clear-'))
    roots.push(root)
    const store = new BrowserSessionCookieStore(testCrypto)
    const cookies: BrowserCookies = {
      async get() {
        return [{
          name: 'session',
          value: 'secret',
          domain: 'example.com',
          sameSite: 'lax',
          session: true,
        }]
      },
      async set() {},
    }
    await store.persist(root, cookies)
    cookies.get = async () => []

    await expect(store.persist(root, cookies)).resolves.toBe(true)
    await expect(stat(store.filePath(root))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
