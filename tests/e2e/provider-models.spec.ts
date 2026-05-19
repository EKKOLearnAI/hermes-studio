import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

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
