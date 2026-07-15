export interface WorkflowImportSummary {
  name: string
  nodes: number
  edges: number
}

export function workflowImportConfirmationText(
  summary: WorkflowImportSummary,
  labels: { nodes: string; edges: string } = { nodes: 'nodes', edges: 'edges' },
): string {
  return `${summary.name} · ${summary.nodes} ${labels.nodes} · ${summary.edges} ${labels.edges}`
}
