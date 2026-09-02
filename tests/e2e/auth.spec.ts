import { expect, test } from '@playwright/test'
import { mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('redirects protected routes to the login screen without a token', async ({ page }) => {
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/jobs')

  await expect(page).toHaveURL(/#\/\?redirect=\/hermes\/jobs$/)
  await expect(page.getByRole('heading', { name: 'Hermes Studio' })).toBeVisible()
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
  const api = await mockHermesApi(page, {
    ttsActiveProviders: { default: 'openai' },
  })

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

  await expect.poll(async () => {
    const raw = await page.evaluate(() => window.localStorage.getItem('hermes-tts-settings-v2'))
    return raw ? JSON.parse(raw).provider : null
  }).toBe('openai')
  const ttsSettingsRequest = api.requests.find(request => request.pathname === '/api/studio/tts/settings')
  expect(ttsSettingsRequest?.headers.authorization).toBe(`Bearer ${TEST_ACCESS_KEY}`)
  expect(ttsSettingsRequest?.headers['x-hermes-profile']).toBe('default')
  expect(api.unexpectedRequests).toEqual([])
})
