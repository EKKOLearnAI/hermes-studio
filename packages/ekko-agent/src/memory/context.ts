import type { MemoryContext, MemoryNode } from './types'

export function buildMemoryContextPrompt(context: MemoryContext): string {
  if (!context.diagnostics.enabled || context.usedMemoryIds.length === 0 && !context.latestSummary) return ''
  const sections: string[] = []
  if (context.latestSummary) {
    sections.push(`Latest session summary:\n${context.latestSummary.summary}`)
  }
  appendNodes(sections, 'Active constraints', context.constraints)
  appendNodes(sections, 'Active tasks', context.activeTasks)
  appendNodes(sections, 'User preferences', context.preferences)
  const categorizedIds = new Set([
    ...context.constraints,
    ...context.activeTasks,
    ...context.preferences,
  ].map(node => node.id))
  appendNodes(sections, 'Relevant facts and decisions', context.relevantNodes.filter(node => !categorizedIds.has(node.id)))
  if (!sections.length) return ''
  return [
    '## Retrieved Memory',
    'Use these memories only when relevant. Newer constraints and corrections override older preferences.',
    ...sections,
  ].join('\n\n')
}

function appendNodes(sections: string[], title: string, nodes: MemoryNode[]): void {
  if (!nodes.length) return
  sections.push(`${title}:\n${nodes.map(node => `- [${node.id}] ${node.content}`).join('\n')}`)
}
