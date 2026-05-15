import { expect, test } from '@playwright/test'
import { mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('redirects protected routes to the login screen without a token', async ({ page }) => {
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/jobs')

  await expect(page).toHaveURL(/#\/$/)
  await expect(page.getByRole('heading', { name: 'Hermes Web UI' })).toBeVisible()
  await expect(page.getByPlaceholder('Access token')).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('rejects an invalid access token without persisting it', async ({ page }) => {
  const api = await mockHermesApi(page, { tokenValidationStatus: 401 })

  await page.goto('/')
  await page.getByPlaceholder('Access token').fill('bad-token')
  await page.getByRole('button', { name: 'Login' }).click()

  await expect(page.getByText('Invalid token')).toBeVisible()
  await expect(page).toHaveURL(/#\/$/)
  await expect(page.evaluate(() => window.localStorage.getItem('hermes_api_key'))).resolves.toBeNull()
  expect(api.unexpectedRequests).toEqual([])
})

test('validates token login through the BFF before entering the app', async ({ page }) => {
  const api = await mockHermesApi(page)

  await page.goto('/')
  await page.getByPlaceholder('Access token').fill(TEST_ACCESS_KEY)
  await page.getByRole('button', { name: 'Login' }).click()

  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  await expect(page.evaluate(() => window.localStorage.getItem('hermes_api_key'))).resolves.toBe(TEST_ACCESS_KEY)

  const validationRequest = api.requests.find((request) => (
    request.pathname === '/api/hermes/sessions' &&
    request.headers.authorization === `Bearer ${TEST_ACCESS_KEY}`
  ))
  expect(validationRequest).toBeTruthy()
  expect(api.unexpectedRequests).toEqual([])
})
