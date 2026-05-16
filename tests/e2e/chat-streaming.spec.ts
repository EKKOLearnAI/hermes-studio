import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

async function sendChatMessage(page: Page, message: string) {
  const input = page.getByPlaceholder(inputPlaceholder)
  await expect(input).toBeVisible()
  await input.fill(message)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function waitForRun(page: Page, index = 0) {
  const handle = await page.waitForFunction((runIndex) => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const runs = state?.emitted?.filter((item: any) => item.event === 'run') || []
    const run = runs[runIndex]
    return run
      ? {
          socket: {
            url: state.latest.url,
            options: state.latest.options,
          },
          run: run.payload,
          runCount: runs.length,
          socketCount: state.sockets.length,
        }
      : null
  }, index)
  return handle.jsonValue() as Promise<any>
}

test('sends a chat run and renders streamed Socket.IO response events', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Summarize the queue')

  await expect(page.locator('p').filter({ hasText: /^Summarize the queue$/ })).toBeVisible()

  const { socket, run } = await waitForRun(page)

  expect(socket.url).toBe('/chat-run')
  expect(socket.options.auth).toEqual({ token: TEST_ACCESS_KEY })
  expect(socket.options.query).toEqual({ profile: 'research' })
  expect(run).toMatchObject({
    input: 'Summarize the queue',
    queue_id: expect.any(String),
    session_id: expect.any(String),
    source: 'api_server',
  })
  expect(run.model).toBe('test-model')

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-1' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-1', delta: 'Streaming ' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-1', delta: 'answer from Hermes' })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-1',
      output: 'Streaming answer from Hermes',
      inputTokens: 11,
      outputTokens: 7,
    })
  }, run.session_id)

  await expect(page.getByText('Streaming answer from Hermes')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('uses the newly selected profile for the next chat-run socket after profile switch reload', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'default')
  const api = await mockHermesApi(page, { initialProfileName: 'default' })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  await expect(page.getByTestId('profile-selector-select').filter({ hasText: 'default' })).toBeVisible()

  await sendChatMessage(page, 'Warm up default socket')
  const defaultRun = await waitForRun(page)
  expect(defaultRun.socket.options.query).toEqual({ profile: 'default' })
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-default' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-default', delta: 'Default profile reply' })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-default',
      output: 'Default profile reply',
    })
  }, defaultRun.run.session_id)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)

  await page.locator('[data-testid="profile-selector-select"] .n-base-selection').click()
  const reloadPromise = page.waitForEvent('framenavigated', frame => frame === page.mainFrame())
  await page.locator('.n-base-select-option', { hasText: /^research$/ }).click()
  await reloadPromise
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('profile-selector-select').filter({ hasText: 'research' })).toBeVisible()

  await sendChatMessage(page, 'Use the active research profile')
  const { socket, run } = await waitForRun(page)

  expect(socket.url).toBe('/chat-run')
  expect(socket.options.auth).toEqual({ token: TEST_ACCESS_KEY })
  expect(socket.options.query).toEqual({ profile: 'research' })
  expect(run.input).toBe('Use the active research profile')
  expect(await page.evaluate(() => window.localStorage.getItem('hermes_active_profile_name'))).toBe('research')

  const switchRequest = api.requests.find((request) => request.pathname === '/api/hermes/profiles/active')
  expect(switchRequest?.method).toBe('PUT')
  expect(switchRequest?.postData).toBe(JSON.stringify({ name: 'research' }))
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps queued runs on one socket and does not duplicate streamed handlers', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'First queued contract')
  const first = await waitForRun(page)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-1', queue_length: 1 })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-1', delta: 'First answer' })
  }, first.run.session_id)
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()

  await sendChatMessage(page, 'Second queued contract')
  const second = await waitForRun(page, 1)

  expect(second.socketCount).toBe(1)
  expect(second.runCount).toBe(2)
  expect(second.run.session_id).toBe(first.run.session_id)
  expect(second.run.input).toBe('Second queued contract')

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-1',
      output: 'First answer',
      queue_remaining: 1,
    })
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-2', queue_length: 0 })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-2', delta: 'Second answer' })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-2',
      output: 'Second answer',
      queue_remaining: 0,
    })
  }, first.run.session_id)

  await expect(page.locator('p').filter({ hasText: /^First answer$/ })).toHaveCount(1)
  await expect(page.locator('p').filter({ hasText: /^Second queued contract$/ })).toHaveCount(1)
  await expect(page.locator('p').filter({ hasText: /^Second answer$/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('clears previous compression status when a new run starts', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Trigger compression before answering')
  const first = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-1' })
    socket.__trigger('compression.completed', {
      event: 'compression.completed',
      session_id: sid,
      totalMessages: 12,
      beforeTokens: 24000,
      afterTokens: 6000,
      compressed: true,
    })
  }, first.run.session_id)

  await expect(page.getByText(/Compressed 12 msgs/)).toBeVisible()

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-1',
      output: 'First answer',
    })
  }, first.run.session_id)

  await sendChatMessage(page, 'Start another turn')
  const second = await waitForRun(page, 1)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-2' })
  }, second.run.session_id)

  await expect(page.getByText(/Compressed 12 msgs/)).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('surfaces an empty completed run as an error instead of leaving chat stalled', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Call a broken provider')
  const { run } = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-empty' })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-empty',
      output: '',
      inputTokens: 0,
      outputTokens: 0,
    })
  }, run.session_id)

  await expect(page.getByText(/Agent returned no output/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})
