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

test('renders tool trace and sends explicit approval decisions over the chat-run socket', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Use write_file with approval')
  const { run } = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-approval' })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-approval',
      tool_call_id: 'tool-call-1',
      tool: 'write_file',
      preview: 'Writing approved file',
      arguments: JSON.stringify({ path: '/tmp/approved.txt', content: 'hello' }),
    })
    socket.__trigger('approval.requested', {
      event: 'approval.requested',
      session_id: sid,
      run_id: 'run-approval',
      approval_id: 'approval-1',
      command: 'write_file /tmp/approved.txt',
      description: 'Allow write_file to create /tmp/approved.txt',
      choices: ['once', 'deny'],
      allow_permanent: false,
    })
  }, run.session_id)

  await expect(page.getByText('write_file', { exact: true })).toBeVisible()
  await expect(page.getByText('Writing approved file')).toBeVisible()
  await expect(page.locator('.message.tool .tool-line')).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'write_file' })).toBeVisible()
  await expect(page.getByText('Allow write_file to create /tmp/approved.txt')).toBeVisible()
  await expect(page.getByText('write_file /tmp/approved.txt')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow session' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible()

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('approval.resolved', {
      event: 'approval.resolved',
      session_id: sid,
      run_id: 'run-approval',
      approval_id: 'approval-other',
      choice: 'deny',
      resolved: true,
    })
  }, run.session_id)
  await expect(page.getByText('Allow write_file to create /tmp/approved.txt')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible()

  await page.getByRole('button', { name: 'Allow once' }).click()

  await expect(page.getByText('Allow write_file to create /tmp/approved.txt')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0)
  await expect.poll(async () => page.evaluate(() => {
    const emitted = (window as any).__PW_CHAT_SOCKET__.emitted
    return emitted.filter((item: any) => item.event === 'approval.respond')
  })).toEqual([
    {
      event: 'approval.respond',
      payload: {
        session_id: run.session_id,
        approval_id: 'approval-1',
        choice: 'once',
      },
    },
  ])

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('approval.resolved', {
      event: 'approval.resolved',
      session_id: sid,
      run_id: 'run-approval',
      approval_id: 'approval-1',
      choice: 'once',
      resolved: true,
    })
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-approval',
      tool_call_id: 'tool-call-1',
      tool: 'write_file',
      output: JSON.stringify({ ok: true, path: '/tmp/approved.txt' }),
      duration: 42,
    })
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-approval',
      delta: 'Delta-only approved tool result.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-approval',
      output: 'Completion fallback should stay hidden.',
    })
  }, run.session_id)

  const persistedToolTrace = page.locator('.message.tool .tool-line').filter({ hasText: 'write_file' })
  await expect(persistedToolTrace).toHaveCount(1)
  await persistedToolTrace.click()
  const toolDetails = page.locator('.message.tool .tool-details')
  await expect(toolDetails).toContainText('/tmp/approved.txt')
  await expect(toolDetails).toContainText('ok')
  await expect(page.getByText('Delta-only approved tool result.')).toBeVisible()
  await expect(page.getByText('Completion fallback should stay hidden.')).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'write_file' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps prior tool trace visible while hiding only the active run tool trace', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'First tool trace')
  const first = await waitForRun(page)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-history-1' })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-history-1',
      tool_call_id: 'tool-history-1',
      tool: 'read_file',
      preview: 'Read historical file',
      arguments: JSON.stringify({ path: '/tmp/history.txt' }),
    })
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-history-1',
      tool_call_id: 'tool-history-1',
      tool: 'read_file',
      output: JSON.stringify({ ok: true, path: '/tmp/history.txt' }),
      duration: 12,
    })
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-history-1',
      delta: 'First tool answer.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-history-1',
      output: 'First fallback should stay hidden.',
    })
  }, first.run.session_id)

  const transcriptTools = page.locator('.message.tool .tool-line')
  await expect(transcriptTools.filter({ hasText: 'read_file' })).toHaveCount(1)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toHaveCount(0)

  await sendChatMessage(page, 'Second tool trace')
  const second = await waitForRun(page, 1)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-history-2' })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-history-2',
      tool_call_id: 'tool-history-2',
      tool: 'write_file',
      preview: 'Write current file',
      arguments: JSON.stringify({ path: '/tmp/current.txt', content: 'now' }),
    })
  }, second.run.session_id)

  await expect(transcriptTools.filter({ hasText: 'read_file' })).toHaveCount(1)
  await expect(transcriptTools.filter({ hasText: 'write_file' })).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'write_file' })).toHaveCount(1)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-history-2',
      tool_call_id: 'tool-history-2',
      tool: 'write_file',
      output: JSON.stringify({ ok: true, path: '/tmp/current.txt' }),
      duration: 15,
    })
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-history-2',
      delta: 'Second tool answer.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-history-2',
      output: 'Second fallback should stay hidden.',
    })
  }, second.run.session_id)

  await expect(transcriptTools).toHaveCount(2)
  await expect(transcriptTools.filter({ hasText: 'read_file' })).toHaveCount(1)
  await expect(transcriptTools.filter({ hasText: 'write_file' })).toHaveCount(1)
  await expect(page.getByText('First fallback should stay hidden.')).toHaveCount(0)
  await expect(page.getByText('Second fallback should stay hidden.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps completed same-run tool traces hidden until the run finishes', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Run multiple tools')
  const { run } = await waitForRun(page)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-multi-tool' })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-multi-tool',
      tool_call_id: 'tool-multi-1',
      tool: 'read_file',
      preview: 'Read config',
      arguments: JSON.stringify({ path: '/tmp/config.json' }),
    })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-multi-tool',
      tool_call_id: 'tool-multi-2',
      tool: 'shell_exec',
      preview: 'Run command',
      arguments: JSON.stringify({ command: 'false' }),
    })
  }, run.session_id)

  const transcriptTools = page.locator('.message.tool .tool-line')
  await expect(transcriptTools).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toHaveCount(1)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'shell_exec' })).toHaveCount(1)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-multi-tool',
      tool_call_id: 'tool-multi-1',
      tool: 'read_file',
      output: JSON.stringify({ ok: true, path: '/tmp/config.json' }),
      duration: 11,
    })
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-multi-tool',
      tool_call_id: 'tool-multi-2',
      tool: 'shell_exec',
      output: 'exit status 1',
      error: true,
      duration: 13,
    })
  }, run.session_id)

  await expect(transcriptTools).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toHaveCount(1)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'shell_exec' })).toHaveCount(1)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-multi-tool',
      delta: 'Multiple tools finished.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-multi-tool',
      output: 'Multi-tool fallback should stay hidden.',
    })
  }, run.session_id)

  await expect(transcriptTools).toHaveCount(2)
  await expect(transcriptTools.filter({ hasText: 'read_file' })).toHaveCount(1)
  await expect(transcriptTools.filter({ hasText: 'shell_exec' })).toHaveCount(1)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'shell_exec' })).toHaveCount(0)
  await expect(page.locator('.message.tool .tool-error-badge')).toHaveCount(1)
  await transcriptTools.filter({ hasText: 'shell_exec' }).click()
  await expect(page.locator('.message.tool .tool-details')).toContainText('exit status 1')
  await expect(page.getByText('Multi-tool fallback should stay hidden.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps unnamed tool trace messages out of the transcript after completion', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Run internal unnamed tool')
  const { run } = await waitForRun(page)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-unnamed-tool' })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-unnamed-tool',
      tool_call_id: 'tool-unnamed-1',
      preview: 'Internal unnamed work',
      arguments: JSON.stringify({ internal: true }),
    })
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-unnamed-tool',
      tool_call_id: 'tool-unnamed-1',
      output: JSON.stringify({ internal: true, ok: true }),
      duration: 9,
    })
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-unnamed-tool',
      delta: 'Unnamed internal tool finished.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-unnamed-tool',
      output: 'Unnamed fallback should stay hidden.',
    })
  }, run.session_id)

  await expect(page.locator('.message.tool .tool-line')).toHaveCount(0)
  await expect(page.getByText('Unnamed internal tool finished.')).toBeVisible()
  await expect(page.getByText('Unnamed fallback should stay hidden.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps unnamed resumed tool traces hidden after session reload', async ({ page }) => {
  const sessionId = 'session-history-unnamed-tool'
  const sessionSummary = {
    id: sessionId,
    source: 'api_server',
    model: 'test-model',
    title: 'Unnamed tool history',
    preview: 'History answer visible.',
    started_at: 1,
    ended_at: 4,
    last_active: 4,
    message_count: 4,
    tool_call_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: 'test-provider',
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: 'none',
    workspace: null,
  }
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript((sid) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [sid]: {
        session_id: sid,
        isWorking: false,
        events: [],
        messages: [
          {
            id: 1,
            session_id: sid,
            role: 'user',
            content: 'Resume unnamed internal tool',
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
            session_id: sid,
            role: 'assistant',
            content: '',
            tool_call_id: null,
            tool_calls: [{ id: 'tool-resume-unnamed-1', type: 'function', function: { arguments: JSON.stringify({ internal: true }) } }],
            tool_name: null,
            timestamp: 2,
            token_count: null,
            finish_reason: 'tool_calls',
            reasoning: null,
          },
          {
            id: 3,
            session_id: sid,
            role: 'tool',
            content: JSON.stringify({ internal: true, ok: true }),
            tool_call_id: 'tool-resume-unnamed-1',
            tool_calls: null,
            tool_name: null,
            timestamp: 3,
            token_count: null,
            finish_reason: null,
            reasoning: null,
          },
          {
            id: 4,
            session_id: sid,
            role: 'assistant',
            content: 'History answer visible.',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 4,
            token_count: null,
            finish_reason: 'stop',
            reasoning: null,
          },
        ],
      },
    }
  }, sessionId)
  const api = await mockHermesApi(page, { sessions: [sessionSummary] })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await expect(page.getByText('History answer visible.')).toBeVisible()
  await expect(page.locator('.message.tool .tool-line')).toHaveCount(0)
  await expect(page.locator('.message.tool')).toHaveCount(0)
  const resumeRequest = await page.waitForFunction((sid) => {
    const state = (window as any).__PW_CHAT_SOCKET__
    return state?.emitted?.some((item: any) => item.event === 'resume' && item.payload?.session_id === sid)
  }, sessionId)
  expect(await resumeRequest.jsonValue()).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('restores named resumed tool traces from assistant tool calls after session reload', async ({ page }) => {
  const sessionId = 'session-history-named-tool'
  const sessionSummary = {
    id: sessionId,
    source: 'api_server',
    model: 'test-model',
    title: 'Named tool history',
    preview: 'Named history answer visible.',
    started_at: 1,
    ended_at: 4,
    last_active: 4,
    message_count: 4,
    tool_call_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: 'test-provider',
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: 'none',
    workspace: null,
  }
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript((sid) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [sid]: {
        session_id: sid,
        isWorking: false,
        events: [],
        messages: [
          {
            id: 1,
            session_id: sid,
            role: 'user',
            content: 'Resume named tool',
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
            session_id: sid,
            role: 'assistant',
            content: '',
            tool_call_id: null,
            tool_calls: [{ id: 'tool-resume-named-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/history.txt' }) } }],
            tool_name: null,
            timestamp: 2,
            token_count: null,
            finish_reason: 'tool_calls',
            reasoning: null,
          },
          {
            id: 3,
            session_id: sid,
            role: 'tool',
            content: JSON.stringify({ ok: true, path: '/tmp/history.txt' }),
            tool_call_id: 'tool-resume-named-1',
            tool_calls: null,
            tool_name: null,
            timestamp: 3,
            token_count: null,
            finish_reason: null,
            reasoning: null,
          },
          {
            id: 4,
            session_id: sid,
            role: 'assistant',
            content: 'Named history answer visible.',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 4,
            token_count: null,
            finish_reason: 'stop',
            reasoning: null,
          },
        ],
      },
    }
  }, sessionId)
  const api = await mockHermesApi(page, { sessions: [sessionSummary] })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await expect(page.getByText('Named history answer visible.')).toBeVisible()
  const restoredTrace = page.locator('.message.tool .tool-line').filter({ hasText: 'read_file' })
  await expect(restoredTrace).toHaveCount(1)
  await restoredTrace.click()
  await expect(page.locator('.message.tool .tool-details')).toContainText('/tmp/history.txt')
  expect(api.unexpectedRequests).toEqual([])
})
