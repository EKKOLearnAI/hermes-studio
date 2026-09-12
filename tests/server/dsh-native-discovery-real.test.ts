import Koa from 'koa'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { codingAgentRoutes } from '../../packages/server/src/modules/coding-agents/routes/agents'

// No command/path mock: exercises the same discovery and controller as Studio.
it.skipIf(process.env.DSH_NATIVE_REAL !== '1')('serves installed native presets through the actual route and PATH discovery', async () => {
  const app = new Koa()
  app.use(async (ctx, next) => { ctx.state.user = { id: 1, username: 'inventory-test', role: 'super_admin' }; await next() })
  app.use(codingAgentRoutes.routes())
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/coding-agents/dsh/plugin-inventory`)
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.presets.find((preset: any) => preset.id === 'standard').entries).toHaveLength(28)
    expect(body.presets.find((preset: any) => preset.id === 'minimal').entries).toHaveLength(6)
    expect(body.runtimeConnected).toBe(false)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}, 30_000)
