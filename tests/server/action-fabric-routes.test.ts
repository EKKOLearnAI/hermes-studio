import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => ({
  capabilities: vi.fn(), executors: vi.fn(), createIntent: vi.fn(), workflows: vi.fn(),
  workflowDetail: vi.fn(), approveWorkflow: vi.fn(), rejectWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(), retryWorkflow: vi.fn(), compensateWorkflow: vi.fn(),
  auditEvents: vi.fn(), verifyAudit: vi.fn(), control: vi.fn(), updateEmergencyStop: vi.fn(),
}))
const requireSuperAdmin = vi.hoisted(() => vi.fn(async function requireSuperAdmin(_ctx: any, next: () => Promise<void>) { await next() }))

vi.mock('../../packages/server/src/controllers/hermes/action-fabric', () => handlers)
vi.mock('../../packages/server/src/middleware/user-auth', () => ({ requireSuperAdmin }))

describe('action fabric routes', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(handlers).forEach(handler => handler.mockClear())
    requireSuperAdmin.mockClear()
  })

  it('registers exactly the fourteen protected Action Fabric endpoints', async () => {
    const { actionFabricRoutes } = await import('../../packages/server/src/routes/hermes/action-fabric')
    expect(actionFabricRoutes.stack.map((entry: any) => `${entry.methods.join(',')}:${entry.path}`)).toEqual([
      'HEAD,GET:/api/hermes/action-fabric/capabilities',
      'HEAD,GET:/api/hermes/action-fabric/executors',
      'POST:/api/hermes/action-fabric/intents',
      'HEAD,GET:/api/hermes/action-fabric/workflows',
      'HEAD,GET:/api/hermes/action-fabric/workflows/:id',
      'POST:/api/hermes/action-fabric/workflows/:id/approve',
      'POST:/api/hermes/action-fabric/workflows/:id/reject',
      'POST:/api/hermes/action-fabric/workflows/:id/cancel',
      'POST:/api/hermes/action-fabric/workflows/:id/retry',
      'POST:/api/hermes/action-fabric/workflows/:id/compensate',
      'HEAD,GET:/api/hermes/action-fabric/audit',
      'HEAD,GET:/api/hermes/action-fabric/audit/verify',
      'HEAD,GET:/api/hermes/action-fabric/control',
      'PUT:/api/hermes/action-fabric/control/emergency-stop',
    ])
  })

  it('requires super-admin authorization on every POST and PUT but not GET', async () => {
    const { actionFabricRoutes } = await import('../../packages/server/src/routes/hermes/action-fabric')
    for (const layer of actionFabricRoutes.stack as any[]) {
      const mutation = layer.methods.includes('POST') || layer.methods.includes('PUT')
      expect(layer.stack.includes(requireSuperAdmin), `${layer.methods}:${layer.path}`).toBe(mutation)
      if (mutation) expect(layer.stack.indexOf(requireSuperAdmin)).toBeLessThan(layer.stack.length - 1)
    }
  })

  it('mounts the Action Fabric router only after global authentication', () => {
    const source = readFileSync('packages/server/src/routes/index.ts', 'utf8')
    const authIndex = source.indexOf('authMiddleware.forEach')
    const mountIndex = source.indexOf('app.use(actionFabricRoutes.routes())')
    expect(authIndex).toBeGreaterThan(-1)
    expect(mountIndex).toBeGreaterThan(authIndex)
  })
})
