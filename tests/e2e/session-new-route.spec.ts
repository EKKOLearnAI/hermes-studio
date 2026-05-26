import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

const oldSession = {
  id: 'session-old',
  title: 'Legacy Session',
  source: 'cli',
  model: 'test-model',
  provider: 'test-provider',
  profile: 'research',
  started_at: 1_700_000_000,
  ended_at: null,
  last_active: 1_700_000_100,
  message_count: 2,
  tool_call_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  billing_provider: null,
  estimated_cost_usd: 0,
  actual_cost_usd: null,
  cost_status: '',
  workspace: null,
}

test('direct /session/new navigation creates a fresh session and keeps the canonical URL on reload', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, { sessions: [oldSession] })
  await mockChatSocket(page)

  await page.addInitScript(() => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      'session-old': {
        session_id: 'session-old',
        isWorking: false,
        queueLength: 0,
        messages: [
          {
            id: 1,
            session_id: 'session-old',
            role: 'user',
            content: 'Legacy prompt',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 1,
            token_count: null,
            finish_reason: null,
            reasoning: null,
          },
          {
            id: 2,
            session_id: 'session-old',
            role: 'assistant',
            content: 'Legacy session answer',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 2,
            token_count: null,
            finish_reason: null,
            reasoning: null,
          },
        ],
      },
    }
  })

  await page.goto('/session/new')

  await expect(page).toHaveURL(/\/session\/(?!new$)[^/]+$/)
  await expect(page.getByPlaceholder(inputPlaceholder)).toBeVisible()
  await expect(page.getByText('Legacy session answer')).toHaveCount(0)

  const canonicalPath = new URL(page.url()).pathname
  expect(canonicalPath).not.toBe('/session/new')

  await page.reload()
  await expect(page).toHaveURL(new RegExp(`${canonicalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  await expect(page.getByPlaceholder(inputPlaceholder)).toBeVisible()
  await expect(page.getByText('Legacy session answer')).toHaveCount(0)
})