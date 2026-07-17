import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('opens the provider form when model settings are entered from setup guidance', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  await mockHermesApi(page)

  await page.goto('/#/hermes/models?addProvider=1')

  await expect(page.getByText('Provider Type')).toBeVisible()
  await expect(page).toHaveURL(/#\/hermes\/models$/)
})

test('fetches custom provider models through the backend proxy', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  const api = await mockHermesApi(page)

  const thirdPartyRequests: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (url.startsWith('https://provider.example.test')) {
      thirdPartyRequests.push(url)
    }
  })

  await page.goto('/#/hermes/models')

  await page.getByRole('button', { name: 'Add Provider' }).click()
  await page.getByRole('button', { name: 'Custom' }).click()
  await page.getByPlaceholder('e.g. https://api.example.com/v1').fill('https://provider.example.test/v1')
  await page.getByPlaceholder('sk-...').fill('test-provider-key')
  await page.getByRole('button', { name: 'Fetch' }).click()

  await expect(page.getByText('Found 2 models')).toBeVisible()
  await expect(page.getByText('proxy-model-a')).toBeVisible()

  const proxyRequest = api.requests.find((request) => request.pathname === '/api/hermes/provider-models')
  expect(proxyRequest).toBeTruthy()
  expect(proxyRequest?.method).toBe('POST')
  expect(proxyRequest?.headers.authorization).toBe(`Bearer ${TEST_ACCESS_KEY}`)
  expect(JSON.parse(proxyRequest?.postData || '{}')).toMatchObject({
    base_url: 'https://provider.example.test/v1',
    api_key: 'test-provider-key',
  })
  expect(thirdPartyRequests).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})

test('edits a provider without rendering its existing credential', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { initialProfileName: 'research' })

  await page.goto('/#/hermes/models')
  await page.getByRole('button', { name: 'Edit' }).click()

  const editor = page.getByRole('dialog')
  await expect(editor.getByText('Internal provider ID', { exact: true })).toBeVisible()
  await expect(editor.getByText('test-provider', { exact: true })).toBeVisible()
  await expect(editor.getByText('Configured', { exact: true })).toBeVisible()
  await expect(editor.getByText('list-response-credential')).toHaveCount(0)
  await expect(editor.locator('input[type="password"]')).toHaveValue('')

  await editor.getByLabel('Display name').fill('Edited Provider')
  await editor.getByLabel('Base URL').fill('https://edited.example/v1')
  await editor.locator('input[type="password"]').fill('replacement-provider-credential')

  const patchRequestPromise = page.waitForRequest(request => {
    const url = new URL(request.url())
    return request.method() === 'PATCH' && url.pathname === '/api/hermes/config/providers/test-provider/editor'
  })
  await editor.getByRole('button', { name: 'Save' }).click()
  const patchRequest = await patchRequestPromise
  await expect(editor).toHaveCount(0)

  expect(patchRequest.headers()['if-match']).toBe('"provider-revision-1"')
  expect(JSON.parse(patchRequest.postData() || '{}')).toMatchObject({
    label: 'Edited Provider',
    base_url: 'https://edited.example/v1',
    preferred_model: 'test-model',
    credential_action: 'replace',
    api_key: 'replacement-provider-credential',
  })
  const testRequest = api.requests.find(request => (
    request.pathname === '/api/hermes/config/providers/test-provider/editor/test'
  ))
  expect(testRequest?.method).toBe('POST')
  expect(testRequest?.headers['x-hermes-profile']).toBe('research')
  expect(api.unexpectedRequests).toEqual([])
})
