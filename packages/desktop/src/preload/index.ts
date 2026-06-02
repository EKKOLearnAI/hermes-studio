import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('hermesDesktop', {
  getToken: (): Promise<string> => ipcRenderer.invoke('hermes-desktop:get-token'),
  retryBootstrap: (): Promise<void> => ipcRenderer.invoke('hermes-desktop:retry-bootstrap'),
  platform: process.platform,
  isDesktop: true,
})

const API_KEY_LS = 'hermes_api_key'
const DEFAULT_USERNAME = 'admin'
const DEFAULT_PASSWORD = '123456'

// Auto-login the bundled web UI so users don't see a login screen on launch.
// We POST to /api/auth/login with the well-known default credentials, using
// the server's AUTH_TOKEN as the bearer (the server requires *some* auth on
// /api/auth/login from a packaged client). The returned JWT is dropped into
// localStorage where the Vue client expects it.
async function autoLogin(token: string): Promise<void> {
  if (localStorage.getItem(API_KEY_LS)) return
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD }),
    })
    if (!res.ok) return
    const body = await res.json().catch(() => null) as { token?: string; jwt?: string } | null
    const jwt = body?.token || body?.jwt
    if (jwt) localStorage.setItem(API_KEY_LS, jwt)
  } catch {
    /* ignore — first-load race or server still starting */
  }
}

// Silently strip the "你必须修改默认密码" flag from /api/auth/me responses on
// desktop. Users on a single-machine install don't benefit from a managed
// password. The Web UI client uses BOTH fetch and axios (which goes through
// XMLHttpRequest), so we patch both code paths.
function isAuthMeUrl(url: string): boolean {
  return /\/api\/auth\/me(?:\?|$)/.test(url)
}

function stripCredentialFlag(text: string): string {
  try {
    const data = JSON.parse(text)
    if (data?.user && data.user.requiresCredentialChange) {
      data.user.requiresCredentialChange = false
      return JSON.stringify(data)
    }
  } catch { /* not JSON */ }
  return text
}

function installFetchPatch(): void {
  const origFetch = window.fetch.bind(window)
  const patchedFetch = (async (input, init) => {
    const res = await origFetch(input, init)
    try {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url && isAuthMeUrl(url) && res.ok) {
        const text = await res.clone().text()
        const patched = stripCredentialFlag(text)
        if (patched !== text) {
          return new Response(patched, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          })
        }
      }
    } catch { /* fall through */ }
    return res
  }) as typeof window.fetch
  window.fetch = patchedFetch

  const OrigXHR = window.XMLHttpRequest
  type XHRWithDesktop = XMLHttpRequest & { __hermesDesktopUrl?: string }
  const origOpen = OrigXHR.prototype.open
  OrigXHR.prototype.open = function (
    this: XHRWithDesktop,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__hermesDesktopUrl = String(url)
    // @ts-expect-error — forwarding variadic
    return origOpen.call(this, method, url, ...rest)
  }
  const origGetResponse = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'response')
  const origGetResponseText = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'responseText')
  if (origGetResponse?.get && origGetResponseText?.get) {
    Object.defineProperty(OrigXHR.prototype, 'responseText', {
      configurable: true,
      get(this: XHRWithDesktop) {
        const raw = origGetResponseText.get!.call(this) as string
        if (this.__hermesDesktopUrl && isAuthMeUrl(this.__hermesDesktopUrl) && typeof raw === 'string') {
          return stripCredentialFlag(raw)
        }
        return raw
      },
    })
    Object.defineProperty(OrigXHR.prototype, 'response', {
      configurable: true,
      get(this: XHRWithDesktop) {
        const raw = origGetResponse.get!.call(this)
        if (this.__hermesDesktopUrl && isAuthMeUrl(this.__hermesDesktopUrl)) {
          if (typeof raw === 'string') return stripCredentialFlag(raw)
          if (raw && typeof raw === 'object' && (raw as { user?: { requiresCredentialChange?: boolean } }).user?.requiresCredentialChange) {
            return { ...(raw as object), user: { ...(raw as { user: object }).user, requiresCredentialChange: false } }
          }
        }
        return raw
      },
    })
  }
}

installFetchPatch()

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const token = await ipcRenderer.invoke('hermes-desktop:get-token')
    if (token) {
      try { localStorage.setItem('AUTH_TOKEN', token) } catch { /* */ }
      await autoLogin(token)
    }
  } catch {
    /* ignore */
  }
})
