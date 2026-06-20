import { expect, test } from '@playwright/test'
import { mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('redirects protected routes to the login screen without a token', async ({ page }) => {
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/jobs')

  await expect(page).toHaveURL(/#\/$/)
  await expect(page.getByRole('heading', { name: 'Hermes Web UI' })).toBeVisible()
  await expect(page.getByPlaceholder('Username')).toBeVisible()
  await expect(page.getByPlaceholder('Password')).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('rejects invalid credentials without persisting a token', async ({ page }) => {
  const api = await mockHermesApi(page, { tokenValidationStatus: 401 })

  await page.goto('/')
  await page.getByPlaceholder('Username').fill('playwright')
  await page.getByPlaceholder('Password').fill('bad-password')
  await page.getByRole('button', { name: 'Login' }).click()

  await expect(page.getByText('Invalid username or password')).toBeVisible()
  await expect(page).toHaveURL(/#\/$/)
  await expect(page.evaluate(() => window.localStorage.getItem('hermes_api_key'))).resolves.toBeNull()
  expect(api.unexpectedRequests).toEqual([])
})

test('logs in with password through the BFF before entering the app', async ({ page }) => {
  const api = await mockHermesApi(page)

  await page.goto('/')
  await page.getByPlaceholder('Username').fill('playwright')
  await page.getByPlaceholder('Password').fill('correct-password')
  await page.getByRole('button', { name: 'Login' }).click()

  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  await expect(page.evaluate(() => window.localStorage.getItem('hermes_api_key'))).resolves.toBe(TEST_ACCESS_KEY)
  await expect.poll(() => api.requests.some((request) => request.pathname === '/health')).toBe(true)

  const loginRequest = api.requests.find((request) => request.pathname === '/api/auth/login')
  expect(loginRequest?.method).toBe('POST')
  expect(loginRequest?.postData).toBe(JSON.stringify({ username: 'playwright', password: 'correct-password' }))
  expect(api.unexpectedRequests).toEqual([])
})
