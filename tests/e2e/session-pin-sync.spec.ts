import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

function sessionSummary(id: string, title: string, lastActive: number) {
  return {
    id,
    profile: 'research',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    title,
    preview: title,
    started_at: lastActive - 10,
    ended_at: null,
    last_active: lastActive,
    message_count: 1,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: 'estimated',
    category_id: null,
  }
}

test('merges existing desktop and mobile pins into the shared pinned section', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    localStorage.setItem('hermes_session_pins_v1_research', JSON.stringify(['desktop-pin']))
  })
  const sharedPins = { research: ['mobile-pin'] }
  const api = await mockHermesApi(page, {
    sessionPins: sharedPins,
    sessions: [
      sessionSummary('desktop-pin', 'Desktop pinned conversation', 100),
      sessionSummary('mobile-pin', 'Mobile pinned conversation', 90),
      sessionSummary('recent-chat', 'Recent conversation', 110),
    ],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  const pinnedHeader = page.locator('.session-group-header--static').filter({ hasText: 'Pinned' })
  await expect(pinnedHeader).toBeVisible()
  await expect(pinnedHeader.locator('.session-group-count')).toHaveText('2')
  await expect(page.getByRole('link', { name: /Desktop pinned conversation/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Mobile pinned conversation/ })).toBeVisible()
  expect(sharedPins.research).toEqual(['mobile-pin', 'desktop-pin'])

  sharedPins.research.push('recent-chat')
  await page.evaluate(() => window.dispatchEvent(new Event('hermes:open-page-sidebar')))
  await expect(pinnedHeader.locator('.session-group-count')).toHaveText('3')

  expect(api.unexpectedRequests).toEqual([])
})
