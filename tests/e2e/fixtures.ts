import type { Page, Request, Route } from '@playwright/test'

export const TEST_ACCESS_KEY = 'playwright-access-key'

export interface MockedRequest {
  method: string
  pathname: string
  search: string
  headers: Record<string, string>
  postData: string | null
}

interface MockHermesApiOptions {
  tokenValidationStatus?: number
  initialProfileName?: 'default' | 'research'
  sessions?: unknown[]
}

const sampleModelGroup = {
  provider: 'test-provider',
  label: 'Test Provider',
  base_url: 'https://example.invalid/v1',
  models: ['test-model'],
  available_models: ['test-model'],
  api_key: '',
  builtin: true,
}

const sampleJob = {
  job_id: 'job-smoke',
  id: 'job-smoke',
  name: 'Nightly Smoke',
  prompt: 'Run the smoke check',
  prompt_preview: 'Run the smoke check',
  skills: [],
  skill: null,
  model: 'test-model',
  provider: 'test-provider',
  base_url: null,
  script: null,
  schedule: '0 9 * * *',
  schedule_display: '0 9 * * *',
  repeat: { times: null, completed: 0 },
  enabled: true,
  state: 'scheduled',
  paused_at: null,
  paused_reason: null,
  created_at: '2026-01-01T00:00:00.000Z',
  next_run_at: '2026-01-02T09:00:00.000Z',
  last_run_at: null,
  last_status: null,
  last_error: null,
  deliver: 'origin',
  origin: null,
  last_delivery_error: null,
}

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }
}

function recordRequest(request: Request): MockedRequest {
  const url = new URL(request.url())
  return {
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
    headers: request.headers(),
    postData: request.postData(),
  }
}

