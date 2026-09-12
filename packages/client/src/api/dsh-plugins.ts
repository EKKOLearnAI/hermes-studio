import { request } from './client'

export interface DshPluginPackage {
  name: string; version: string; kind: 'bundle' | 'dependency'; configuredEnabled: boolean
  containsBrowserPart: boolean; compatibility: 'unverified'; runtimePhase: null
  entries: Array<{ id: string; module: string; configuredEnabled: boolean | 'conditional' }>
}
export interface DshPluginOperation {
  id: string; action: string; status: 'running' | 'succeeded' | 'failed'
  revision?: string; packageName?: string; createdAt: string; finishedAt?: string; code?: string
}
export interface DshPluginSnapshot {
  sourceId: string; revision: string; activeRevision: string | null; content: string
  packages: DshPluginPackage[]; revisions: Array<{ id: string; createdAt: string }>; operations: DshPluginOperation[]
}
export type DshPluginChange = { action: 'install' | 'update'; packageSpec: string }
  | { action: 'remove'; packageName: string }
  | { action: 'toggle'; packageName: string; enabled: boolean }
  | { action: 'configure'; content: string }
  | { action: 'rollback'; revisionId: string }
export const readDshPlugins = () => request<DshPluginSnapshot>('/api/coding-agents/dsh/plugins')
export const changeDshPlugins = (change: DshPluginChange, revision: string, idempotencyKey: string) =>
  request<DshPluginOperation>('/api/coding-agents/dsh/plugin-operations', {
    method: 'POST', headers: { 'If-Match': `"${revision}"` }, body: JSON.stringify({ ...change, idempotencyKey }),
  })

export interface DshNativePluginInventory {
  source: 'native-presets'; sourceHome: string; packageVersion: string; defaultPreset: string
  runtimeConnected: false; discovery: 'shipped-and-user-roots'
  presets: Array<{ id: string; name: string; description: string; trust: 'system' | 'user'; sourcePath: string; isDefault: boolean; error?: string
    entries: Array<{ entryId: string; moduleName: string; configuredEnabled: boolean | 'conditional'; runtimePhase: null; groupPath: string[] }>
  }>
}
export const readNativeDshPlugins = () => request<DshNativePluginInventory>('/api/coding-agents/dsh/plugin-inventory')
