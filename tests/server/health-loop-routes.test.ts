import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers=vi.hoisted(()=>({overview:vi.fn(),connectors:vi.fn(),syncConnector:vi.fn(),createArtifact:vi.fn(),
  analyzeArtifact:vi.fn(),createConsent:vi.fn(),revokeConsent:vi.fn(),interventions:vi.fn(),
  interventionFeedback:vi.fn(),settings:vi.fn(),updateSettings:vi.fn()}))
const requireSuperAdmin=vi.hoisted(()=>vi.fn(async(_ctx:any,next:()=>Promise<void>)=>next()))
vi.mock('../../packages/server/src/controllers/hermes/health-loop',()=>handlers)
vi.mock('../../packages/server/src/middleware/user-auth',()=>({requireSuperAdmin}))

describe('health loop routes',()=>{
  beforeEach(()=>vi.resetModules())
  it('registers all eleven endpoints in a stable order',async()=>{
    const {healthLoopRoutes}=await import('../../packages/server/src/routes/hermes/health-loop')
    expect(healthLoopRoutes.stack.map((layer:any)=>`${layer.methods.join(',')}:${layer.path}`)).toEqual([
      'HEAD,GET:/api/hermes/health-loop/overview','HEAD,GET:/api/hermes/health-loop/connectors',
      'POST:/api/hermes/health-loop/connectors/:id/sync','POST:/api/hermes/health-loop/artifacts',
      'POST:/api/hermes/health-loop/artifacts/:id/analyze','POST:/api/hermes/health-loop/consents',
      'POST:/api/hermes/health-loop/consents/:id/revoke','HEAD,GET:/api/hermes/health-loop/interventions',
      'POST:/api/hermes/health-loop/interventions/:id/feedback','HEAD,GET:/api/hermes/health-loop/settings',
      'PUT:/api/hermes/health-loop/settings'])
  })
  it('uses super-admin middleware for every high-impact mutation, leaving dynamic live settings enforcement to the controller',async()=>{
    const {healthLoopRoutes}=await import('../../packages/server/src/routes/hermes/health-loop')
    for(const layer of healthLoopRoutes.stack as any[]){
      const highImpact=layer.methods.includes('POST')&&!layer.path.endsWith('/artifacts')
      expect(layer.stack.includes(requireSuperAdmin),`${layer.methods}:${layer.path}`).toBe(highImpact)
    }
  })
  it('mounts the router after global authentication',()=>{
    const source=readFileSync('packages/server/src/routes/index.ts','utf8')
    expect(source.indexOf('app.use(healthLoopRoutes.routes())')).toBeGreaterThan(source.indexOf('authMiddleware.forEach'))
  })
})
