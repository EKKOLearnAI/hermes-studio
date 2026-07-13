import type { FabricExecutorAdapter } from '../../action-fabric/executors'
import { createWeixinReceiptSender } from '../../weixin-sender'
import { createHealthAnalysisExecutorAdapter } from './analysis'
import { createHealthPlanExecutorAdapter } from './plan'
import { createHealthShadowExecutorAdapter } from './shadow'
import { createHealthWeixinExecutorAdapter } from './weixin'

export type HealthFabricExecutorAdapterFactory = () => readonly FabricExecutorAdapter[]
let configuredFactory: HealthFabricExecutorAdapterFactory | null = null

/** Server-only configuration entrypoint; call before the Action Fabric runtime starts. */
export function configureHealthFabricExecutorAdapters(factory: HealthFabricExecutorAdapterFactory | null): void {
  configuredFactory = factory
}

export function createConfiguredHealthFabricExecutorAdapters(): readonly FabricExecutorAdapter[] {
  if (configuredFactory) return configuredFactory()
  return [
    createHealthShadowExecutorAdapter(),
    // Fail closed until the health runtime injects durable plan/analyzer services.
    createHealthPlanExecutorAdapter(),
    createHealthAnalysisExecutorAdapter({ locality: 'local' }),
    createHealthAnalysisExecutorAdapter({ locality: 'remote' }),
    createHealthWeixinExecutorAdapter({ profile: 'default', sender: createWeixinReceiptSender('default') }),
  ]
}
