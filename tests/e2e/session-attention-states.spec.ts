import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const readSession = {
  id: 'session-read-1',
  title: 'Read Session',
  source: 'cli',
  model: 'test-model',
  provider: 'test-provider',
  profile: 'research',
  started_at: 1_700_000_000,
  ended_at: null,
  last_active: 1_700_000_200,
  message_count: 2,
}

const unreadSession = {
  id: 'session-unread-1',
  title: 'Unread Session',
  source: 'cli',
  model: 'test-model',
  provider: 'test-provider',
  profile: 'research',
  started_at: 1_700_000_000,
  ended_at: null,
  last_active: 1_700_000_100,
  message_count: 2,
}

test('read session rows do not show an attention indicator', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, { sessions: [readSession] })

  await page.goto('/chat')

  const row = page.locator('.session-item', { hasText: 'Read Session' })
  await expect(row.locator('.session-attention-indicator')).toHaveCount(0)
})

test('persisted unread session shows and clears its indicator when opened', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    window.localStorage.setItem('hermes_active_session_research', 'session-read-1')
    window.localStorage.setItem('hermes_session_attention_v1_research', JSON.stringify({
      unread: ['session-unread-1'],
      seenAt: {},
    }))
  })
  await mockHermesApi(page, { sessions: [readSession, unreadSession] })

  await page.goto('/chat')

  const unreadRow = page.locator('.session-item', { hasText: 'Unread Session' })
  await expect(unreadRow.locator('.session-attention-indicator--unread')).toHaveCount(1)

  await unreadRow.click()

  await expect(unreadRow.locator('.session-attention-indicator')).toHaveCount(0)
})

test('clearing unread in one tab syncs to another tab', async ({ context, page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await context.addInitScript(() => {
    window.localStorage.setItem('hermes_active_session_research', 'session-read-1')
    window.localStorage.setItem('hermes_session_attention_v1_research', JSON.stringify({
      unread: ['session-unread-1'],
      seenAt: {},
    }))
  })

  const secondPage = await context.newPage()
  await mockHermesApi(page, { sessions: [readSession, unreadSession] })
  await mockHermesApi(secondPage, { sessions: [readSession, unreadSession] })

  await page.goto('/chat')
  await secondPage.goto('/chat')

  const firstUnreadRow = page.locator('.session-item-shell', { hasText: 'Unread Session' })
  const secondUnreadRow = secondPage.locator('.session-item-shell', { hasText: 'Unread Session' })
  await expect(firstUnreadRow.locator('.session-attention-indicator--unread')).toHaveCount(1)
  await expect(secondUnreadRow.locator('.session-attention-indicator--unread')).toHaveCount(1)

  await firstUnreadRow.locator('.session-item-link').click()

  await expect(firstUnreadRow.locator('.session-attention-indicator')).toHaveCount(0)
  await expect(secondUnreadRow.locator('.session-attention-indicator')).toHaveCount(0)
})
