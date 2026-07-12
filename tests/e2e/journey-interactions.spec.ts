import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY, type MockedRequest } from './fixtures'

const PROFILE_NAME = 'research'

const journeyPayload = {
  profile: 'fixture-redacted',
  source: 'cli' as const,
  graph: {
    nodes: [
      {
        id: 'memory:0',
        label: 'Redacted memory note',
        kind: 'memory',
        category: 'memory',
        memorySource: 'memory.md',
        timestamp: 1_700_000_000,
      },
      {
        id: 'skill:prompt-hygiene',
        label: 'Prompt hygiene',
        kind: 'skill',
        category: 'basics',
        useCount: 3,
        createdBy: 'cli',
        pinned: true,
        timestamp: 1_700_000_050,
      },
      {
        id: 'skill:workflow-replay',
        label: 'Workflow replay',
        kind: 'skill',
        category: 'automation',
        useCount: 2,
        createdBy: 'cli',
        timestamp: 1_700_000_100,
      },
    ],
    edges: [
      { source: 'memory:0', target: 'skill:prompt-hygiene' },
      { source: 'skill:prompt-hygiene', target: 'skill:workflow-replay' },
    ],
    clusters: [
      { category: 'memory', count: 1 },
      { category: 'basics', count: 1 },
      { category: 'automation', count: 1 },
    ],
    memory: [
      {
        source: 'memory.md',
        timestamp: 1_700_000_000,
        title: 'Redacted memory note',
        body: 'Redacted body kept deterministic for E2E playback.',
      },
    ],
    stats: {
      redacted: true,
      nodes: 3,
      edges: 2,
    },
  },
}

const tooltipSkillsPayload = {
  categories: [
    {
      name: 'basics',
      description: '',
      skills: [{
        name: 'Prompt hygiene',
        description: 'Keep prompts precise, scoped, and resistant to untrusted instructions.',
        enabled: true,
      }],
    },
    {
      name: 'automation',
      description: '',
      skills: [{
        name: 'Workflow replay',
        description: 'Replay a verified workflow without carrying stale interaction state.',
        enabled: true,
      }],
    },
  ],
  archived: [],
  paths: {
    local: '~/.hermes/skills',
    external: [],
  },
}

const emptySkillsPayload = {
  categories: [] as typeof tooltipSkillsPayload.categories,
  archived: [],
  paths: {
    local: '~/.hermes/skills',
    external: [],
  },
}

type MockApi = Awaited<ReturnType<typeof mockHermesApi>>

function requestsFor(api: MockApi, pathname: string): MockedRequest[] {
  return api.requests.filter(request => request.pathname === pathname)
}

function latestRequest(api: MockApi, pathname: string): MockedRequest | undefined {
  const matches = requestsFor(api, pathname)
  return matches[matches.length - 1]
}

async function expectRequestCount(api: MockApi, pathname: string, count: number) {
  await expect.poll(() => requestsFor(api, pathname).length).toBe(count)
}

function expectProfileHeader(request: MockedRequest | undefined) {
  expect(request, 'expected mocked request').toBeDefined()
  const params = new URLSearchParams((request?.search || '').replace(/^\?/, ''))
  expect(params.has('profile')).toBe(false)
  expect(request?.headers['x-hermes-profile']).toBe(PROFILE_NAME)
}

async function openPage(
  page: Page,
  path: string,
  skills = emptySkillsPayload,
): Promise<MockApi> {
  await authenticate(page, TEST_ACCESS_KEY, PROFILE_NAME)
  const api = await mockHermesApi(page, {
    journey: journeyPayload,
    skills,
  })
  await page.goto(path)
  return api
}

