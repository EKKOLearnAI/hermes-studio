import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('sends a chat run and renders streamed Socket.IO response events', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await expect(input).toBeVisible()
  await input.fill('Summarize the queue')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('p').filter({ hasText: /^Summarize the queue$/ })).toBeVisible()

  const socketState = await page.waitForFunction(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    return state?.emitted?.some((item: any) => item.event === 'run')
      ? {
          socket: {
            url: state.latest.url,
            options: state.latest.options,
          },
          emitted: state.emitted,
        }
      : null
  })
  const { socket, emitted } = await socketState.jsonValue() as any
  const run = emitted.find((item: any) => item.event === 'run')

  expect(socket.url).toBe('/chat-run')
  expect(socket.options.auth).toEqual({ token: TEST_ACCESS_KEY })
  expect(socket.options.query).toEqual({ profile: 'research' })
  expect(run.payload).toMatchObject({
    input: 'Summarize the queue',
    queue_id: expect.any(String),
    session_id: expect.any(String),
    source: 'api_server',
  })
  expect(run.payload.model).toBe('test-model')

  const sessionId = run.payload.session_id
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
  }, sessionId)

  await expect(page.getByText('Streaming answer from Hermes')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})
