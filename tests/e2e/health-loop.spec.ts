import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const settings = {
  subjectId: 'person:self', liveDeliveryEnabled: false, profile: 'research', recipient: 'configured-self',
  configuredConnectors: ['s400', 'health-state'], configuredProcessors: ['processor:e2e'], version: 1,
  updatedAt: '2026-07-14T08:00:00.000Z',
}

const connectors = [
  { id: 's400', configured: true, configurationState: 'configured', authorizationState: 'not_required',
    health: 'healthy', domains: ['body_composition', 'measurements', 'posture', 'skin'],
    freshnessByDomain: { body_composition: '2026-07-14T08:00:00.000Z', measurements: '2026-07-14T08:00:00.000Z',
      posture: '2026-07-14T08:00:00.000Z', skin: '2026-07-14T08:00:00.000Z' },
    capabilities: { read: ['body_composition', 'measurements', 'posture', 'skin'], write: [] } },
  { id: 'health-state', configured: true, configurationState: 'configured', authorizationState: 'not_required',
    health: 'healthy', domains: ['diet', 'fitness', 'sleep', 'internal_health'],
    freshnessByDomain: { diet: '2026-07-14T07:00:00.000Z', fitness: '2026-07-13T08:00:00.000Z',
      sleep: '2026-07-14T08:00:00.000Z', internal_health: '2026-07-01T08:00:00.000Z' },
    capabilities: { read: ['diet', 'fitness', 'sleep', 'internal_health'], write: [] } },
]

test('drives the health command center with mocked APIs and no real Weixin side effect', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const baseApi = await mockHermesApi(page)
  const healthApi = await mockHealthLoopApi(page)

  await page.goto('/#/hermes/personal-os/health')

  await expect(page.locator('[data-test="health-loop-command-center"]')).toBeVisible()
  await expect(page.locator('[data-test="health-readiness-panel"]')).toBeVisible()
  await expect(page.locator('[data-test="primary-health-action"]')).toBeVisible()
  await expect(page.locator('[data-test="health-domain-status"]')).toHaveCount(8)
  await expect(page.locator('[data-test="automation-mode"]')).toHaveAttribute('data-live', 'false')
  await expect(page.locator('body')).not.toContainText('C:\\Users\\patient\\report.pdf')
  await expect(page.locator('body')).not.toContainText('RAW-LAB-REPORT')

  await page.locator('[data-test="feedback-adverse_feedback"]').click()
  await expect.poll(() => healthApi.requests.some(request => request.method === 'POST'
    && request.pathname.endsWith('/interventions/intervention-e2e/feedback'))).toBe(true)

  await page.locator('[data-test="capture-file-input"]').setInputFiles({
    name: 'synthetic-health.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic fixture'),
  })
  const weightReview = page.locator('[data-test="extracted-value-weightKg"]')
  const bodyFatReview = page.locator('[data-test="extracted-value-bodyFatPercent"]')
  await weightReview.fill('84.2')
  await bodyFatReview.fill('21.4')
  await expect(weightReview).toHaveValue('84.2')
  await expect(bodyFatReview).toHaveValue('21.4')
  const captureSubmit = page.locator('[data-test="capture-submit"]')
  await expect(captureSubmit).toBeEnabled()
  await captureSubmit.click()
  const dialog = page.locator('[data-test="health-consent-dialog"]')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('processor:e2e')
  await expect(dialog).toContainText('no_retention')
  await expect(dialog).not.toContainText('one-time-secret-e2e')
  await page.locator('[data-test="consent-confirm"]').click()

  await expect(page.locator('[data-test="active-health-workflow"]')).toBeVisible()
  await expect(page.locator('[data-test="workflow-action-approve"]')).toBeVisible()
  await expect.poll(() => healthApi.requests.find(request =>
    request.pathname.endsWith('/artifacts/artifact-e2e/analyze'))?.postData).toContain('one-time-secret-e2e')
  await expect(page.locator('body')).not.toContainText('one-time-secret-e2e')

  const liveButton = page.locator('[data-test="enable-live-weixin"]')
  await expect(liveButton).toBeDisabled()
  await page.locator('[data-test="live-confirmation-input"]').fill('LIVE')
  await expect(liveButton).toBeDisabled()
  await page.locator('[data-test="live-confirmation-input"]').fill('LIVE WEIXIN')
  await liveButton.click()
  await expect(page.locator('[data-test="automation-mode"]')).toHaveAttribute('data-live', 'true')
  expect(healthApi.weixinRequests).toEqual([])
  expect(baseApi.unexpectedRequests).toEqual([])
})

