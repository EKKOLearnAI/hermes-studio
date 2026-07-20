import type { MemoryKind, MemoryNode, MemoryNodeType, MemoryRuntimeIdentity } from './types'

export interface NormalizeMemoryNodeInput {
  draft: Partial<MemoryNode>
  identity?: Partial<MemoryRuntimeIdentity>
  explicitUserIntent?: boolean
  now?: string
}

interface MemorySlot {
  key: string
  domain: string
  categoryPath: string[]
  type: MemoryNodeType
  itemized?: boolean
}

const MEMORY_SLOTS: Record<MemoryKind, MemorySlot> = {
  interaction_contract: { key: 'interaction.relationship', domain: 'interaction', categoryPath: ['interaction', 'relationship'], type: 'preference' },
  profile_name: { key: 'profile.identity.name', domain: 'profile', categoryPath: ['profile', 'identity'], type: 'fact' },
  home_location: { key: 'profile.location.home', domain: 'profile', categoryPath: ['profile', 'location'], type: 'fact' },
  occupation: { key: 'profile.occupation', domain: 'profile', categoryPath: ['profile', 'occupation'], type: 'fact' },
  language_preference: { key: 'preference.language', domain: 'preference', categoryPath: ['preference', 'language'], type: 'preference' },
  accessibility_need: { key: 'constraint.accessibility', domain: 'constraint', categoryPath: ['constraint', 'accessibility'], type: 'constraint', itemized: true },
  communication_preference: { key: 'preference.communication', domain: 'preference', categoryPath: ['preference', 'communication'], type: 'preference', itemized: true },
  workflow_preference: { key: 'preference.workflow', domain: 'preference', categoryPath: ['preference', 'workflow'], type: 'preference', itemized: true },
  environment_fact: { key: 'environment.fact', domain: 'environment', categoryPath: ['environment'], type: 'fact', itemized: true },
  project_context: { key: 'project.context', domain: 'project', categoryPath: ['project'], type: 'fact', itemized: true },
  durable_decision: { key: 'decision.durable', domain: 'decision', categoryPath: ['decision'], type: 'decision', itemized: true },
  hard_constraint: { key: 'constraint.hard', domain: 'constraint', categoryPath: ['constraint'], type: 'constraint', itemized: true },
  food_avoidance: { key: 'preference.food.avoid', domain: 'preference', categoryPath: ['preference', 'food', 'avoid'], type: 'preference', itemized: true },
  custom_fact: { key: 'custom.fact', domain: 'custom', categoryPath: ['custom'], type: 'fact', itemized: true },
}

export type NormalizeMemoryNodeResult =
  | { accepted: true; node: Omit<MemoryNode, 'id'> }
  | { accepted: false; reason: string }

export function memoryConflictKey(node: Pick<MemoryNode, 'domain' | 'key' | 'valueJson'>): string | undefined {
  return `${node.domain}\u0000${node.key}`
}

export function canonicalizeMemoryDraft(
  kind: MemoryKind | undefined,
  itemKey: string | undefined,
  draft: Partial<MemoryNode>,
): { accepted: true; draft: Partial<MemoryNode> } | { accepted: false; reason: string } {
  if (!kind) return { accepted: false, reason: 'create requires a controlled memory kind.' }
  const slot = MEMORY_SLOTS[kind]
  if (!slot) return { accepted: false, reason: `Unsupported memory kind: ${String(kind)}` }
  const normalizedItem = normalizeCanonicalItem(itemKey || inferItemKey(kind, draft.valueJson))
  if (slot.itemized && !normalizedItem) {
    return { accepted: false, reason: `${kind} requires itemKey so the server can generate a stable canonical key.` }
  }
  const controlledValue = normalizeControlledValue(kind, draft.valueJson)
  if (!controlledValue.accepted) return controlledValue
  const key = slot.itemized ? `${slot.key}:${normalizedItem}` : slot.key
  const rendered = renderControlledMemory(kind, controlledValue.value)
  return {
    accepted: true,
    draft: {
      ...draft,
      domain: slot.domain,
      categoryPath: slot.categoryPath,
      type: slot.type,
      key,
      valueJson: controlledValue.value,
      title: rendered?.title || draft.title,
      content: rendered?.content || draft.content,
      entities: rendered?.entities ?? draft.entities,
    },
  }
}

export function memoryKindForCanonicalKey(key: string | undefined): { kind: MemoryKind; itemKey?: string } | undefined {
  if (!key) return undefined
  for (const [kind, slot] of Object.entries(MEMORY_SLOTS) as Array<[MemoryKind, MemorySlot]>) {
    if (key === slot.key) return { kind }
    if (slot.itemized && key.startsWith(`${slot.key}:`)) return { kind, itemKey: key.slice(slot.key.length + 1) }
  }
  return undefined
}

