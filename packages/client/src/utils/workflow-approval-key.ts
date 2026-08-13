export function workflowApprovalKey(
  workflowId: string,
  runId: string,
  nodeId: string,
  executionId?: string,
): string {
  return `workflow-approval:${workflowId}:${runId}:${nodeId}:${executionId || ''}`
}
