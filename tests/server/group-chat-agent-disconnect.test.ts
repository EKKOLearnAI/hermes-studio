import { describe, expect, it, vi } from 'vitest'
import { AgentClient } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

describe('group Agent disconnect lifecycle', () => {
  it('awaits abort before disposing and clearing an active Pi session', async () => {
    let releaseAbort!: () => void
    const abortGate = new Promise<void>(resolve => { releaseAbort = resolve })
    const calls: string[] = []
    const abortSession = vi.fn(async () => {
      calls.push('abort:start')
      await abortGate
      calls.push('abort:end')
    })
    const disposeSession = vi.fn(async () => {
      calls.push('dispose')
    })
    const client = new AgentClient({
      agent: 'pi',
      profile: 'default',
      provider: 'custom:test',
      model: 'pi-test',
      name: 'Pi',
      description: '',
      invited: Date.now(),
      backgroundDelegationEnabled: false,
    })
    client.setChatRunService({
      runSession: vi.fn(),
      abortSession,
      disposeSession,
    } as any)
    ;(client as any).activeSessions.set('room-1', 'group-pi-session')

    const disconnecting = client.disconnect()
    await Promise.resolve()

    expect(calls).toEqual(['abort:start'])
    expect((client as any).activeSessions.get('room-1')).toBe('group-pi-session')

    releaseAbort()
    await disconnecting

    expect(calls).toEqual(['abort:start', 'abort:end', 'dispose'])
    expect((client as any).activeSessions.size).toBe(0)
  })
})
