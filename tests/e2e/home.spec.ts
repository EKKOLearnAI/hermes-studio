import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const timestamp = '2026-07-15T08:00:00.000Z'
const provider = {
  provider: 'home-assistant', profile: 'default', active: true, configured: true,
  connectionStatus: 'connected', executorEnabled: true, authorizedTargetCount: 1, lastErrorCode: null,
}
const safeBinding = {
  id: 'binding-safe', deviceId: 'device-safe', provider: 'home-assistant', externalId: 'light.office_lamp',
  capabilities: ['level', 'power'], version: 1, createdAt: timestamp, updatedAt: timestamp,
}
const dangerousBinding = {
  id: 'binding-lock', deviceId: 'device-lock', provider: 'home-assistant', externalId: 'lock.front_door',
  capabilities: [], version: 1, createdAt: timestamp, updatedAt: timestamp,
}
const devices = [
  {
    id: 'device-safe', name: 'Office Lamp', deviceClass: 'light', spaceId: 'room-office',
    availability: 'available', attributes: { privatePath: 'C:\\Users\\operator\\home-secrets.json' },
    version: 1, createdAt: timestamp, updatedAt: timestamp, bindings: [safeBinding],
    states: [
      { deviceId: 'device-safe', key: 'power', value: true, sourceEventId: 'event-safe-power',
        observedAt: timestamp, receivedAt: timestamp, version: 7 },
      { deviceId: 'device-safe', key: 'level', value: 75, sourceEventId: 'event-safe-level',
        observedAt: timestamp, receivedAt: timestamp, version: 3 },
    ],
  },
  {
    id: 'device-lock', name: 'Front Door', deviceClass: 'lock', spaceId: 'room-entry',
    availability: 'available', attributes: {}, version: 1, createdAt: timestamp, updatedAt: timestamp,
    bindings: [dangerousBinding], states: [],
  },
]
const inventoryItem = {
  id: 'inventory-filter', name: 'Air filter', unit: 'piece', quantity: 2, lowStockThreshold: 2,
  attributes: {}, version: 1, createdAt: timestamp, updatedAt: timestamp,
}

test('drives the governed Home command center without exposing dangerous writes or private state', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'default')
  const baseApi = await mockHermesApi(page, { initialProfileName: 'default' })
  const homeApi = await mockHomeApi(page)

  await page.goto('/#/hermes/personal-os/home')

  await expect(page.locator('[data-test="home-command-center"]')).toBeVisible()
  await expect(page.locator('[data-test="home-overview-panel"]')).toBeVisible()
  await expect(page.locator('[data-test="home-provider-status"]')).toHaveText(/connected/i)
  await expect(page.locator('[data-test="home-device-panel"]')).toBeVisible()
  await expect(page.locator('[data-test="home-inventory-panel"]')).toBeVisible()
  await expect(page.locator('[data-test="home-workflow-panel"]')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('C:\\Users\\operator\\home-secrets.json')
  await expect(page.locator('[data-test="home-device-device-lock"] [data-test^="home-command-"]')).toHaveCount(0)

  await page.locator('[data-test="home-device-device-safe"] [data-test="home-command-power"]').click()
  const confirmation = page.locator('[data-test="home-command-confirmation"]')
  await expect(confirmation).toBeVisible()
  await expect(confirmation).toContainText('light.office_lamp')
  await expect.poll(() => homeApi.commandRequests.length).toBe(0)
  await page.locator('[data-test="home-command-confirm"]').click()

  await expect.poll(() => homeApi.commandRequests.length).toBe(1)
  expect(JSON.parse(homeApi.commandRequests[0].postData || '{}')).toMatchObject({
    bindingId: 'binding-safe', externalId: 'light.office_lamp', command: 'set_power',
    expectedStateVersion: 7, desiredPower: false,
  })
  await expect(page.locator('[data-test="home-workflow-approve"]')).toBeVisible()
  await page.locator('[data-test="home-workflow-approve"]').click()
  await expect.poll(() => homeApi.reviewRequests.length).toBe(1)
  expect(JSON.parse(homeApi.reviewRequests[0].postData || '{}')).toEqual({ action: 'approve' })
  await expect(page.locator('[data-test="home-workflow-panel"]')).toContainText('succeeded')

  await page.locator('[data-test="home-inventory-use"]').click()
  await expect(page.locator('[data-test="home-inventory-confirmation"]')).toBeVisible()
  await expect.poll(() => homeApi.inventoryRequests.length).toBe(0)
  await page.locator('[data-test="home-inventory-confirm"]').click()
  await expect.poll(() => homeApi.inventoryRequests.length).toBe(1)
  expect(JSON.parse(homeApi.inventoryRequests[0].postData || '{}')).toMatchObject({
    delta: -1, reason: expect.any(String), idempotencyKey: expect.stringMatching(/^home-ui:inventory:/),
  })

  expect(JSON.stringify(homeApi.requests)).not.toContain('C:\\Users\\operator\\home-secrets.json')
  expect(baseApi.unexpectedRequests).toEqual([])
})

