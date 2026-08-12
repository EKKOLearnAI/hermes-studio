import { describe, expect, it } from 'vitest'
import { serializeRoom } from '../../packages/server/src/routes/hermes/group-chat'

describe('group chat room serialization', () => {
  it('does not expose internal summary concurrency fields', () => {
    const result = serializeRoom({
      id: 'room-1',
      name: 'Room',
      ownerAuthUserId: 42,
      summaryGeneration: 7,
      summaryRunToken: 'secret-run-token',
      summaryLeaseExpiresAt: 12345,
      summaryRunGeneration: 6,
    }, true, true)

    expect(result).toMatchObject({
      id: 'room-1',
      name: 'Room',
      canManage: true,
      canMentionAll: true,
      ownerMemberId: 'auth:42',
    })
    expect(result).not.toHaveProperty('ownerAuthUserId')
    expect(result).not.toHaveProperty('summaryGeneration')
    expect(result).not.toHaveProperty('summaryRunToken')
    expect(result).not.toHaveProperty('summaryLeaseExpiresAt')
    expect(result).not.toHaveProperty('summaryRunGeneration')
  })
})