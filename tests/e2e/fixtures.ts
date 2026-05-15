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
      await route.fulfill(jsonResponse({ sessions: [] }, tokenValidationStatus))
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

    if (pathname === '/api/hermes/profiles') {
      await route.fulfill(jsonResponse({
        profiles: [
          { name: 'default', active: false, model: 'test-model', gateway: 'test', alias: 'Default' },
          { name: 'research', active: true, model: 'test-model', gateway: 'test', alias: 'Research' },
        ],
      }))
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
