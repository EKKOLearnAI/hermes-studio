import type { MemoryOrigin, MemoryScope } from './types'

export const PROFILE_MEMORY_SCOPE: MemoryScope = Object.freeze({ type: 'profile' })

export function normalizeMemoryScope(value: unknown): MemoryScope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const type = String(record.type || '').trim()
  if (type === 'profile') return { type: 'profile' }
  if (type === 'session') {
    const id = clean(record.id)
    return id ? { type: 'session', id } : undefined
  }
  if (type === 'context') {
    const namespace = clean(record.namespace)
    const id = clean(record.id)
    return namespace && id ? { type: 'context', namespace, id } : undefined
  }
  return undefined
}

export function normalizeMemoryScopes(
  values: readonly MemoryScope[] | undefined,
  fallback: readonly MemoryScope[] = [PROFILE_MEMORY_SCOPE],
): MemoryScope[] {
  const output = new Map<string, MemoryScope>()
  for (const value of values?.length ? values : fallback) {
    const scope = normalizeMemoryScope(value)
    if (scope) output.set(memoryScopeKey(scope), scope)
  }
  return [...output.values()]
}

export function normalizeMemoryOrigin(value: unknown): MemoryOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const origin: MemoryOrigin = {
    ...(clean(record.host) ? { host: clean(record.host) } : {}),
    ...(clean(record.namespace) ? { namespace: clean(record.namespace) } : {}),
    ...(clean(record.contextId) ? { contextId: clean(record.contextId) } : {}),
  }
  return Object.keys(origin).length ? origin : undefined
}

export function memoryScopeKey(value: MemoryScope | undefined): string {
  const scope = normalizeMemoryScope(value) || PROFILE_MEMORY_SCOPE
  if (scope.type === 'profile') return 'profile\0\0'
  if (scope.type === 'session') return `session\0\0${scope.id}`
  return `context\0${scope.namespace}\0${scope.id}`
}

export function memoryScopeEquals(left: MemoryScope | undefined, right: MemoryScope | undefined): boolean {
  return memoryScopeKey(left) === memoryScopeKey(right)
}

export function memoryScopeAllowed(scope: MemoryScope | undefined, allowed: readonly MemoryScope[] | undefined): boolean {
  if (!allowed?.length) return memoryScopeEquals(scope, PROFILE_MEMORY_SCOPE)
  return allowed.some(candidate => memoryScopeEquals(scope, candidate))
}

export function memoryScopeDescription(scope: MemoryScope): string {
  if (scope.type === 'profile') return 'profile: shared by the current profile across conversations'
  if (scope.type === 'session') return `session:${scope.id}: visible only in this session`
  return `context:${scope.namespace}:${scope.id}: visible only in this host-defined context`
}

export function memoryScopeColumns(scope: MemoryScope | undefined): {
  type: MemoryScope['type']
  namespace: string
  id: string
} {
  const normalized = normalizeMemoryScope(scope) || PROFILE_MEMORY_SCOPE
  if (normalized.type === 'profile') return { type: 'profile', namespace: '', id: '' }
  if (normalized.type === 'session') return { type: 'session', namespace: '', id: normalized.id }
  return { type: 'context', namespace: normalized.namespace, id: normalized.id }
}

export function memoryScopeFromColumns(type: unknown, namespace: unknown, id: unknown): MemoryScope {
  return normalizeMemoryScope({ type, namespace, id }) || PROFILE_MEMORY_SCOPE
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
