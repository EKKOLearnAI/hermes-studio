import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('shows independent APK, Google Play, and iOS versions', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/connections?view=download')

  await expect(page.getByText('APK v1.0.0', { exact: true })).toBeVisible()
  await expect(page.getByText('Google Play v1.0.1', { exact: true })).toBeVisible()
  await expect(page.getByText('iOS v1.1.0', { exact: true })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})
