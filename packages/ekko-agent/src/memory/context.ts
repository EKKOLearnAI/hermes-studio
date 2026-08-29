import type { MemoryContext, MemoryNode } from './types'
import { countTextTokens } from '../model/tokens'
import { DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET } from '../config'
import { PROFILE_MEMORY_SCOPE } from './scope'

export interface MemoryTokenSelection {
  nodes: MemoryNode[]
  omittedNodeIds: string[]
  usedTokens: number
}

export function selectMemoryNodesByTokenBudget(
  nodes: MemoryNode[],
  tokenBudget = DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET,
): MemoryTokenSelection {
  const budget = Math.max(0, Math.floor(tokenBudget))
  const selected: MemoryNode[] = []
  const omittedNodeIds: string[] = []
  let usedTokens = 0
  for (const node of nodes) {
    const nodeTokens = countTextTokens(formatMemoryCard(node))
    if (usedTokens + nodeTokens > budget) {
      omittedNodeIds.push(node.id)
      continue
    }
    selected.push(node)
    usedTokens += nodeTokens
  }
  return { nodes: selected, omittedNodeIds, usedTokens }
}

export function buildMemoryContextPrompt(context: MemoryContext): string {
  if (!context.diagnostics.enabled) return ''
  const sections: string[] = []
  appendNodes(sections, 'Active constraints', context.constraints)
  appendNodes(sections, 'Active tasks', context.activeTasks)
  appendNodes(sections, 'User preferences', context.preferences)
  const categorizedIds = new Set([
    ...context.constraints,
    ...context.activeTasks,
    ...context.preferences,
  ].map(node => node.id))
  appendNodes(sections, 'Relevant facts and decisions', context.relevantNodes.filter(node => !categorizedIds.has(node.id)))
  return [
    '## Memory Usage Rules',
    'The following content is only a partial automatic recall, not the complete memory store. Use it only when relevant; newer constraints and corrections override older preferences.',
    'When the user asks about personal information such as identity, name, location, relationships, preferences, habits, constraints, or long-term projects, inspect the automatically recalled cards first. If a current, conflict-free card directly answers the question, use it without searching again.',
    'If automatic recall has no direct answer, is incomplete, contains a conflict, or you are about to answer that you do not know or remember, call memory_search to verify. Prefer structured kinds when the information category is known; use queryText for open-ended questions. To enumerate the complete authorized store, call memory_search with all=true; never encode list-all intent in queryText. If the first search fails, adjust kinds or filters, or omit queryText to broaden the search. Never treat empty automatic recall as an empty memory store.',
    'Memory mutations happen immediately in this foreground run. When the current user explicitly asks to forget durable information, call memory_forget exactly once. Use all=true for an explicit request to forget every authorized memory; use targets for multiple already-resolved cards; otherwise resolve the intended card from automatic recall or memory_search. Never enumerate multiple memory_forget calls. For durable information worth retaining, call memory_write after checking the relevant active card with automatic recall, memory_search, or memory_get. Use memory_write to create or update the canonical slot directly. Do not write transient requests, tool results, or one-time facts.',
    'Do not infer durable user facts from weather lookups, location searches, tool output, or one-time behavior. Only information the user explicitly states, confirms, or adopts is evidence.',
    ...(sections.length ? ['## Automatically Recalled Memory', ...sections] : ['No memory cards were automatically recalled. Search the complete memory store when needed.']),
  ].join('\n\n')
}

function appendNodes(sections: string[], title: string, nodes: MemoryNode[]): void {
  if (!nodes.length) return
  sections.push(`${title}:\n${nodes.map(formatMemoryCard).join('\n')}`)
}

export function formatMemoryCard(node: MemoryNode): string {
  const value = node.valueJson === undefined ? '' : ` value=${JSON.stringify(node.valueJson)}`
  return `- id=${node.id} scope=${JSON.stringify(node.scope || PROFILE_MEMORY_SCOPE)} key=${node.key} revision=${node.revision}${value}\n  ${node.content}`
}
