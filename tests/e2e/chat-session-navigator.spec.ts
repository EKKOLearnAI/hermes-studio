import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const nowSeconds = Math.floor(Date.now() / 1000)

const longSessionMessages = [
  { id: 'u1', role: 'user', content: 'First long-session prompt', timestamp: nowSeconds - 90 },
  { id: 'a1', role: 'assistant', content: 'First answer\n\n'.repeat(30), timestamp: nowSeconds - 80 },
  { id: 'u2', role: 'user', content: 'Second long-session prompt', timestamp: nowSeconds - 70 },
  { id: 'a2', role: 'assistant', content: 'Second answer\n\n'.repeat(30), timestamp: nowSeconds - 60 },
  { id: 'u3', role: 'user', content: 'Third long-session prompt', timestamp: nowSeconds - 50 },
  { id: 'a3', role: 'assistant', content: 'Third answer\n\n'.repeat(30), timestamp: nowSeconds - 40 },
  { id: 'u4', role: 'user', content: 'Fourth long-session prompt', timestamp: nowSeconds - 30 },
  { id: 'a4', role: 'assistant', content: 'Fourth answer\n\n'.repeat(30), timestamp: nowSeconds - 20 },
]

async function openLongChat(
  page: import('@playwright/test').Page,
  messages = longSessionMessages,
  sessionId = 'long-session',
) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(({ sessionId, messages }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [sessionId]: {
        session_id: sessionId,
        isWorking: false,
        queueLength: 0,
        messages,
        events: [],
      },
    }
  }, { sessionId, messages })
  const api = await mockHermesApi(page, {
    sessions: [
      {
        id: sessionId,
        title: 'Long navigator session',
        source: 'cli',
        started_at: nowSeconds - 1000,
        last_active: nowSeconds,
        message_count: messages.length,
        profile: 'research',
      },
    ],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  return api
}

test('shows compact conversation navigator for long chat sessions', async ({ page }) => {
  const api = await openLongChat(page)

  const navigator = page.getByTestId('conversation-navigator')
  await expect(navigator).toBeVisible()
  await expect(navigator.getByRole('button')).toHaveCount(4)

  const turnTwo = navigator.getByRole('button', { name: /Turn 2:/ })
  await turnTwo.hover()
  await expect(navigator.locator('.conversation-nav-tooltip')).toBeVisible()
  await expect(navigator.locator('.conversation-nav-tooltip')).toContainText('Second long-session prompt')

  await page.evaluate(() => {
    ;(window as any).__NAV_SCROLL_CALLS__ = []
    const originalScrollTo = HTMLElement.prototype.scrollTo
    HTMLElement.prototype.scrollTo = function scrollToWithCapture(...args: any[]) {
      ;(window as any).__NAV_SCROLL_CALLS__.push(args[0])
      return originalScrollTo.apply(this, args as any)
    }
  })

  await navigator.getByRole('button', { name: /Turn 3:/ }).click()
  await expect(page.locator('#message-u3')).toBeInViewport()
  await expect.poll(async () => page.evaluate(() =>
    ((window as any).__NAV_SCROLL_CALLS__ || []).some((call: any) => call?.behavior === 'smooth'),
  )).toBe(true)

  expect(api.unexpectedRequests).toEqual([])
})

test('keeps conversation navigator unobtrusive across desktop tablet and narrow widths', async ({ page }) => {
  const api = await openLongChat(page)

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/#/hermes/chat')

    const navigator = page.getByTestId('conversation-navigator')
    const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
    await expect(navigator).toBeVisible()
    await expect(input).toBeVisible()

    const navBox = await navigator.boundingBox()
    const inputBox = await input.boundingBox()
    expect(navBox).not.toBeNull()
    expect(inputBox).not.toBeNull()
    expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(viewport.width)
    expect(navBox!.x).toBeGreaterThanOrEqual(0)
    expect(navBox!.y + navBox!.height).toBeLessThan(inputBox!.y)

    const rightPadding = await page.locator('.virtual-message-list').evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))
    expect(rightPadding).toBeGreaterThanOrEqual(44)

    await page.locator('.virtual-message-list').evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await expect(page.getByLabel('Scroll to bottom')).toHaveCount(0)
  }

  expect(api.unexpectedRequests).toEqual([])
})

test('bounds the navigator rail for very long sessions', async ({ page }) => {
  const manyTurnMessages = Array.from({ length: 36 }, (_, index) => ({
    id: `u-many-${index + 1}`,
    role: 'user',
    content: `Long session prompt ${index + 1}`,
    timestamp: nowSeconds - 500 + index,
  }))

  const api = await openLongChat(page, manyTurnMessages, 'many-turn-session')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/hermes/chat')

  const navigator = page.getByTestId('conversation-navigator')
  await expect(navigator).toBeVisible()
  await expect(navigator.getByRole('button')).toHaveCount(36)

  const navBox = await navigator.boundingBox()
  expect(navBox).not.toBeNull()
  expect(navBox!.height).toBeLessThanOrEqual(844 * 0.72)
  expect(navBox!.y).toBeGreaterThanOrEqual(0)
  expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(844)

  expect(api.unexpectedRequests).toEqual([])
})