async function mockHealthLoopApi(page: Page) {
  const requests: Array<{ method:string; pathname:string; postData:string|null }> = []
  const weixinRequests: string[] = []
  let currentSettings = { ...settings }
  await page.route('**/api/hermes/health/**', route => handle(route))
  await page.route('**/api/hermes/health-loop/**', route => handle(route))
  await page.route('**/api/hermes/action-fabric/workflows/workflow-active', route => handle(route))

  async function handle(route: Route) {
    const request = route.request()
    const url = new URL(request.url())
    const record = { method: request.method(), pathname: url.pathname, postData: request.postData() }
    requests.push(record)
    if (url.pathname.toLowerCase().includes('weixin')) weixinRequests.push(url.pathname)
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (url.pathname === '/api/hermes/health/overview') return json({ overview: {
      foodLogs: [], recentWorkouts: [], bodyMap: [], internalMarkers: [], topBodyConcerns: [],
      privatePath: 'C:\\Users\\patient\\report.pdf', rawReport: 'RAW-LAB-REPORT',
    } })
    if (url.pathname === '/api/hermes/health/scale-sync') return json({ settings: { configured: false } })
    if (url.pathname === '/api/hermes/health-loop/overview') return json({
      settings: currentSettings, connectors, summary: { interventionCount: 1, activeInterventionCount: 1, projectionCount: 9 },
    })
    if (url.pathname === '/api/hermes/health-loop/connectors') return json({ connectors })
    if (url.pathname === '/api/hermes/health-loop/interventions' && request.method() === 'GET') return json({ interventions: [{
      actionId: 'action-e2e', interventionId: 'intervention-e2e', workflowId: 'workflow-active',
      capabilityId: 'health.plan.adjust', category: 'recovery', priority: 90, risk: 'low', authority: 'auto',
      status: 'active', effectiveDate: '2026-07-14', createdAt: '2026-07-14T08:00:00.000Z', supersededAt: null,
    }] })
    if (url.pathname === '/api/hermes/action-fabric/workflows/workflow-active') return json({ workflow: {
      id: 'workflow-active', state: 'waiting_user', version: 1,
      availableActions: { approve: true, reject: true, cancel: true, retry: false, compensate: false },
    } })
    if (url.pathname.endsWith('/interventions/intervention-e2e/feedback')) return json({ feedback: {
      feedbackId: 'feedback-e2e', outcome: 'adverse_feedback', actionId: 'action-e2e',
      interventionId: 'intervention-e2e', occurredAt: '2026-07-14T08:10:00.000Z', reviewRequired: true,
      supersededActionIds: [],
    } })
    if (url.pathname === '/api/hermes/health-loop/settings' && request.method() === 'GET') return json({ settings: currentSettings })
    if (url.pathname === '/api/hermes/health-loop/settings' && request.method() === 'PUT') {
      currentSettings = { ...currentSettings, liveDeliveryEnabled: true, version: 2 }
      return json({ settings: currentSettings })
    }
    if (url.pathname === '/api/hermes/health-loop/artifacts') return json({ artifact: {
      id: 'artifact-e2e', mediaType: 'text/plain', sizeBytes: 17, manifestDigest: 'a'.repeat(64), metadata: {},
      createdAt: '2026-07-14T08:00:00.000Z',
    } })
    if (url.pathname === '/api/hermes/health-loop/consents') return json({ consent: {
      consentId: 'consent-e2e', manifestDigest: 'b'.repeat(64), manifest: JSON.parse(request.postData() || '{}').manifest,
      issuedAt: '2026-07-14T08:00:00.000Z', expiresAt: '2026-07-14T08:05:00.000Z', token: 'one-time-secret-e2e',
    } })
    if (url.pathname === '/api/hermes/health-loop/artifacts/artifact-e2e/analyze') return json(actionResponse())
    return json({ error: `Unexpected health route: ${request.method()} ${url.pathname}` }, 404)
  }
  return { requests, weixinRequests }
}

function actionResponse() {
  return { intent: { id: 'intent-e2e', capabilityId: 'health.artifact.analyze.remote' },
    policyDecision: { id: 'decision-e2e', outcome: 'waiting_user', reasonCodes: ['approval_required'] },
    workflow: { id: 'workflow-e2e', state: 'waiting_user', version: 1,
      availableActions: { approve: true, reject: true, cancel: true, retry: false, compensate: false } } }
}