export async function mockHermesApi(page: Page, options: MockHermesApiOptions = {}) {
  const requests: MockedRequest[] = []
  const unexpectedRequests: MockedRequest[] = []
  const tokenValidationStatus = options.tokenValidationStatus ?? 200
  let activeProfileName = options.initialProfileName ?? 'research'

  await page.route('**/*', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (!(pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/v1/'))) {
      await route.continue()
      return
    }

    requests.push(recordRequest(request))

    if (pathname === '/health') {
      await route.fulfill(jsonResponse({ status: 'ok', webui_version: '0.5.23', node_version: '23.0.0' }))
      return
    }

    if (pathname === '/api/auth/status') {
      await route.fulfill(jsonResponse({ hasPasswordLogin: false, username: null }))
      return
    }

    if (pathname === '/api/hermes/sessions') {
      await route.fulfill(jsonResponse({ sessions: options.sessions ?? [] }, tokenValidationStatus))
      return
    }

    if (pathname === '/api/hermes/sessions/hermes') {
      await route.fulfill(jsonResponse({ sessions: [] }))
      return
    }

    if (pathname === '/api/hermes/sessions/context-length') {
      await route.fulfill(jsonResponse({ context_length: 200000 }))
      return
    }

    if (pathname === '/api/hermes/files/list') {
      await route.fulfill(jsonResponse({ entries: [], path: '' }))
      return
    }

    if (pathname === '/api/hermes/auth/copilot/check-token') {
      await route.fulfill(jsonResponse({ has_token: false, source: null, enabled: false }))
      return
    }

    if (pathname === '/api/auth/locked-ips') {
      await route.fulfill(jsonResponse({ locks: [] }))
      return
    }

    if (pathname === '/api/hermes/available-models') {
      await route.fulfill(jsonResponse({
        default: 'test-model',
        default_provider: 'test-provider',
        groups: [sampleModelGroup],
        allProviders: [sampleModelGroup],
        model_aliases: {},
        model_visibility: {},
      }))
      return
    }

    if (pathname === '/api/hermes/provider-models') {
      await route.fulfill(jsonResponse({ models: ['proxy-model-a', 'proxy-model-b'] }))
      return
    }

    if (pathname === '/api/hermes/profiles') {
      await route.fulfill(jsonResponse({
        profiles: [
          { name: 'default', active: activeProfileName === 'default', model: 'test-model', gateway: 'test', alias: 'Default' },
          { name: 'research', active: activeProfileName === 'research', model: 'test-model', gateway: 'test', alias: 'Research' },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/profiles/active') {
      if (request.method() !== 'PUT') {
        await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
        return
      }

      let body: { name?: unknown }
      try {
        body = JSON.parse(request.postData() || '{}')
      } catch {
        await route.fulfill(jsonResponse({ error: 'Invalid JSON body' }, 400))
        return
      }

      if (body.name !== 'default' && body.name !== 'research') {
        await route.fulfill(jsonResponse({ error: 'Unknown profile' }, 400))
        return
      }

      activeProfileName = body.name
      await route.fulfill(jsonResponse({ success: true, active: activeProfileName }))
      return
    }

    if (pathname === '/api/hermes/config') {
      await route.fulfill(jsonResponse({
        display: { streaming: true, show_reasoning: true, show_cost: true },
        agent: {},
        memory: {},
        session_reset: {},
        privacy: {},
        approvals: {},
      }))
      return
    }

    if (pathname === '/api/hermes/jobs') {
      await route.fulfill(jsonResponse({ jobs: [sampleJob] }))
      return
    }

    if (pathname === '/api/cron-history') {
      await route.fulfill(jsonResponse({ runs: [] }))
      return
    }

    unexpectedRequests.push(recordRequest(request))
    await route.fulfill(jsonResponse({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404))
  })

  return { requests, unexpectedRequests }
}

export async function authenticate(page: Page, accessKey = TEST_ACCESS_KEY, profileName?: string) {
  await page.addInitScript((state: { storedToken: string; storedProfileName?: string }) => {
    const { storedToken, storedProfileName } = state
    window.localStorage.setItem('hermes_api_key', storedToken)
    if (storedProfileName) {
      window.localStorage.setItem('hermes_active_profile_name', storedProfileName)
    }
  }, { storedToken: accessKey, storedProfileName: profileName })
}

export async function mockChatSocket(page: Page) {
  await page.route('**/node_modules/.vite/deps/socket__io-client.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
const state = window.__PW_CHAT_SOCKET__ || (window.__PW_CHAT_SOCKET__ = { sockets: [], emitted: [] })
function makeSocket(url, options) {
  const listeners = new Map()
  const onceListeners = new Map()
  const socket = {
    connected: true,
    url,
    options,
    on(event, handler) {
      const handlers = listeners.get(event) || []
      handlers.push(handler)
      listeners.set(event, handlers)
      return this
    },
    once(event, handler) {
      const handlers = onceListeners.get(event) || []
      handlers.push(handler)
      onceListeners.set(event, handlers)
      return this
    },
    emit(event, payload) {
      state.emitted.push({ event, payload })
      if (event === 'resume') {
        const sessionId = payload && payload.session_id
        const resumes = window.__PW_CHAT_SOCKET_RESUMES__ || {}
        const response = sessionId ? resumes[sessionId] : null
        if (response) {
          setTimeout(() => this.__trigger('resumed', response), 0)
        }
      }
      return this
    },
    removeAllListeners() {
      listeners.clear()
      onceListeners.clear()
      return this
    },
    disconnect() {
      this.connected = false
      return this
    },
    __trigger(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload)
      const handlers = onceListeners.get(event) || []
      onceListeners.delete(event)
      for (const handler of handlers) handler(payload)
    },
  }
  state.sockets.push(socket)
  state.latest = socket
  return socket
}
export function io(url, options) {
  return makeSocket(url, options)
}
export default { io }
`,
    })
  })
}

export async function mockTerminalWebSocket(page: Page) {
  await page.addInitScript(() => {
    const state = (window as any).__PW_TERMINAL_WS__ = {
      sockets: [] as any[],
      sent: [] as any[],
      createdCount: 0,
      latest: null as any,
    }
    const RealEvent = window.Event
    const RealMessageEvent = window.MessageEvent

    class MockTerminalWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      binaryType: BinaryType = 'blob'
      bufferedAmount = 0
      extensions = ''
      protocol = ''
      readyState = MockTerminalWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor(readonly url: string | URL) {
        super()
        state.sockets.push(this)
        state.latest = this
        setTimeout(() => {
          this.readyState = MockTerminalWebSocket.OPEN
          const openEvent = new RealEvent('open')
          this.onopen?.(openEvent)
          this.dispatchEvent(openEvent)
          this.__createSession('term-1', 'zsh', 101)
        }, 0)
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const normalized = typeof data === 'string' ? data : String(data)
        state.sent.push({ socket: this.url.toString(), data: normalized })
        if (normalized.charCodeAt(0) !== 0x7B) return
        try {
          const message = JSON.parse(normalized)
          if (message.type === 'create') {
            this.__createSession(`term-${state.createdCount + 1}`, 'bash', 200 + state.createdCount)
          }
          if (message.type === 'switch') {
            this.__emitMessage(JSON.stringify({ type: 'switched', id: message.sessionId }))
          }
        } catch {}
      }

      close() {
        this.readyState = MockTerminalWebSocket.CLOSED
      }

      __createSession(id: string, shell: string, pid: number) {
        state.createdCount += 1
        this.__emitMessage(JSON.stringify({ type: 'created', id, shell, pid }))
      }

      __emitMessage(data: string) {
        const event = new RealMessageEvent('message', { data })
        this.onmessage?.(event)
        this.dispatchEvent(event)
      }
    }

    ;(window as any).WebSocket = MockTerminalWebSocket
  })
}
