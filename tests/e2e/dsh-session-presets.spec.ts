import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const mobile of [false, true]) test(`selects a DSH mode for a new chat (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/coding-agents', route => route.fulfill({ json: { tools: [{ id: 'dsh', name: 'DeepSeek Harness', installed: true }] } }))
  let unavailable = true, reads = 0
  await page.route('**/api/coding-agents/dsh/session-presets', route => {
    reads++
    return route.fulfill(unavailable ? { status: 503, json: { error: 'Unavailable' } } : { json: { presets: [
      { id: 'standard', name: 'Standard mode', description: 'File editing and delegation.', isDefault: true },
      { id: 'minimal', name: 'Minimal mode', description: 'A minimal set of tools for this chat.', isDefault: false },
      { id: 'broken', name: 'Broken mode', unavailable: true, isDefault: false },
    ] } })
  })
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const drawer = page.locator('.new-chat-drawer')
  const agent = drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first()
  await expect(page.getByTestId('dsh-session-preset')).toHaveCount(0)
  expect(reads).toBe(0)
  await agent.locator('.n-base-selection').click()
  await page.locator('.n-base-select-option:visible').filter({ hasText: /^DeepSeek Harness$/ }).click()
  const field = page.getByTestId('dsh-session-preset')
  await expect(field.getByRole('alert')).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  unavailable = false
  await field.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(field).toContainText('Standard mode (Default)')
  await field.locator('.n-base-selection').click()
  await expect(page.locator('.n-base-select-option:visible').filter({ hasText: /^Broken mode$/ })).toHaveClass(/disabled/)
  await page.locator('.n-base-select-option:visible').filter({ hasText: /^Minimal mode$/ }).click()
  await expect(field).toContainText('A minimal set of tools for this chat.')
  // Both global and scoped launches share the same independent Agent preset.
  if (mobile) await drawer.getByText('Global config', { exact: true }).click()
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  await page.screenshot({ animations: 'disabled', path: `/tmp/dsh-session-mode-${mobile ? 'mobile' : 'desktop'}.png` })
  await drawer.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/#\/hermes\/session\//)
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('Use the tools for my selected mode')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({ coding_agent_id: 'dsh', agent_preset: 'minimal', mode: mobile ? 'global' : 'scoped' })
  expect(api.unexpectedRequests).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