export function normalizeMemoryNode(input: NormalizeMemoryNodeInput): NormalizeMemoryNodeResult {
  const { draft, identity = {}, explicitUserIntent = false } = input
  const now = input.now || new Date().toISOString()
  const profileId = String(identity.profileId || draft.profileId || 'default').trim()
  if (identity.profileId && draft.profileId && identity.profileId !== draft.profileId) {
    return { accepted: false, reason: 'Memory profileId does not match the runtime identity.' }
  }

  const domain = String(draft.domain || 'general').trim()
  const categoryPath = uniqueStrings(draft.categoryPath || [domain])
  const type = draft.type || 'fact'
  const key = draft.key?.trim()
  if (!key) return { accepted: false, reason: 'Memory requires a server-controlled canonical key.' }

  const title = String(draft.title || '').trim()
  const content = String(draft.content || '').trim()
  if (!title || !content) return { accepted: false, reason: 'Memory title and content are required.' }

  const expiresAt = optionalIsoDate(draft.expiresAt)
  if (draft.expiresAt && !expiresAt) return { accepted: false, reason: 'expiresAt must be an ISO date.' }
  return {
    accepted: true,
    node: {
      parentId: draft.parentId,
      supersedesId: draft.supersedesId,
      profileId,
      domain,
      categoryPath: categoryPath.length ? categoryPath : [domain],
      type,
      key,
      revision: Math.max(1, Math.floor(draft.revision || 1)),
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

function inferItemKey(kind: MemoryKind, value: unknown): string | undefined {
  if (kind === 'food_avoidance') {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return String((value as Record<string, unknown>).ingredient || '')
    }
  }
  return undefined
}

function normalizeCanonicalItem(value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFKC').trim().toLowerCase()
    .replace(/[\s./\\-]+/g, '_')
    .replace(/[^\p{L}\p{N}_:]+/gu, '')
    .replace(/^_+|_+$/g, '')
  return normalized || undefined
}

function normalizeControlledValue(
  kind: MemoryKind,
  value: unknown,
): { accepted: true; value: unknown } | { accepted: false; reason: string } {
  if (kind === 'interaction_contract') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        accepted: false,
        reason: 'interaction_contract requires structured valueJson with userRole, assistantRole, or addressUserAs.',
      }
    }
    const record = value as Record<string, unknown>
    const normalized = {
      ...(cleanValue(record.userRole) ? { userRole: cleanValue(record.userRole) } : {}),
      ...(cleanValue(record.assistantRole) ? { assistantRole: cleanValue(record.assistantRole) } : {}),
      ...(cleanValue(record.addressUserAs) ? { addressUserAs: cleanValue(record.addressUserAs) } : {}),
    }
    if (!Object.keys(normalized).length) {
      return {
        accepted: false,
        reason: 'interaction_contract requires at least one non-empty relationship field.',
      }
    }
    return { accepted: true, value: normalized }
  }
  if (kind === 'home_location' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const city = cleanValue(record.city) || cleanValue(record.location)
    const country = cleanValue(record.country)
    if (!city) return { accepted: false, reason: 'home_location requires a city or location value.' }
    return { accepted: true, value: { city, ...(country ? { country } : {}) } }
  }
  return { accepted: true, value }
}

function renderControlledMemory(kind: MemoryKind, value: unknown): { title: string; content: string; entities?: string[] } | undefined {
  if (kind === 'interaction_contract' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const userRole = cleanValue(record.userRole)
    const assistantRole = cleanValue(record.assistantRole)
    const addressUserAs = cleanValue(record.addressUserAs)
    const parts = [
      userRole && assistantRole ? `用户设定双方关系：用户是${userRole}，助手是${assistantRole}` : '',
      userRole && !assistantRole ? `用户在互动中设定自己的角色为${userRole}` : '',
      assistantRole && !userRole ? `用户将助手的互动角色设定为${assistantRole}` : '',
      addressUserAs ? `助手应称呼用户为${addressUserAs}` : '',
    ].filter(Boolean)
    if (parts.length) {
      return {
        title: '用户与助手的互动关系',
        content: `${parts.join('；')}。`,
        entities: uniqueStrings([userRole, assistantRole, addressUserAs].filter((item): item is string => Boolean(item))),
      }
    }
  }
  if (kind === 'home_location' && typeof value === 'string' && value.trim()) {
    return { title: '用户常住地', content: `用户明确表示常住在${value.trim()}。`, entities: [value.trim()] }
  }
  if (kind === 'home_location' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const city = cleanValue(record.city)
    const country = cleanValue(record.country)
    if (city) {
      return {
        title: '用户常住地',
        content: `用户明确表示常住在${country ? `${country}${city}` : city}。`,
        entities: [city],
      }
    }
  }
  if (kind === 'profile_name' && typeof value === 'string' && value.trim()) {
    return { title: '用户姓名', content: `用户的姓名是${value.trim()}。`, entities: [value.trim()] }
  }
  return undefined
}

function cleanValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeValue(_key: string, value: unknown): unknown {
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
