import { createHash } from 'crypto'

interface CapabilityGroup { provider: string; models: string[]; api_mode?: string }

function normalizedCapabilityTuples(groups: CapabilityGroup[]): string[] {
  return groups.flatMap(group => (group.models || []).map(model => `${group.provider}\u0000${model}\u0000${group.api_mode || ''}`)).sort()
}

export function workflowImportEnvironmentRevision(groups: CapabilityGroup[]): string {
  return createHash('sha256').update(JSON.stringify({ models: normalizedCapabilityTuples(groups) })).digest('hex')
}

export function assertWorkflowImportCapabilities(nodes: unknown[], groups: CapabilityGroup[]): void {
  const configured = new Set(normalizedCapabilityTuples(groups))
  for (const raw of nodes) {
    const node = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
    const data = node.data && typeof node.data === 'object' ? node.data as Record<string, any> : {}
    const provider = typeof data.provider === 'string' ? data.provider.trim() : ''
    const model = typeof data.model === 'string' ? data.model.trim() : ''
    const apiMode = typeof data.apiMode === 'string' ? data.apiMode.trim() : ''
    if (!provider && !model && !apiMode) continue
    const exact = `${provider}\u0000${model}\u0000${apiMode}`
    if (!configured.has(exact)) {
      throw Object.assign(new Error(`workflow node ${String(node.id || '?')} target capability is unavailable in profile`), { status: 409 })
    }
  }
}
