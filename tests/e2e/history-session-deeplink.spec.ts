import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, TEST_MODEL_GROUP } from './fixtures'

const historySessions = [
  {
    id: 'hist-alpha',
    profile: 'default',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    title: 'Alpha History Session',
    preview: 'Alpha preview',
    started_at: 1_790_000_000,
    ended_at: null,
    last_active: 1_790_000_100,
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    workspace: null,
  },
  {
    id: 'hist-beta',
    profile: 'default',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    title: 'Beta History Session',
    preview: 'Beta preview',
    started_at: 1_790_000_200,
    ended_at: null,
    last_active: 1_790_000_300,
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 30,
    output_tokens: 40,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    workspace: null,
  },
]

function detailFor(id: string) {
  const session = historySessions.find(s => s.id === id)
  if (!session) return null
  return {
    ...session,
    messages: [
      {
        id: 1,
        session_id: id,
        role: 'user',
        content: `Question for ${session.title}`,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: session.started_at,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      },
      {
        id: 2,
        session_id: id,
        role: 'assistant',
        content: `Answer from ${session.title}`,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: session.started_at + 1,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      },
    ],
  }
}

async function mockHistoryApi(page: Page) {
  await page.route('**/*', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (!(pathname === '/health' || pathname.startsWith('/api/'))) {
      await route.continue()
      return
    }

    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (pathname === '/health') return json({ status: 'ok' })
    if (pathname === '/api/auth/status') return json({ hasPasswordLogin: false, username: null })
    if (pathname === '/api/hermes/available-models') return json({ default: 'test-model', default_provider: 'test-provider', groups: [TEST_MODEL_GROUP], allProviders: [TEST_MODEL_GROUP], model_aliases: {}, model_visibility: {} })
    if (pathname === '/api/hermes/profiles') return json({ profiles: [{ name: 'default', active: true, model: 'test-model', gateway: 'test' }] })
    if (pathname === '/api/hermes/sessions/hermes') return json({ sessions: historySessions })

    const detailMatch = pathname.match(/^\/api\/hermes\/sessions\/hermes\/([^/]+)$/)
    if (detailMatch) {
      const detail = detailFor(decodeURIComponent(detailMatch[1]))
      return detail ? json({ session: detail }) : json({ error: 'Session not found' }, 404)
    }

    return json({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404)
  })
}

test.describe('history session deep links', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page)
    await mockHistoryApi(page)
  })

  test('route session id opens selected history session', async ({ page }) => {
    await page.goto('/#/hermes/history/session/hist-beta')

    await expect(page.getByText('Beta History Session').first()).toBeVisible()
    await expect(page.getByText('Answer from Beta History Session')).toBeVisible()
    await expect(page).toHaveURL(/#\/hermes\/history\/session\/hist-beta$/)
  })

  test('clicking another history session updates URL and reload preserves it', async ({ page }) => {
    await page.goto('/#/hermes/history/session/hist-alpha')
    await expect(page.getByText('Answer from Alpha History Session')).toBeVisible()

    await page.getByText('Beta History Session').first().click()
    await expect(page).toHaveURL(/#\/hermes\/history\/session\/hist-beta\?profile=default$/)
    await expect(page.getByText('Answer from Beta History Session')).toBeVisible()

    await page.reload()
    await expect(page).toHaveURL(/#\/hermes\/history\/session\/hist-beta\?profile=default$/)
    await expect(page.getByText('Answer from Beta History Session')).toBeVisible()
  })

  test('unknown route session id falls back to base history route', async ({ page }) => {
    await page.goto('/#/hermes/history/session/missing-session')

    await expect(page).toHaveURL(/#\/hermes\/history$/)
    await expect(page.getByText('Alpha History Session').first()).toBeVisible()
  })
})
