import type { MemoryNode, MemoryRuntimeIdentity, MemoryScope } from './types'

const KEY_ALIASES: Record<string, string> = {
  avoid_food: 'avoid_ingredient',
  disliked_ingredient: 'avoid_ingredient',
  excluded_ingredient: 'avoid_ingredient',
  preferred_food: 'preferred_ingredient',
  taste_profile: 'flavor_profile',
}

const CONTROLLED_KEYS = new Set([
  'avoid_ingredient',
  'preferred_ingredient',
  'flavor_profile',
  'dietary_restriction',
  'cooking_time_preference',
])

export interface NormalizeMemoryNodeInput {
  draft: Partial<MemoryNode>
  identity?: Partial<MemoryRuntimeIdentity>
  explicitUserIntent?: boolean
  now?: string
}

export type NormalizeMemoryNodeResult =
  | { accepted: true; node: Omit<MemoryNode, 'id'> }
  | { accepted: false; reason: string }

export function normalizeMemoryKey(key: string | undefined): string | undefined {
  const normalized = key?.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!normalized) return undefined
  return KEY_ALIASES[normalized] || normalized
}

export function memoryConflictKey(node: Pick<MemoryNode, 'domain' | 'key' | 'valueJson'>): string | undefined {
  if (!node.key) return undefined
  if (node.key === 'avoid_ingredient' || node.key === 'preferred_ingredient') {
    const subject = typeof node.valueJson === 'string'
      ? node.valueJson
      : node.valueJson && typeof node.valueJson === 'object' && !Array.isArray(node.valueJson)
        ? (node.valueJson as Record<string, unknown>).ingredient
        : undefined
    if (subject != null && String(subject).trim()) {
      return `${node.domain}\u0000${node.key}\u0000${String(subject).trim().toLowerCase()}`
    }
  }
  return `${node.domain}\u0000${node.key}`
}

export function normalizeMemoryNode(input: NormalizeMemoryNodeInput): NormalizeMemoryNodeResult {
  const { draft, identity = {}, explicitUserIntent = false } = input
  const now = input.now || new Date().toISOString()
  const scope = normalizeScope(draft.scope, identity)
  if (scope === 'global') return { accepted: false, reason: 'Global memory is read-only.' }
  if (scope === 'user' && !explicitUserIntent) {
    return { accepted: false, reason: 'User-scoped memory requires explicit user intent.' }
  }

  const domain = String(draft.domain || 'general').trim()
  const categoryPath = uniqueStrings(draft.categoryPath || [domain])
  const type = draft.type || 'fact'
  const key = normalizeMemoryKey(draft.key)
  if (key && domain === '生活技能' && categoryPath.includes('做饭') && !CONTROLLED_KEYS.has(key)) {
    return { accepted: false, reason: `Unsupported controlled cooking memory key: ${key}` }
  }

  const title = String(draft.title || '').trim()
  const content = String(draft.content || '').trim()
  if (!title || !content) return { accepted: false, reason: 'Memory title and content are required.' }

  const expiresAt = optionalIsoDate(draft.expiresAt)
  if (draft.expiresAt && !expiresAt) return { accepted: false, reason: 'expiresAt must be an ISO date.' }
  const scopeBinding = bindScope(scope, draft, identity)
  if (!scopeBinding.accepted) return scopeBinding

  return {
    accepted: true,
    node: {
      parentId: draft.parentId,
      supersedesId: draft.supersedesId,
      ...scopeBinding.binding,
      scope,
      domain,
      categoryPath: categoryPath.length ? categoryPath : [domain],
      type,
      key,
      valueJson: normalizeValue(key, draft.valueJson),
      title,
      content,
      status: draft.status || 'active',
      confidence: clampScore(draft.confidence, explicitUserIntent ? 0.98 : 0.7),
      importance: clampScore(draft.importance, explicitUserIntent ? 0.9 : 0.6),
      tags: uniqueStrings(draft.tags || []),
      entities: uniqueStrings(draft.entities || []),
      sourceMessageIds: uniqueStrings(draft.sourceMessageIds || []),
      createdAt: draft.createdAt || now,
      updatedAt: now,
      expiresAt,
    },
  }
}

function normalizeScope(scope: MemoryScope | undefined, identity: Partial<MemoryRuntimeIdentity>): MemoryScope {
  if (scope) return scope
  if (identity.workspaceId) return 'workspace'
  return 'session'
}

function bindScope(
  scope: MemoryScope,
  draft: Partial<MemoryNode>,
  identity: Partial<MemoryRuntimeIdentity>,
): { accepted: true; binding: Pick<MemoryNode, 'sessionId' | 'workspaceId' | 'userId'> } | { accepted: false; reason: string } {
  if (identity.sessionId && draft.sessionId && identity.sessionId !== draft.sessionId) {
    return { accepted: false, reason: 'Memory sessionId does not match the runtime identity.' }
  }
  if (identity.workspaceId && draft.workspaceId && identity.workspaceId !== draft.workspaceId) {
    return { accepted: false, reason: 'Memory workspaceId does not match the runtime identity.' }
  }
  if (identity.userId && draft.userId && identity.userId !== draft.userId) {
    return { accepted: false, reason: 'Memory userId does not match the runtime identity.' }
  }
  const sessionId = identity.sessionId || draft.sessionId
  const workspaceId = identity.workspaceId || draft.workspaceId
  const userId = identity.userId || draft.userId
  if (scope === 'session' && !sessionId) return { accepted: false, reason: 'Session-scoped memory requires sessionId.' }
  if (scope === 'workspace' && !workspaceId) return { accepted: false, reason: 'Workspace-scoped memory requires workspaceId.' }
  if (scope === 'user' && !userId) return { accepted: false, reason: 'User-scoped memory requires userId.' }
  return {
    accepted: true,
    binding: {
      sessionId: scope === 'session' ? sessionId : draft.sessionId,
      workspaceId: scope === 'workspace' ? workspaceId : draft.workspaceId,
      userId: scope === 'user' ? userId : draft.userId,
    },
  }
}

function normalizeValue(key: string | undefined, value: unknown): unknown {
  if (key === 'flavor_profile' && typeof value === 'string') {
    const output: Record<string, string> = {}
    if (/少油|低油|low oil/i.test(value)) output.oil = 'low'
    if (/少辣|微辣|low spic/i.test(value)) output.spicy = 'low'
    return Object.keys(output).length ? output : value.trim()
  }
  if (typeof value === 'string') return value.trim()
  return value
}

function optionalIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))]
}

function clampScore(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, Number(value)))
}
