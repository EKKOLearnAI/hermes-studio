import type { GeneratedWidgetManifestItem } from '@/api/aurora/generated-widgets'
import type { GeneratedWidgetEntry } from './generated-widgets'
import type { AuroraAppKind } from './capability-manifest'

export type AuroraToolSecurityLevel = 'L1_ReadOnly' | 'L2_Draft' | 'L3_Approval' | 'L4_Locked'

export interface AuroraToolContext {
  input: string
}

export interface AuroraToolExecution<Result = unknown> {
  toolId: string
  toolName: string
  securityLevel: AuroraToolSecurityLevel
  args: unknown
  execute: () => Promise<Result>
}

export interface AuroraTool<Result = unknown> {
  id: string
  name: string
  description: string
  securityLevel: AuroraToolSecurityLevel
  canHandle: (context: AuroraToolContext) => boolean
  prepare: (context: AuroraToolContext) => AuroraToolExecution<Result> | null
}

export interface GeneratedWidgetLoadResult {
  widgetName: string
  componentPath: string
  query: string
  requestedAt: string
}

export interface GeneratedWidgetListResult {
  query: string
  manifestSource: 'backend' | 'bundle-fallback'
  widgets: Array<Pick<GeneratedWidgetEntry, 'widgetName' | 'componentPath'> & {
    deployedAt: string | null
    buildId: string | null
    spec: string | null
    source: GeneratedWidgetManifestItem['source'] | 'bundle'
    securityStatus: GeneratedWidgetManifestItem['securityStatus']
    permissions?: GeneratedWidgetManifestItem['permissions']
    loadable: boolean
  }>
  generatedAt: string
}

export interface LegacyAppOpenResult {
  kind: AuroraAppKind
  query: string
  requestedAt: string
  payload?: Record<string, unknown> | null
}
