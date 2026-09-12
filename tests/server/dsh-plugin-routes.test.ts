import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
const doubles = vi.hoisted(() => ({ snapshot: vi.fn(), submit: vi.fn(), operation: vi.fn(), native: vi.fn() }))
vi.mock('../../packages/server/src/modules/coding-agents/services', async original => ({ ...await original<typeof import('../../packages/server/src/modules/coding-agents/services')>(), executeDshPluginCommand: vi.fn(), getNativeDshPluginInventory: doubles.native }))
vi.mock('../../packages/server/src/modules/coding-agents/services/dsh/plugins', async original => ({
  ...await original<typeof import('../../packages/server/src/modules/coding-agents/services/dsh/plugins')>(),
  getDshPluginStore: () => doubles,
}))
import { codingAgentRoutes } from '../../packages/server/src/modules/coding-agents/routes/agents'
const servers: Server[] = []
afterEach(async () => { vi.clearAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })
async function server(role: string | undefined) {
  const app = new Koa()
  app.use(async (ctx, next) => { ctx.state.user = role ? { role } : undefined; await next() })
  app.use(bodyParser()); app.use(codingAgentRoutes.routes())
  const http = app.listen(0, '127.0.0.1'); servers.push(http); await once(http, 'listening')
  return `http://127.0.0.1:${(http.address() as any).port}`
}
it.each([undefined, 'user', 'admin'])('rejects inventory and package operations for role %s', async role => {
  const base = await server(role)
  for (const path of ['plugins', 'plugin-inventory', 'plugin-operations/id']) expect((await fetch(`${base}/api/coding-agents/dsh/${path}`)).status).toBe(403)
  expect((await fetch(`${base}/api/coding-agents/dsh/plugin-operations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
  expect(doubles.native).not.toHaveBeenCalled(); expect(doubles.submit).not.toHaveBeenCalled()
})
it('exposes native inventory independently and forwards revision preconditions for super admins', async () => {
  const base = await server('super_admin')
  doubles.native.mockResolvedValue({ presets: [{ id: 'standard', entries: [] }] })
  expect(await (await fetch(`${base}/api/coding-agents/dsh/plugin-inventory`)).json()).toMatchObject({ presets: [{ id: 'standard' }] })
  doubles.submit.mockResolvedValue({ id: 'operation', status: 'running' })
  const body = { action: 'configure', content: '[]', idempotencyKey: 'request' }
  const response = await fetch(`${base}/api/coding-agents/dsh/plugin-operations`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': '"revision"' }, body: JSON.stringify(body) })
  expect(response.status).toBe(202)
  expect(doubles.submit).toHaveBeenCalledWith(body, 'revision', expect.any(Function))
  expect((await fetch(`${base}/api/coding-agents/dsh/plugin-operations`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': '*' }, body: '{}' })).status).toBe(400)
})
