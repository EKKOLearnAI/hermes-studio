export const DEFAULT_KANBAN_ASSIGNEE = 'default'

export interface KanbanAssigneeSummary {
  name: string
  counts?: Record<string, number> | null
}

export function assigneeTaskTotal(assignee: KanbanAssigneeSummary): number {
  return Object.values(assignee.counts || {}).reduce((sum, count) => sum + count, 0)
}

export function withDefaultAssignee<T extends KanbanAssigneeSummary>(
  assignees: T[],
  byAssignee: Record<string, number> = {},
): KanbanAssigneeSummary[] {
  const defaultCount = byAssignee[DEFAULT_KANBAN_ASSIGNEE] || 0
  return assignees.map(assignee => {
    if (assignee.name !== DEFAULT_KANBAN_ASSIGNEE || assignee.counts) return assignee
    return { ...assignee, counts: { total: defaultCount } }
  })
}
