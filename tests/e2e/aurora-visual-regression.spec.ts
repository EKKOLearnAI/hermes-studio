import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, mockTerminalWebSocket, TEST_ACCESS_KEY } from './fixtures'

const launcherInputPlaceholder = 'What would you like to build or do today?'
const inputPlaceholder = /^(What would you like to build or do today\?|Type a message\.\.\. \(Enter to send, Shift\+Enter for new line\))$/

type Rect = {
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

function getOmniInput(page: Page) {
  return page.getByPlaceholder(inputPlaceholder)
}

async function openAurora(page: Page) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await mockTerminalWebSocket(page)
  await page.goto('/#/hermes/chat')
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  return api
}

async function sendOmniIntent(page: Page, message: string) {
  const input = getOmniInput(page)
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
          run: run.payload,
          emitted: state.emitted,
        }
      : null
  }, index)
  return handle.jsonValue() as Promise<any>
}

async function triggerSocket(page: Page, event: string, payload: unknown) {
  await page.evaluate(({ eventName, socketPayload }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__?.latest
    socket?.__trigger(eventName, socketPayload)
  }, { eventName: event, socketPayload: payload })
}

async function rectFor(page: Page, selector: string): Promise<Rect> {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    }
  })
}

function overlaps(a: Rect, b: Rect) {
  return !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y)
}

test('sanitizes raw tool markup and keeps Aurora floating panels separated', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'raw tool visual smoke')
  const { run } = await waitForRun(page)
  const rawToolMarkup = [
    'I will inspect this safely.',
    '<function=terminal><parameter=command>curl -s https://example.invalid | grep token</parameter></function>',
    '</tool_call>',
  ].join('\n')

  await triggerSocket(page, 'run.started', {
    event: 'run.started',
    session_id: run.session_id,
    run_id: 'run-raw-tool-visual',
  })
  await triggerSocket(page, 'message.delta', {
    event: 'message.delta',
    session_id: run.session_id,
    run_id: 'run-raw-tool-visual',
    delta: rawToolMarkup,
  })
  await triggerSocket(page, 'run.completed', {
    event: 'run.completed',
    session_id: run.session_id,
    run_id: 'run-raw-tool-visual',
    output: rawToolMarkup,
    inputTokens: 6,
    outputTokens: 8,
  })

  await expect(page.locator('.legacy-tool-line.terminal')).toBeVisible()
  await expect(page.locator('.legacy-tool-line.terminal')).toContainText('Terminal')
  await expect(page.locator('.legacy-tool-line.terminal')).toContainText('curl -s https://example.invalid | grep token')
  const bodyText = await page.locator('body').innerText()
  expect(bodyText).not.toContain('<function=')
  expect(bodyText).not.toContain('<parameter=')
  expect(bodyText).not.toContain('</tool_call>')

  await page.locator('.aurora-status-toggle').click()
  await expect(page.locator('.aurora-status-panel')).toBeVisible()
  await page.locator('.memory-review-toggle').click()
  await expect(page.locator('.memory-review-queue')).toBeVisible()

  const statusPanel = await rectFor(page, '.aurora-status-panel')
  const memoryQueue = await rectFor(page, '.memory-review-queue')
  expect(overlaps(statusPanel, memoryQueue)).toBe(false)
  expect(api.unexpectedRequests).toEqual([])
})

test('opens MiroFish Grand Merge without leaking shell panels or clipping the verdict', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'prime Aurora chat stream')
  const { run } = await waitForRun(page)
  await triggerSocket(page, 'run.started', {
    event: 'run.started',
    session_id: run.session_id,
    run_id: 'run-prime-visual',
  })
  await triggerSocket(page, 'message.delta', {
    event: 'message.delta',
    session_id: run.session_id,
    run_id: 'run-prime-visual',
    delta: 'Aurora shell is ready.',
  })
  await triggerSocket(page, 'run.completed', {
    event: 'run.completed',
    session_id: run.session_id,
    run_id: 'run-prime-visual',
    output: 'Aurora shell is ready.',
    inputTokens: 4,
    outputTokens: 4,
  })

  await page.locator('.aurora-status-toggle').click()
  await expect(page.locator('.aurora-status-panel')).toBeVisible()
  await page.locator('.memory-review-toggle').click()
  await expect(page.locator('.memory-review-queue')).toBeVisible()

  await sendOmniIntent(page, 'MiroFish TSLA')
  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.mirofish-app-entry')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'MiroFish Grand Merge' })).toBeVisible()
  await expect(page.locator('.aurora-status-panel')).toHaveCount(0)
  await expect(page.locator('.memory-review-queue')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  const agentCards = page.locator('.mirofish-app-entry .agent-card')
  await expect(agentCards).toHaveCount(3)
  await expect.poll(
    async () => page.locator('.mirofish-app-entry .agent-card.visible').count(),
    { timeout: 5_000 },
  ).toBe(3)

  const cardRects = await agentCards.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect()
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    }
  }))
  expect(cardRects.every(rect => rect.width >= 240)).toBe(true)
  expect(Math.max(...cardRects.map(rect => rect.y)) - Math.min(...cardRects.map(rect => rect.y))).toBeLessThan(48)

  const verdict = await rectFor(page, '.mirofish-app-entry .scenario-drilldown.core-agent-delta')
  const viewportHeight = await page.evaluate(() => window.innerHeight)
  expect(verdict.bottom).toBeLessThanOrEqual(viewportHeight + 24)
  expect(api.unexpectedRequests).toEqual([])
})
