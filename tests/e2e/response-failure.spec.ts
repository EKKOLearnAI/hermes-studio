import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('shows a durable failure beside a short partial response and restores it on reopening', async ({ page }) => {
  // Deterministic simulated failure; not a live provider request. Real app + socket dispatch.
  const sessions: any[] = []
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { sessions })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('Draft a short PRD — simulated failure review')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const run = await (await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted.find((item: any) => item.event === 'run')?.payload)).jsonValue()
  const sid = run.session_id
  const failure = { id: '3', runMarker: 'review-run', code: 'unavailable', status: 503 }
  await page.evaluate(({ sid, failure }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: failure.runMarker })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: failure.runMarker, delta: 'I will draft the PRD now.' })
    socket.__trigger('run.failed', { event: 'run.failed', session_id: sid, run_id: failure.runMarker, failure, error: 'Agent run failed (unavailable)', queue_remaining: 0 })
    socket.__trigger('run.failed', { event: 'run.failed', session_id: sid, run_id: failure.runMarker, failure, queue_remaining: 0 })
  }, { sid, failure })
  const notice = page.locator('.run-failure-notice')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('Response stopped unexpectedly')
  await expect(notice).toContainText('The provider could not complete this response.')
  await expect(page.getByText('I will draft the PRD now.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  const dir = process.env.HERMES_VISUAL_EVIDENCE_DIR
  if (dir) mkdirSync(dir, { recursive: true })
  if (dir) await page.screenshot({ path: join(dir, '01-collapsed-failure.png'), fullPage: true, animations: 'disabled' })
  await notice.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(notice.locator('details')).toHaveAttribute('open', '')
  await expect(notice.getByText('HTTP 503')).toBeVisible()
  if (dir) await page.screenshot({ path: join(dir, '02-expanded-safe-details.png'), fullPage: true, animations: 'disabled' })

  sessions.push({ id: sid, source: 'cli', profile: 'research', title: 'Simulated failure review', model: 'test-model', started_at: 1, ended_at: 3, message_count: 3, tool_call_count: 0, end_reason: 'error' })
  await page.addInitScript(({ sid, failure }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sid]: { session_id: sid, isWorking: false, events: [], messages: [
      { id: 1, role: 'user', content: 'Draft a short PRD — simulated failure review', timestamp: 1 },
      { id: 2, role: 'assistant', content: 'I will draft the PRD now.', timestamp: 2 },
      { id: 3, role: 'run_failure', content: JSON.stringify({ code: failure.code, status: failure.status }), run_marker: failure.runMarker, timestamp: 3 },
    ] } }
  }, { sid, failure })
  await page.reload()
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('Response stopped unexpectedly')
  await expect(page.getByText('I will draft the PRD now.', { exact: true })).toBeVisible()
  await expect(notice.locator('details')).not.toHaveAttribute('open', '')
  if (dir) await page.screenshot({ path: join(dir, '03-reopened-failure.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(notice).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  if (dir) await page.screenshot({ path: join(dir, '04-mobile-failure.png'), fullPage: true, animations: 'disabled' })
  expect(api.unexpectedRequests).toEqual([])
})

test('a user stop preserves partial text without showing an unexpected-failure notice', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('Manual stop — simulated review')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const run = await (await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted.find((item: any) => item.event === 'run')?.payload)).jsonValue()
  await page.evaluate(sid => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'stop-run' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'stop-run', delta: 'I will draft the PRD now.' })
  }, run.session_id)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__.emitted.some((item: any) => item.event === 'abort'))
  await page.evaluate(sid => (window as any).__PW_CHAT_SOCKET__.latest.__trigger('abort.completed', { event: 'abort.completed', session_id: sid, run_id: 'stop-run', synced: true }), run.session_id)
  await expect(page.getByText('I will draft the PRD now.', { exact: true })).toBeVisible()
  await expect(page.locator('.run-failure-notice')).toHaveCount(0)
  await expect(page.getByText('Pausing... waiting for the run to stop and sync', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  if (process.env.HERMES_VISUAL_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.HERMES_VISUAL_EVIDENCE_DIR, '05-user-stop-no-failure.png'), fullPage: true, animations: 'disabled' })
})
