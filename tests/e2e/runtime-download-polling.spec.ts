import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const role of ['admin', 'super_admin'] as const) {
  test(`${role} does not continuously poll Runtime jobs while idle`, async ({ page }) => {
    const tokenParts = TEST_ACCESS_KEY.split('.')
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString())
    tokenParts[1] = Buffer.from(JSON.stringify({ ...payload, role })).toString('base64url')
    await authenticate(page, tokenParts.join('.'))
    await mockHermesApi(page)
    let requests = 0
    await page.route('**/api/hermes/runtime-versions/jobs', async route => {
      requests += 1
      await route.fulfill({
        status: role === 'admin' ? 403 : 200,
        contentType: 'application/json',
        body: JSON.stringify(role === 'admin' ? { error: 'Super administrator privileges are required' } : { jobs: [] }),
      })
    })
    await page.goto('/#/hermes/jobs')
    await expect(page.getByRole('heading', { name: 'Scheduled Jobs' })).toBeVisible()
    if (role === 'super_admin') await expect.poll(() => requests).toBe(1)
    await page.clock.install()
    await page.clock.runFor(8000)
    expect(requests).toBe(role === 'admin' ? 0 : 1)
    await expect(page.locator('.n-message--error')).toHaveCount(0)
  })
}

test('restores an active download, prompts on completion and then stops polling', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  let requests = 0
  let status = 'running'
  await page.route('**/api/hermes/runtime-versions/jobs', async route => {
    requests += 1
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobs: [{
      id: 'restored-runtime-job', kind: 'runtime', version: '0.20.6', status,
      source: 'github', stage: status, message: '', error: '', createdAt: '', updatedAt: '',
    }] }) })
  })
  await page.goto('/#/hermes/jobs')
  await expect(page.getByRole('heading', { name: 'Scheduled Jobs' })).toBeVisible()
  await expect.poll(() => requests).toBeGreaterThanOrEqual(1)
  await expect(page.getByTestId('runtime-restart-prompt')).toHaveCount(0)
  status = 'completed'
  await expect(page.getByTestId('runtime-restart-prompt')).toBeVisible()
  const completedRequests = requests
  await page.getByTestId('runtime-restart-later').click()
  await page.clock.install()
  await page.clock.runFor(8000)
  expect(requests).toBe(completedRequests)
  await expect(page.getByTestId('runtime-restart-prompt')).toHaveCount(0)
})