async function mockHomeApi(page: Page) {
  const requests: Array<{ method: string; pathname: string; postData: string | null }> = []
  const commandRequests: typeof requests = []
  const reviewRequests: typeof requests = []
  const inventoryRequests: typeof requests = []
  let workflowState: 'waiting_user' | 'succeeded' = 'waiting_user'
  let currentInventory = { ...inventoryItem }

  await page.route('**/api/hermes/home/**', route => handle(route))

  async function handle(route: Route) {
    const request = route.request()
    const url = new URL(request.url())
    const record = { method: request.method(), pathname: url.pathname, postData: request.postData() }
    requests.push(record)
    const json = (body: unknown, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    })

    if (url.pathname === '/api/hermes/home/overview') return json({
      provider, summary: { spaceCount: 2, deviceCount: 2, unavailableDeviceCount: 0,
        inventoryItemCount: 1, lowStockItemCount: 1, activeWorkflowCount: 0 },
    })
    if (url.pathname === '/api/hermes/home/spaces') return json({ spaces: [
      { id: 'room-office', kind: 'room', name: 'Office', parentSpaceId: null, attributes: {}, version: 1,
        createdAt: timestamp, updatedAt: timestamp },
      { id: 'room-entry', kind: 'room', name: 'Entry', parentSpaceId: null, attributes: {}, version: 1,
        createdAt: timestamp, updatedAt: timestamp },
    ] })
    if (url.pathname === '/api/hermes/home/devices') return json({ devices })
    if (url.pathname === '/api/hermes/home/inventory' && request.method() === 'GET') {
      return json({ items: [currentInventory] })
    }
    if (url.pathname === '/api/hermes/home/devices/device-safe/commands' && request.method() === 'POST') {
      commandRequests.push(record)
      workflowState = 'waiting_user'
      return json(actionResponse())
    }
    if (url.pathname === '/api/hermes/home/workflows/workflow-home-e2e' && request.method() === 'GET') {
      return json({ workflow: workflowDetail(workflowState) })
    }
    if (url.pathname === '/api/hermes/home/workflows/workflow-home-e2e/review' && request.method() === 'POST') {
      reviewRequests.push(record)
      workflowState = 'succeeded'
      return json({ workflow: workflowDetail(workflowState) })
    }
    if (url.pathname === '/api/hermes/home/inventory/inventory-filter/adjust' && request.method() === 'POST') {
      inventoryRequests.push(record)
      currentInventory = { ...currentInventory, quantity: 1, version: 2, updatedAt: timestamp }
      return json({ disposition: 'applied', item: currentInventory, entry: {
        id: 'ledger-home-e2e', itemId: currentInventory.id, delta: -1, resultingQuantity: 1,
        reason: 'confirmed inventory adjustment', source: 'home-api', sourceId: 'home-e2e', createdAt: timestamp,
      } })
    }
    return json({ error: `Unexpected home route: ${request.method()} ${url.pathname}` }, 404)
  }

  return { requests, commandRequests, reviewRequests, inventoryRequests }
}

function actionResponse() {
  return {
    intent: { id: 'intent-home-e2e', capabilityId: 'home.device.set_power' },
    policyDecision: { id: 'decision-home-e2e', outcome: 'waiting_user', reasonCodes: ['irreversible_requires_approval'] },
    workflow: workflowSummary('waiting_user'),
  }
}

function workflowSummary(state: 'waiting_user' | 'succeeded') {
  return {
    id: 'workflow-home-e2e', state, version: state === 'succeeded' ? 4 : 1, attempt: 0, lastErrorCode: null,
    availableActions: { approve: state === 'waiting_user', reject: state === 'waiting_user', cancel: false,
      retry: false, compensate: false },
    createdAt: timestamp, updatedAt: timestamp, completedAt: state === 'succeeded' ? timestamp : null,
  }
}

function workflowDetail(state: 'waiting_user' | 'succeeded') {
  return {
    ...workflowSummary(state), capabilityId: 'home.device.set_power',
    policyDecision: { id: 'decision-home-e2e', outcome: 'waiting_user', reasonCodes: ['irreversible_requires_approval'] },
    steps: [
      { kind: 'prepare', state: state === 'succeeded' ? 'succeeded' : 'pending', attempt: state === 'succeeded' ? 1 : 0,
        lastErrorCode: null, output: null, updatedAt: timestamp },
      { kind: 'execute', state: state === 'succeeded' ? 'succeeded' : 'pending', attempt: state === 'succeeded' ? 1 : 0,
        lastErrorCode: null, output: null, updatedAt: timestamp },
      { kind: 'verify', state: state === 'succeeded' ? 'succeeded' : 'pending', attempt: state === 'succeeded' ? 1 : 0,
        lastErrorCode: null, output: null, updatedAt: timestamp },
    ],
  }
}
