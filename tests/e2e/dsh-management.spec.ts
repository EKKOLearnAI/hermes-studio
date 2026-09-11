import AdmZip from 'adm-zip'
import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('installs DSH from Agent Manager and saves its native settings', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  let installed = false
  const tool = () => ({ id: 'dsh', name: 'DeepSeek Harness', provider: 'DeepSeek', command: 'dsh', packageName: '@deepseek-ai/dsh', installed, version: installed ? '0.1.5-rc.1' : '', path: installed ? '/usr/local/bin/dsh' : '', error: '' })
  await page.route('**/api/agents/status', route => route.fulfill({ json: {
    revision: 1, updatedAt: '2026-01-01T00:00:00.000Z',
    agents: [{ ...tool(), kind: 'coding-agent', source: installed ? 'user-cli' : 'not-installed', installations: [] }],
  } }))
  await page.route('**/api/coding-agents', route => route.fulfill({ json: { tools: [tool()] } }))
  await page.route('**/api/coding-agents/dsh/install', async route => {
    expect(route.request().method()).toBe('POST')
    installed = true
    await route.fulfill({ json: { success: true, tools: [tool()], tool: tool() } })
  })
  const contents: Record<string, string> = { settings: '{}\n', memory: '' }
  await page.route('**/api/coding-agents/dsh/config-files/*', async route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1)!
    if (route.request().method() === 'PUT') contents[key] = route.request().postDataJSON().content
    await route.fulfill({ json: { key, content: contents[key], path: `~/.dsh/${key === 'settings' ? 'settings.yaml' : 'AGENTS.md'}`, exists: true, language: key === 'settings' ? 'yaml' : 'markdown' } })
  })
  await page.goto('/#/studio/agents')
  const card = page.getByTestId('agent-card-dsh')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(card).toContainText('0.1.5-rc.1')
  expect(installed).toBe(true)
  await card.getByTestId('agent-settings-dsh').click()
  await expect(page).toHaveURL(/\/studio\/agents\/dsh\/settings/)
  const settings = page.locator('.settings-editor-panel').nth(1)
  await settings.locator('textarea').fill('theme: dark\n')
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => contents.settings).toBe('theme: dark\n')
  expect(contents.memory).toBe('')
  expect(api.unexpectedRequests).toEqual([])
})

test('opens DSH skills and adds an MCP through the shared management UI', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  let imported = false
  await page.route('**/api/hermes/skills**', async route => {
    const url = new URL(route.request().url())
    if (!url.searchParams.has('target')) return route.fallback()
    expect(url.searchParams.get('target')).toBe('dsh')
    if (url.pathname === '/api/hermes/skills/import') {
      expect(route.request().method()).toBe('POST')
      expect(route.request().postDataBuffer()?.toString()).toContain('demo.zip')
      imported = true
      return route.fulfill({ json: { name: 'imported' } })
    }
    if (url.pathname === '/api/hermes/skills') {
      await route.fulfill({ json: { categories: [{ name: 'misc', skills: [{ name: 'demo', description: 'DSH native skill', enabled: true, source: 'local' }] }], archived: [] } })
    } else {
      await route.fulfill({ json: url.pathname.endsWith('/files') ? { files: [] } : { content: '---\nname: demo\ndescription: DSH native skill\n---\nInstructions' } })
    }
  })
  await page.goto('/#/studio/agents/dsh/skills')
  await expect(page.locator('.skill-item').filter({ hasText: 'demo' })).toBeVisible()
  await expect(page.locator('.skill-item').getByRole('switch')).toHaveCount(0)
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.locator('.field-label')).toHaveCount(0)
  await page.locator('.n-modal').getByText('Zip', { exact: true }).click()
  const zip = new AdmZip()
  zip.addFile('imported/SKILL.md', Buffer.from('---\nname: imported\ndescription: Example\n---\nInstructions'))
  await page.locator('.n-modal input[type=file]').setInputFiles({ name: 'demo.zip', mimeType: 'application/zip', buffer: zip.toBuffer() })
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect.poll(() => imported).toBe(true)

  const servers: any[] = []
  await page.route('**/api/coding-agents/dsh/mcp/servers**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/test')) return route.fulfill({ json: { ok: true, tools: [] } })
    if (route.request().method() === 'POST') {
      const { name, config } = route.request().postDataJSON()
      servers.push({ name, raw_config: config, managed: false, transport: 'stdio', connected: false, tools_registered: 0, tool_names: [], tool_names_registered: [], tool_details: [] })
      await route.fulfill({ json: { ok: true, name } })
    } else await route.fulfill({ json: { ok: true, servers, total_tools: 0 } })
  })
  await page.goto('/#/studio/agents/dsh/mcp')
  await page.getByRole('button', { name: '+ Add Server', exact: true }).click()
  await page.locator('.n-modal textarea').fill(JSON.stringify({ docs: { command: 'node', args: ['docs.mjs'] } }))
  await page.locator('.n-modal').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => servers.length).toBe(1)
  expect(servers[0]).toMatchObject({ name: 'docs', raw_config: { command: 'node', args: ['docs.mjs'] } })
  expect(api.unexpectedRequests).toEqual([])
})