async function expectJourneySurface(page: Page) {
  await expect(page.getByRole('heading', { name: 'Learning Journey', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: /^Library$/ })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: /^Journey$/ })).toHaveCount(0)
  await expect(page.locator('.galaxy-canvas')).toBeVisible()
  await expect(page.locator('.galaxy-hud')).toContainText(PROFILE_NAME)
  await expect(page.locator('.node-kind-marker--skill.node-kind-marker--circle')).toBeVisible()
  await expect(page.locator('.node-kind-marker--memory.node-kind-marker--diamond')).toBeVisible()
  await expect(page.locator('aside.sidebar').getByRole('link', { name: /^Journey$/ })).toBeVisible()
}

test('standalone Journey route renders under Monitoring and defers Skills-only APIs', async ({ page }) => {
  const api = await openPage(page, '/#/hermes/journey')

  await expectJourneySurface(page)
  const playButton = page.getByRole('button', { name: 'Play journey' })
  await playButton.click()
  await expect(page.getByRole('button', { name: 'Pause journey' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(playButton).toBeVisible()

  await playButton.click()
  await page.locator('.category-legend [data-category="basics"]').focus()
  await page.keyboard.press('Escape')
  await expect(playButton).toBeVisible()

  await playButton.click()
  await page.locator('.galaxy-canvas').focus()
  await page.keyboard.press('Escape')
  await expect(playButton).toBeVisible()

  await expectRequestCount(api, '/api/hermes/journey', 1)
  expectProfileHeader(latestRequest(api, '/api/hermes/journey'))
  await expectRequestCount(api, '/api/hermes/skills', 0)
  await expectRequestCount(api, '/api/hermes/write-gate/pending', 0)
  expect(api.unexpectedRequests).toEqual([])
})

test('category controls toggle multi-selection by default and nodes expose descriptions', async ({ page }) => {
  const api = await openPage(page, '/#/hermes/journey', tooltipSkillsPayload)
  await expectJourneySurface(page)

  await expect(page.locator('.selection-mode')).toHaveCount(0)
  await expect(page.locator('[data-selection-mode]')).toHaveCount(0)

  const canvas = page.locator('.galaxy-canvas')
  const basicsBar = page.locator('.category-bar [data-category="basics"]')
  const basicsPill = page.locator('.category-legend [data-category="basics"]')
  const automationBar = page.locator('.category-bar [data-category="automation"]')
  const automationPill = page.locator('.category-legend [data-category="automation"]')
  await expect(basicsBar).toHaveCSS('height', '24px')
  expect((await basicsBar.boundingBox())!.width).toBeGreaterThanOrEqual(24)

  await basicsBar.click()
  await automationPill.click()
  await expect(basicsBar).toHaveAttribute('aria-pressed', 'true')
  await expect(basicsPill).toHaveAttribute('aria-pressed', 'true')
  await expect(automationBar).toHaveAttribute('aria-pressed', 'true')
  await expect(automationPill).toHaveAttribute('aria-pressed', 'true')

  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 20, box!.y + box!.height - 20)
  await page.mouse.down()
  await page.mouse.move(box!.x + 70, box!.y + box!.height - 20, { steps: 4 })
  await page.mouse.up()
  await expect(basicsPill).toHaveAttribute('aria-pressed', 'true')
  await expect(automationPill).toHaveAttribute('aria-pressed', 'true')

  await basicsPill.click()
  await expect(basicsBar).toHaveAttribute('aria-pressed', 'false')
  await expect(automationPill).toHaveAttribute('aria-pressed', 'true')

  await canvas.click({ position: { x: 8, y: Math.max(8, box!.height - 8) } })
  await expect(automationPill).toHaveAttribute('aria-pressed', 'false')
  await expectRequestCount(api, '/api/hermes/skills', 0)

  await canvas.focus()
  await page.keyboard.press('ArrowRight')
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toContainText('Redacted memory note')
  await expect(tooltip).toContainText('Redacted body kept deterministic for E2E playback.')
  await expectRequestCount(api, '/api/hermes/skills', 0)

  await page.keyboard.press('ArrowRight')
  await expect(tooltip).toContainText('Prompt hygiene')
  await expect(tooltip).toContainText('Keep prompts precise, scoped, and resistant to untrusted instructions.')

  const refreshButton = page.getByRole('button', { name: 'Refresh', exact: true })
  await refreshButton.focus()
  await page.keyboard.press('Enter')
  await expectRequestCount(api, '/api/hermes/journey', 2)
  await expectRequestCount(api, '/api/hermes/skills', 2)
  await expect(tooltip).toContainText('Keep prompts precise, scoped, and resistant to untrusted instructions.')

  await canvas.focus()
  await page.keyboard.press('Enter')
  const drawer = page.locator('.journey-detail-drawer')
  await expect(drawer).toContainText('Keep prompts precise, scoped, and resistant to untrusted instructions.')
  expectProfileHeader(latestRequest(api, '/api/hermes/skills'))
  expect(api.unexpectedRequests).toEqual([])
})

test('mobile standalone Journey keeps shape legend and default multi-selection usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const api = await openPage(page, '/#/hermes/journey')
  await expectJourneySurface(page)

  await expect(page.locator('.sidebar-toggle')).toHaveCount(0)
  await expect(page.getByTitle('Import')).toHaveCount(0)
  await expect(page.getByTitle('External dirs')).toHaveCount(0)
  await expect(page.getByTitle('Pending write approvals')).toHaveCount(0)

  const basics = page.locator('.category-legend [data-category="basics"]')
  const automation = page.locator('.category-legend [data-category="automation"]')
  await basics.click()
  await automation.click()
  await expect(basics).toHaveAttribute('aria-pressed', 'true')
  await expect(automation).toHaveAttribute('aria-pressed', 'true')

  const canvas = page.locator('.galaxy-canvas')
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  const cdp = await page.context().newCDPSession(page)
  const touchPoint = (id: number, x: number, y: number) => ({
    id,
    x,
    y,
    radiusX: 2,
    radiusY: 2,
    force: 1,
  })

  const panStart = touchPoint(1, box!.x + 45, box!.y + box!.height - 90)
  const panEnd = touchPoint(1, panStart.x + 55, panStart.y - 12)
  const beforePan = await canvas.screenshot()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [panStart] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [panEnd] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await canvas.dispatchEvent('click', { clientX: panEnd.x, clientY: panEnd.y })
  await page.waitForTimeout(50)
  const afterPan = await canvas.screenshot()
  expect(afterPan.equals(beforePan)).toBe(false)
  await expect(basics).toHaveAttribute('aria-pressed', 'true')
  await expect(automation).toHaveAttribute('aria-pressed', 'true')

  const pinchLeft = touchPoint(1, box!.x + box!.width * 0.4, box!.y + box!.height * 0.58)
  const pinchRight = touchPoint(2, box!.x + box!.width * 0.6, box!.y + box!.height * 0.58)
  const pinchWide = touchPoint(2, box!.x + box!.width * 0.78, pinchRight.y)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pinchLeft, pinchRight] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pinchLeft, pinchWide] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
  await page.waitForTimeout(50)
  const afterPinch = await canvas.screenshot()
  expect(afterPinch.equals(afterPan)).toBe(false)
  await expect(basics).toHaveAttribute('aria-pressed', 'true')
  await expect(automation).toHaveAttribute('aria-pressed', 'true')

  const recoveryStart = touchPoint(3, box!.x + 70, box!.y + box!.height - 120)
  const recoveryEnd = touchPoint(3, recoveryStart.x - 35, recoveryStart.y - 20)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [recoveryStart] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [recoveryEnd] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await canvas.dispatchEvent('click', { clientX: recoveryEnd.x, clientY: recoveryEnd.y })
  await page.waitForTimeout(300)
  const afterRecovery = await canvas.screenshot()
  expect(afterRecovery.equals(afterPinch)).toBe(false)
  await expect(basics).toHaveAttribute('aria-pressed', 'true')
  await expect(automation).toHaveAttribute('aria-pressed', 'true')
  await cdp.detach()

  await expectRequestCount(api, '/api/hermes/skills', 0)
  expect(api.unexpectedRequests).toEqual([])
})
