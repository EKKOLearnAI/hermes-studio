import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { parseDocument } from 'yaml'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const mobile of [false, true]) test(`manages DSH plugins and preserves conflicting drafts (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  const state: any = { sourceId: 'studio-acp', revision: 'empty', activeRevision: null, content: '[]\n', packages: [], revisions: [], operations: [] }
  const requests: any[] = []
  let pending: any = null
  const complete = () => {
    const request = pending; if (!request) return
    pending = null
    const operation = state.operations.at(-1)
    if (request.action === 'update') { operation.status = 'failed'; operation.code = 'DSH_PLUGIN_OPERATION_FAILED'; return }
    if (request.action === 'install') state.packages.push({ name: 'example', version: '1.0.0', kind: 'bundle', configuredEnabled: false, containsBrowserPart: false, compatibility: 'unverified', runtimePhase: null, entries: [{ id: 'probe', module: './plugin.mjs', configuredEnabled: true }] })
    if (request.action === 'toggle') state.packages[0].configuredEnabled = request.enabled
    if (request.action === 'configure') state.content = request.content
    if (request.action === 'remove') state.packages = []
    if (request.action === 'rollback') state.packages = [{ name: 'example', version: '1.0.0', kind: 'bundle', configuredEnabled: false, containsBrowserPart: false, compatibility: 'unverified', runtimePhase: null, entries: [] }]
    state.revision = `revision-${state.operations.length}`
    state.activeRevision = request.action === 'rollback' ? request.revisionId : operation.id
    if (request.action !== 'rollback') state.revisions.push({ id: operation.id, createdAt: new Date(Date.now() + state.operations.length * 1000).toISOString() })
    operation.status = 'succeeded'; operation.revision = state.revision
  }
  await page.route('**/api/coding-agents/dsh/plugins', route => route.fulfill({ json: state }))
  await page.route('**/api/coding-agents/dsh/plugin-operations', route => {
    const request = route.request().postDataJSON()
    requests.push(request)
    expect(request.idempotencyKey).toBeTruthy()
    if (route.request().headers()['if-match'] !== `"${state.revision}"`) return route.fulfill({ status: 412, json: { code: 'DSH_REVISION_CHANGED' } })
    pending = request
    const operation = { id: `op-${requests.length}`, action: request.action, status: 'running', createdAt: new Date().toISOString(), ...('packageSpec' in request || 'packageName' in request ? { packageName: 'example' } : {}) }
    state.operations.push(operation)
    return route.fulfill({ status: 202, json: operation })
  })
  await page.route('**/api/coding-agents/dsh/plugin-inventory', route => route.fulfill({ json: { source: 'native-presets', sourceHome: '/fixture/.dsh', packageVersion: '0.1.5-rc.2', defaultPreset: 'standard', runtimeConnected: false, discovery: 'shipped-and-user-roots', presets: [] } }))
  await page.goto('/#/studio/agents/dsh/plugins')
  const panel = page.getByTestId('dsh-plugins')
  await expect(panel.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  await page.getByTestId('managed-packages').locator('summary').first().click()
  await panel.getByRole('textbox', { name: 'Package and exact version' }).fill('example@1.0.0')
  await panel.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(panel.getByText('Running', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Install', exact: true })).toBeDisabled()
  complete()
  const pkg = page.getByTestId('dsh-package-example')
  await expect(pkg).toBeVisible()
  await expect(pkg).toContainText('Disabled in configuration')
  await pkg.getByRole('button', { name: 'Enable', exact: true }).click()
  await expect.poll(() => pending?.action).toBe('toggle'); complete()
  await expect(pkg).toContainText('Enabled in configuration')
  await pkg.getByRole('button', { name: 'Update', exact: true }).click()
  await panel.getByRole('textbox', { name: 'Package and exact version' }).fill('example@2.0.0')
  await panel.locator('form').getByRole('button', { name: 'Update', exact: true }).click()
  await expect.poll(() => pending?.action).toBe('update'); complete()
  await expect(panel.getByText('Failed', { exact: true }).first()).toBeVisible()
  await expect(pkg).toContainText('1.0.0')

  const editor = panel.getByRole('textbox', { name: 'Advanced configuration', exact: true })
  const save = panel.getByRole('button', { name: 'Save', exact: true })
  await editor.fill('- id: probe\n  disabled: false\n')
  state.revision = 'external-change'; state.content = '- id: external\n  disabled: true\n'
  await save.click()
  await expect(panel.getByText('Configuration changed elsewhere.', { exact: false })).toBeVisible()
  await expect(editor).toHaveValue('- id: probe\n  disabled: false\n')
  await expect(panel.getByRole('heading', { name: 'Latest saved configuration' })).toBeVisible()
  await panel.getByRole('button', { name: 'Reload', exact: true }).click()
  await page.locator('.n-popconfirm').getByRole('button', { name: 'Confirm', exact: true }).last().click()
  await expect(editor).toHaveValue(state.content)
  await editor.fill('- id: probe\n  disabled: true\n')
  await save.click()
  await expect.poll(() => pending?.action).toBe('configure'); complete()
  await expect(panel.getByText('Running', { exact: true })).toHaveCount(0)
  await expect(save).toBeDisabled()
  await expect(editor).toHaveValue('- id: probe\n  disabled: true\n')
  await pkg.getByRole('button', { name: 'Remove', exact: true }).click()
  await page.locator('.n-popconfirm').getByRole('button', { name: 'Confirm', exact: true }).last().click()
  await expect.poll(() => pending?.action).toBe('remove'); complete()
  await expect(pkg).toHaveCount(0)
  await panel.locator('.n-select').last().click()
  await page.locator('.n-base-select-option').last().click()
  await panel.getByRole('button', { name: 'Roll back', exact: true }).click()
  await page.locator('.n-popconfirm').getByRole('button', { name: 'Confirm', exact: true }).last().click()
  await expect.poll(() => pending?.action).toBe('rollback'); complete()
  await expect(pkg).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const mobile of [false, true]) test(`shows the 28 native preset entries before additional packages (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  const fixture = parseDocument(await readFile('tests/fixtures/dsh-inventory/standard.cordis.yml', 'utf8'), { logLevel: 'silent' }).toJS()
  const entries: any[] = []
  function flatten(rows: any[], groupPath: string[] = []) {
    for (const row of rows) {
      if (row.group) flatten(row.config, [...groupPath, row.id])
      else entries.push({ entryId: row.id, moduleName: row.name, configuredEnabled: typeof row.disabled === 'string' ? 'conditional' : !row.disabled, runtimePhase: null, groupPath })
    }
  }
  flatten(fixture)
  await page.route('**/api/coding-agents/dsh/plugins', route => route.fulfill({ json: { sourceId: 'studio-acp', revision: 'empty', activeRevision: null, content: '[]\n', packages: [], revisions: [], operations: [] } }))
  await page.route('**/api/coding-agents/dsh/plugin-inventory', route => route.fulfill({ json: {
    source: 'native-presets', sourceHome: '~/.dsh', packageVersion: '0.1.5-rc.2', defaultPreset: 'standard', runtimeConnected: false, discovery: 'shipped-and-user-roots',
    presets: [
      { id: 'standard', name: 'Standard', description: 'Full coding agent', isDefault: true, trust: 'system', sourcePath: 'dsh-agent-presets/presets/standard/agent.cordis.yml', entries },
      { id: 'custom', name: 'Custom', description: '', isDefault: false, trust: 'user', sourcePath: '~/.dsh/.agent-presets/custom/agent.cordis.yml', entries: [{ entryId: 'custom-tool', moduleName: './custom.mjs', configuredEnabled: true, runtimePhase: null, groupPath: [] }] },
    ],
  } }))
  await page.goto('/#/studio/agents/dsh/plugins')
  const panel = page.getByTestId('dsh-native-plugins')
  await expect(panel.getByTestId('native-plugin-count')).toHaveText('28')
  await expect(panel.locator('.plugins-table tbody tr')).toHaveCount(28)
  await expect(panel.locator('.summary-card')).toHaveCount(4)
  await expect(panel).toContainText('@deepseek-ai/dsh-tool-web')
  await expect(panel).toContainText('Conditional')
  await expect(page.getByTestId('managed-packages')).not.toHaveAttribute('open')
  await page.screenshot({ path: `/tmp/dsh-native-plugins-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: false })
  await panel.getByRole('textbox', { name: 'Search plugin ID or module' }).fill('subagent')
  await expect(panel.getByTestId('native-plugin-entry')).toHaveCount(6)
  await expect(panel.getByTestId('native-plugin-count')).toHaveText('28')
  await panel.getByRole('textbox', { name: 'Search plugin ID or module' }).fill('')
  await panel.getByTestId('native-preset-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: 'Custom (custom) · 1' }).click()
  await expect(panel.getByTestId('native-plugin-entry')).toHaveCount(1)
  await expect(panel).toContainText('custom-tool')
  expect(api.unexpectedRequests).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
