import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const mobile of [false, true]) test(`DSH native slot and plugin list retain their state (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  let opens = 0
  await page.route('**/api/coding-agents/dsh/ui-session', route => { opens++; return route.fulfill({ json: { id: 'fixture', path: '/api/coding-agents/dsh/ui/fixture/' } }) })
  await page.route('**/api/coding-agents/dsh/ui-session/fixture', route => route.fulfill({ status: 204 }))
  await page.route('**/api/coding-agents/dsh/ui/fixture/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><label>Plugin-owned field<input></label><script>parent.postMessage({type:"studio-dsh-ui-ready"},location.origin)</script>' }))
  const inventory: any = { source: 'native-presets', sourceHome: '/fixture/.dsh', packageVersion: '0.1.5-rc.2', defaultPreset: 'standard', runtimeConnected: false, discovery: 'shipped-and-user-roots',
    web: { profile: 'web', revision: 'a'.repeat(64), sourcePath: '/fixture/.dsh/profiles/web/package.json', packages: [{ name: '@liustack/modlens', title: 'ModLens', description: 'Vision tools for text-only models.', version: '3.26.1', requested: 'github:liustack/modlens#a1923d0', bundle: true, containsBrowserPart: true, error: '' }] },
    presets: [{ id: 'standard', name: 'Standard', isDefault: true, trust: 'system', sourcePath: '/fixture/standard/agent.cordis.yml', entries: Array.from({ length: 28 }, (_, i) => ({ entryId: `tool-${i}`, moduleName: `@deepseek-ai/tool-${i}`, configuredEnabled: true, runtimePhase: null, groupPath: [] })) }] }
  await page.route('**/api/coding-agents/dsh/plugin-inventory', route => route.fulfill({ json: inventory }))
  await page.route('**/api/coding-agents/dsh/web-plugins', route => {
    expect(route.request().headers()['if-match']).toBe(`"${inventory.web.revision}"`)
    expect(route.request().postDataJSON()).toEqual({ action: 'remove', packageName: '@liustack/modlens' })
    inventory.web.packages = []; return route.fulfill({ json: inventory })
  })
  await page.goto('/#/studio/agents/dsh/plugins')
  const panel = page.getByTestId('dsh-plugins')
  await expect(panel.getByRole('tab')).toHaveCount(2)
  const input = panel.frameLocator('iframe').getByLabel('Plugin-owned field')
  await input.fill('native draft')
  await panel.getByRole('tab', { name: 'Plugin list', exact: true }).click()
  await expect(panel.getByTestId('dsh-web-package')).toContainText('ModLens')
  await expect(panel.getByTestId('dsh-web-package')).toContainText('Vision tools for text-only models.')
  await expect(panel.getByTestId('native-plugin-count')).toHaveText('28')
  await expect(page.getByTestId('managed-packages')).toHaveCount(0)
  await panel.getByRole('tab', { name: 'Plugin configuration', exact: true }).click()
  await expect(input).toHaveValue('native draft'); expect(opens).toBe(1)
  await panel.getByRole('tab', { name: 'Plugin list', exact: true }).click()
  await panel.getByTestId('dsh-web-package').getByRole('button', { name: 'Remove' }).click()
  await page.locator('.n-popconfirm').getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(panel.getByTestId('dsh-web-package')).toHaveCount(0)
  await panel.getByRole('tab', { name: 'Plugin configuration', exact: true }).click()
  await expect.poll(() => opens).toBe(2)
  expect(api.unexpectedRequests).toEqual([]); expect(errors).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
