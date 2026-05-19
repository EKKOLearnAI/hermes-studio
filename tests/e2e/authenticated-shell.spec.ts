import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('renders authenticated shell and navigates between key product routes', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/jobs')

  await expect(page.getByRole('heading', { name: 'Scheduled Jobs' })).toBeVisible()
  await expect(page.getByText('Nightly Smoke')).toBeVisible()

  const jobsRequest = api.requests.find((request) => request.pathname === '/api/hermes/jobs')
  expect(jobsRequest?.headers.authorization).toBe(`Bearer ${TEST_ACCESS_KEY}`)
  expect(jobsRequest?.headers['x-hermes-profile']).toBe('research')

  await page.locator('aside.sidebar').getByRole('button', { name: /^Models$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/models$/)
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
  await expect(page.getByText('test-model').first()).toBeVisible()

  await page.locator('aside.sidebar').getByRole('button', { name: /^Settings$/ }).click()
  await expect(page).toHaveURL(/#\/hermes\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})
