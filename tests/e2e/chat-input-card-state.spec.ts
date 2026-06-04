import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

test('chat input card toggles send state and clears after Enter submit', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  const input = page.getByPlaceholder(inputPlaceholder)
  const sendButton = page.getByRole('button', { name: 'Send' })
  await expect(input).toBeVisible()
  await expect(sendButton).toBeDisabled()

  await input.fill('   ')
  await expect(sendButton).toBeDisabled()

  await input.fill('Draft line')
  await expect(sendButton).toBeEnabled()

  await input.press('Shift+Enter')
  await input.type('second line')
  await expect(input).toHaveValue('Draft line\nsecond line')
  await expect(sendButton).toBeEnabled()

  await input.press('Enter')

  const run = await page.waitForFunction(() => {
    const emitted = (window as any).__PW_CHAT_SOCKET__?.emitted || []
    return emitted.find((item: any) => item.event === 'run')?.payload || null
  })
  await expect(input).toHaveValue('')
  await expect(sendButton).toBeDisabled()
  expect(await run.jsonValue()).toMatchObject({
    input: 'Draft line\nsecond line',
    source: 'cli',
  })
  expect(api.unexpectedRequests).toEqual([])
})
