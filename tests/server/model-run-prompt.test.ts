import { describe, expect, it, vi } from 'vitest'

const issueModelRunJwtMock = vi.hoisted(() => vi.fn(async () => 'model-run-token'))

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  issueModelRunJwt: issueModelRunJwtMock,
}))

describe('model run prompt', () => {
  it('builds shared model-run auth context without agent-specific MCP tool names', async () => {
    const { buildModelRunAuthPrompt } = await import('../../packages/server/src/services/hermes/run-chat/model-run-prompt')
    const prompt = await buildModelRunAuthPrompt({ id: 1, username: 'admin', role: 'super_admin' }, 'default')
    const text = prompt.join('\n')

    expect(issueModelRunJwtMock).toHaveBeenCalledWith({ id: 1, username: 'admin', role: 'super_admin' })
    expect(text).toContain('[Current Hermes profile: default]')
    expect(text).toContain('[Current Hermes Web UI model run token: model-run-token]')
    expect(text).toContain('pass the current Hermes profile as the profile argument')
    expect(text).not.toContain('list_mcp_resources')
    expect(text).not.toContain('mcp__hermes-studio__')
  })
})
