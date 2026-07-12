import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const view = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')

describe('workflow output handle drop contract', () => {
  it('creates a Hermes node at an empty canvas drop point and connects it with a success edge', () => {
    expect(view).toContain("type OnConnectStartParams")
    expect(view).toContain('@connect-start="handleConnectStart"')
    expect(view).toContain('@connect-end="handleConnectEnd"')
    expect(view).toContain("handleType !== 'source'")
    expect(view).toContain("handleId !== 'output'")
    expect(view).toContain("target.closest('.vue-flow__node, .vue-flow__edge, .vue-flow__handle, .vue-flow__controls, .vue-flow__minimap')")
    expect(view).toContain("nodes.value.some(node => node.id === source)")
    expect(view).toContain('screenToFlowCoordinate({ x: event.clientX, y: event.clientY })')
    expect(view).toContain("agent: 'hermes'")
    expect(view).toContain("sourceHandle: 'output'")
    expect(view).toContain("targetHandle: 'input'")
    expect(view).toContain("data: { orchestration: { route: 'success' } }")
    expect(view).toMatch(/function handleConnectEnd[\s\S]*?if \(selectedWorkflowRunId\.value\) return/)
  })
})
