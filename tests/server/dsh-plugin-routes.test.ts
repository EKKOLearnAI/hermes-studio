import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
const doubles = vi.hoisted(() => ({ native: vi.fn(), change: vi.fn(), create: vi.fn(), remove: vi.fn(), choices: vi.fn() }))
vi.mock('../../packages/server/src/modules/coding-agents/services', async original => ({ ...await original<typeof import('../../packages/server/src/modules/coding-agents/services')>(), getNativeDshPluginInventory: doubles.native, changeDshWebPlugins: doubles.change, dshPluginUi: doubles, dshAgentPresets: doubles }))
import { codingAgentRoutes } from '../../packages/server/src/modules/coding-agents/routes/agents'
const servers: Server[] = []
afterEach(async () => { vi.clearAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })
async function server(role?: string) {
  const app = new Koa(); app.use(async (ctx, next) => { ctx.state.user = role ? { role } : undefined; await next() })
  app.use(bodyParser()); app.use(codingAgentRoutes.routes())
  const http = app.listen(0, '127.0.0.1'); servers.push(http); await once(http, 'listening')
  return `http://127.0.0.1:${(http.address() as any).port}`
}
it.each([undefined, 'user', 'admin'])('protects native configuration and packages from role %s', async role => {
  const base = await server(role)
  for (const [path, method] of [['plugin-inventory', 'GET'], ['ui-session', 'POST'], ['ui-session/id', 'DELETE'], ['web-plugins', 'POST'], ['agent-presets', 'GET'], ['agent-presets', 'POST'], ['agent-presets/test', 'GET'], ['agent-presets/test', 'DELETE'], ['agent-presets/test/default', 'PUT'], ['agent-presets/test/location', 'POST']]) expect((await fetch(`${base}/api/coding-agents/dsh/${path}`, { method })).status).toBe(403)
  expect(doubles.create).not.toHaveBeenCalled(); expect(doubles.change).not.toHaveBeenCalled()
})
it('forwards native revisions and removes the old ACP management endpoints', async () => {
  const base = await server('super_admin')
  doubles.create.mockResolvedValue({ id: 'fixture', path: '/frame/' })
  expect(await (await fetch(`${base}/api/coding-agents/dsh/ui-session`, { method: 'POST' })).json()).toMatchObject({ id: 'fixture' })
  const revision = 'a'.repeat(64), body = { action: 'install', packageSpec: 'example@1.0.0' }
  doubles.change.mockResolvedValue({ web: { packages: [] } })
  const response = await fetch(`${base}/api/coding-agents/dsh/web-plugins`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': `"${revision}"` }, body: JSON.stringify(body) })
  expect(response.status).toBe(200); expect(doubles.change).toHaveBeenCalledWith(body, revision)
  for (const path of ['plugins', 'plugin-operations/id', 'plugin-settings', 'plugin-settings/modlens']) expect((await fetch(`${base}/api/coding-agents/dsh/${path}`)).status).toBe(404)
})

it('allows chat users to read safe preset choices while authoring remains restricted', async () => {
  doubles.choices.mockResolvedValue({ presets: [{ id: 'minimal', name: 'Minimal', isDefault: true }] })
  const base = await server('user')
  const response = await fetch(`${base}/api/coding-agents/dsh/session-presets`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ presets: [{ id: 'minimal', name: 'Minimal', isDefault: true }] })
  expect((await fetch(`${base}/api/coding-agents/dsh/agent-presets`)).status).toBe(403)
})
