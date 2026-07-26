import type { MemoryContext, MemoryNode } from './types'

export function buildMemoryContextPrompt(context: MemoryContext): string {
  if (!context.diagnostics.enabled) return ''
  const sections: string[] = []
  if (context.latestSummary) {
    sections.push(`最近一次会话摘要：\n${context.latestSummary.summary}`)
  }
  appendNodes(sections, '当前约束', context.constraints)
  appendNodes(sections, '当前任务', context.activeTasks)
  appendNodes(sections, '用户偏好', context.preferences)
  const categorizedIds = new Set([
    ...context.constraints,
    ...context.activeTasks,
    ...context.preferences,
  ].map(node => node.id))
  appendNodes(sections, '相关事实与决定', context.relevantNodes.filter(node => !categorizedIds.has(node.id)))
  return [
    '## 记忆使用规则',
    '以下内容只是自动召回的部分结果，不代表完整记忆库。仅在相关时使用；较新的约束和纠正优先于较旧的偏好。',
    '用户询问其身份、姓名、所在地、关系、偏好、习惯、约束、长期项目等个人信息时，先检查自动召回内容。已有直接回答问题、状态有效且没有冲突的记忆卡片时可以直接使用，不要重复搜索。',
    '自动召回中没有直接答案、信息不足、存在冲突，或你准备回答“不知道”“不记得”时，必须调用 memory_search 核实。已知信息类别时优先使用 kinds 结构化查询；只有开放性问题才使用 queryText。首次搜索没有结果时，调整类别或筛选条件，或省略 queryText 扩大搜索；不要把自动召回为空当成记忆库为空。',
    '不要根据天气查询、地点搜索、工具输出或一次性行为推断用户的长期事实；只有用户明确陈述、确认或采纳的信息才可作为依据。',
    ...(sections.length ? ['## 自动召回的记忆', ...sections] : ['当前没有自动召回到记忆卡片；需要时仍应主动搜索完整记忆库。']),
  ].join('\n\n')
}

function appendNodes(sections: string[], title: string, nodes: MemoryNode[]): void {
  if (!nodes.length) return
  sections.push(`${title}:\n${nodes.map(formatMemoryCard).join('\n')}`)
}

function formatMemoryCard(node: MemoryNode): string {
  const value = node.valueJson === undefined ? '' : ` value=${JSON.stringify(node.valueJson)}`
  return `- id=${node.id} key=${node.key} revision=${node.revision}${value}\n  ${node.content}`
}
