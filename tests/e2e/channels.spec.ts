import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('clears a saved channel credential after confirmation', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    channelCredentials: true,
    channelConfig: {
      platforms: {
        telegram: {
          token: 'telegram-token',
          proxy: 'socks5://proxy.example',
        },
      },
    },
  })

  await page.goto('/#/hermes/channels')

  await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible()
  const telegramCard = page.locator('.platform-card').filter({ hasText: 'Telegram' }).first()
  const clearButton = telegramCard.getByRole('button', { name: 'Clear credentials' })
  await expect(clearButton).toBeEnabled()

  await clearButton.click()
  await expect(page.getByText('Clear stored credentials for "Telegram"?')).toBeVisible()
  await page.getByRole('button', { name: 'Clear credentials' }).last().click()

  await expect(page.getByText('Channel credentials cleared')).toBeVisible()
  const clearRequest = api.requests.find((request) => (
    request.method === 'DELETE' &&
    request.pathname === '/api/hermes/config/credentials/telegram'
  ))
  expect(clearRequest?.headers.authorization).toBe(`Bearer ${TEST_ACCESS_KEY}`)
  expect(clearRequest?.headers['x-hermes-profile']).toBe('research')
  expect(api.unexpectedRequests).toEqual([])
})
