import { describe, expect, it } from 'vitest'
import {
  buildProjectedGroupChatHistory,
  isWorkspaceDiffToolMessage,
  projectGroupChatMessage,
} from '../../packages/server/src/services/hermes/group-chat/context-projection'

function message(overrides: Record<string, unknown>) {
  return {
    id: 'm1',
    roomId: 'room-1',
    senderId: 'agent-1',
    senderName: 'Worker',
    content: 'hello',
    timestamp: 1,
    role: 'user',
    ...overrides,
  } as any
}

describe('group chat workspace diff context exclusion', () => {
  it('identifies workspace_diff tool messages for hard context exclusion', () => {
    expect(isWorkspaceDiffToolMessage(message({ role: 'tool', tool_name: 'workspace_diff' }))).toBe(true)
    expect(isWorkspaceDiffToolMessage(message({ role: 'tool', tool_name: 'search' }))).toBe(false)
  })

  it('excludes workspace_diff messages from projected model history while keeping regular tools', () => {
    const diff = message({
      id: 'diff-1',
      role: 'tool',
      tool_name: 'workspace_diff',
      content: JSON.stringify({ kind: 'workspace_diff', files: [{ patch: '+secret patch' }] }),
    })
    const regularTool = message({
      id: 'tool-1',
      role: 'tool',
      tool_name: 'search',
      content: 'docs found',
    })

    const history = buildProjectedGroupChatHistory('', [
      message({ id: 'm1', senderName: 'Alice', senderId: 'user-1', role: 'user', content: '@Worker hello' }),
      diff,
      regularTool,
    ], { agentId: 'agent-1', name: 'Worker' })

    expect(history.map(item => item.content).join('\n')).not.toContain('secret patch')
    expect(history).toContainEqual(projectGroupChatMessage(regularTool, { agentId: 'agent-1', name: 'Worker' }))
  })
})
