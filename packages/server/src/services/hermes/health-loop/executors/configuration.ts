import type { FabricExecutorAdapter } from '../../action-fabric/executors'
import { createWeixinReceiptSender } from '../../weixin-sender'
import { createHealthAnalysisExecutorAdapter } from './analysis'
import { createHealthPlanExecutorAdapter } from './plan'
import { createHealthShadowExecutorAdapter } from './shadow'
import { createHealthWeixinExecutorAdapter } from './weixin'
import { createHealthSourceExecutorAdapter, type HealthSourceService } from './source'
import type { HealthPlanRepository } from './plan'
import type {
  HealthAnalysisArtifactResolver, HealthAnalysisConsentConsumer, HealthExecutorAnalyzer,
} from './analysis'
import type { WeixinReceiptSender } from '../../weixin-sender'

export interface HealthFabricExecutorDependencies {
  sourceService?: HealthSourceService
  planRepository?: HealthPlanRepository
  localAnalyzer?: HealthExecutorAnalyzer
  localArtifactResolver?: HealthAnalysisArtifactResolver
  remoteAnalyzer?: HealthExecutorAnalyzer
  remoteArtifactResolver?: HealthAnalysisArtifactResolver
  remoteConsentConsumer?: HealthAnalysisConsentConsumer
  weixinSender?: WeixinReceiptSender
  profile?: string
}
let dependencies: HealthFabricExecutorDependencies = {}

/** Server-only configuration entrypoint; call before the Action Fabric runtime starts. */
export function configureHealthFabricExecutorDependencies(value: HealthFabricExecutorDependencies | null): void {
  dependencies = value ? { ...value } : {}
}

export function createConfiguredHealthFabricExecutorAdapters(): readonly FabricExecutorAdapter[] {
  const profile = dependencies.profile ?? 'default'
  return [
    createHealthShadowExecutorAdapter(),
    createHealthSourceExecutorAdapter(dependencies.sourceService),
    createHealthPlanExecutorAdapter({ repository: dependencies.planRepository }),
    createHealthAnalysisExecutorAdapter({ locality: 'local', analyzer: dependencies.localAnalyzer,
      artifactResolver: dependencies.localArtifactResolver }),
    createHealthAnalysisExecutorAdapter({ locality: 'remote', analyzer: dependencies.remoteAnalyzer,
      artifactResolver: dependencies.remoteArtifactResolver, consentConsumer: dependencies.remoteConsentConsumer }),
    createHealthWeixinExecutorAdapter({ profile,
      sender: dependencies.weixinSender ?? createWeixinReceiptSender(profile) }),
  ]
}
