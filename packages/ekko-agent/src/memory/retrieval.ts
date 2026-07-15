import type { MemoryNode, MemoryOmissionReason, MemoryQueryResult, MemoryScope } from './types'
import { memoryConflictKey } from './schema'

const SCOPE_PRIORITY: Record<MemoryScope, number> = {
  session: 4,
  workspace: 3,
  user: 2,
  global: 1,
}

export function resolveMemoryQuery(
  exactCandidates: MemoryNode[],
  relevantCandidates: MemoryNode[],
  queryText: string | undefined,
  limit: number,
  now = new Date(),
): MemoryQueryResult {
  const omitted: MemoryQueryResult['omitted'] = []
  const exact = resolveConflicts(exactCandidates, omitted, now)
  const ranked = resolveConflicts(relevantCandidates, omitted, now)
    .map(node => ({ node, score: relevanceScore(node, queryText || '') }))
    .filter(item => !queryText?.trim() || item.score > 0)
    .sort((left, right) => right.score - left.score || compareMemoryNodes(left.node, right.node))
    .map(item => item.node)

  const exactIds = new Set(exact.map(node => node.id))
  const relevant = ranked.filter(node => !exactIds.has(node.id))
  const combined = [...exact, ...relevant]
  if (combined.length > limit) {
    for (const node of combined.slice(limit)) omitted.push({ nodeId: node.id, reason: 'over_limit' })
  }
  const kept = combined.slice(0, limit)
  const keptExactIds = new Set(exact.map(node => node.id))
  return {
    exact: kept.filter(node => keptExactIds.has(node.id)),
    relevant: kept.filter(node => !keptExactIds.has(node.id)),
    omitted: dedupeOmissions(omitted),
  }
}

export function compareMemoryNodes(left: MemoryNode, right: MemoryNode): number {
  if (left.type === 'correction' && right.type !== 'correction') return -1
  if (right.type === 'correction' && left.type !== 'correction') return 1
  const scopeDifference = SCOPE_PRIORITY[right.scope] - SCOPE_PRIORITY[left.scope]
  if (scopeDifference) return scopeDifference
  const updatedDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  if (updatedDifference) return updatedDifference
  const confidenceDifference = right.confidence - left.confidence
  if (confidenceDifference) return confidenceDifference
  return right.importance - left.importance
}

export function relevanceScore(node: MemoryNode, queryText: string): number {
  const tokens = queryTokens(queryText)
  if (!tokens.length) return node.importance * 2 + node.confidence
  const title = node.title.toLowerCase()
  const content = node.content.toLowerCase()
  const tags = node.tags.join(' ').toLowerCase()
  const entities = node.entities.join(' ').toLowerCase()
  const category = node.categoryPath.join('/').toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (title.includes(token)) score += 5
    if (entities.includes(token)) score += 4
    if (tags.includes(token)) score += 3
    if (category.includes(token)) score += 2
    if (content.includes(token)) score += 2
  }
  return score + node.importance * 2 + node.confidence
}

function resolveConflicts(
  candidates: MemoryNode[],
  omitted: Array<{ nodeId: string; reason: MemoryOmissionReason }>,
  now: Date,
): MemoryNode[] {
  const active: MemoryNode[] = []
  for (const node of candidates) {
    if (node.status === 'superseded' || node.status === 'deleted') {
      omitted.push({ nodeId: node.id, reason: 'superseded' })
      continue
    }
    if (node.status === 'expired' || (node.expiresAt && Date.parse(node.expiresAt) <= now.getTime())) {
      omitted.push({ nodeId: node.id, reason: 'expired' })
      continue
    }
    if (node.confidence < 0.35) {
      omitted.push({ nodeId: node.id, reason: 'low_confidence' })
      continue
    }
    active.push(node)
  }

  const winners = new Map<string, MemoryNode>()
  const independent: MemoryNode[] = []
  for (const node of active.sort(compareMemoryNodes)) {
    if (!node.key) {
      independent.push(node)
      continue
    }
    const conflictKey = memoryConflictKey(node)!
    if (winners.has(conflictKey)) {
      omitted.push({ nodeId: node.id, reason: 'conflict_lost' })
      continue
    }
    winners.set(conflictKey, node)
  }
  return [...winners.values(), ...independent].sort(compareMemoryNodes)
}

function queryTokens(value: string): string[] {
  const normalized = value.toLowerCase().trim()
  if (!normalized) return []
  const words = normalized.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{1,}/gu) || []
  const tokens = new Set<string>()
  for (const word of words) {
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 2) {
      for (let index = 0; index < word.length - 1; index += 1) tokens.add(word.slice(index, index + 2))
    }
    tokens.add(word)
  }
  return [...tokens]
}

function dedupeOmissions(items: MemoryQueryResult['omitted']): MemoryQueryResult['omitted'] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = `${item.nodeId}:${item.reason}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
