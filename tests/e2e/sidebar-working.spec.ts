import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

// All session data and socket traffic in this test are fixtures, not live tasks.
test('restores sidebar delegation activity on reload and keeps it scoped during navigation', async ({ page }, testInfo) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const sessions = ['Delegated fixture', 'Idle fixture'].map((title, index) => ({
    id: `sidebar-fixture-${index}`, title, profile: 'research', source: 'api_server',
    model: 'test-model', provider: 'test-provider', started_at: 2 - index,
    last_active: 2 - index, message_count: 1,
  }))
  await page.addInitScript(() => {
    const pending = window.localStorage.getItem('fixture-background-finished') ? 0 : 2
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = Object.fromEntries([0, 1].map(index => {
      const sid = `sidebar-fixture-${index}`
      return [sid, {
        session_id: sid, isWorking: false, backgroundPending: index === 0 ? pending : 0,
        messages: [{ id: index + 1, role: 'assistant', content: `Fixture answer ${index}`, timestamp: 1, finish_reason: 'stop' }],
        // Stale task history must never override the authoritative aggregate.
        events: index === 0 ? [{ event: 'subagent.start', data: {
          event: 'subagent.start', session_id: sid, subagent_id: 'historical-child',
          goal: 'Historical fixture task', background_pending: 7,
        } }] : [],
      }]
    }))
  })
  const api = await mockHermesApi(page, { sessions })
  await page.goto('/#/hermes/chat')
  const delegated = page.locator('.session-item').filter({ hasText: 'Delegated fixture' })
  const idle = page.locator('.session-item').filter({ hasText: 'Idle fixture' })
  const working = delegated.locator('.session-item-agent-logo-wrap.streaming')
  await expect(working).toHaveCount(2)
  await expect(page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)

  await idle.first().click()
  await expect(page.getByText('Fixture answer 1', { exact: true })).toBeVisible()
  await expect(working).toHaveCount(2)
  await expect(idle.locator('.session-item-agent-logo-wrap.streaming')).toHaveCount(0)
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('04-mocked-navigated-background.png') })

  await delegated.first().click()
  await expect(page.getByText('Fixture answer 0', { exact: true })).toBeVisible()
  await page.reload()
  await expect(working).toHaveCount(2)
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('05-mocked-reloaded-background.png') })

  await page.evaluate(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    state.broadcast('delegation.updated', {
      event: 'delegation.updated', session_id: 'sidebar-fixture-0',
      status: 'cancelled', background_pending: 1,
    })
  })
  await expect(working).toHaveCount(2)
  await page.evaluate(() => {
    ;(window as any).__PW_CHAT_SOCKET__.broadcast('delegation.updated', {
      event: 'delegation.updated', session_id: 'sidebar-fixture-0',
      status: 'failed', background_pending: 0,
    })
    window.localStorage.setItem('fixture-background-finished', '1')
  })
  await expect(working).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('Fixture answer 0', { exact: true })).toBeVisible()
  await expect(working).toHaveCount(0)
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('06-mocked-reloaded-terminal.png') })
  expect(api.unexpectedRequests).toEqual([])
})
