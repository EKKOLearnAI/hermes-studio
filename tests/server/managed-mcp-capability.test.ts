import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestGroupChatServer, seedAuthenticatedUser } from './group-chat-test-helpers'
import { issueManagedMcpCapability, authorizeManagedMcpCapability } from '../../packages/server/src/services/hermes/managed-mcp-capability'

describe('managed MCP durable capability', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>

  beforeEach(async () => {
    process.env.AUTH_JWT_SECRET = 'managed-mcp-test-secret'
    harness = await createTestGroupChatServer()
  })

  afterEach(() => {
    delete process.env.AUTH_JWT_SECRET
    harness.cleanup()
  })

  function runningHandoff() {
    seedAuthenticatedUser(harness.db, { id: 42, username: 'initiator', profiles: ['work'] })
    const storage = harness.groupServer.getStorage()
    storage.saveRoom('room-capability', 'Capability Room', 'ROOM1', { ownerAuthUserId: 42 })
    const participant = storage.addRoomAgent('room-capability', 'agent-work', 'work', 'Worker', '', 0, {
      sessionId: 'session-work', sessionGeneration: 3,
    })
    storage.admitHumanMember({
      roomId: 'room-capability', userId: 'auth:42', requestedName: 'Initiator', requestedDescription: '', avatar: '',
      authUser: { id: 42, username: 'initiator', role: 'admin', profiles: ['work'] },
    })
    const initiator = storage.findActiveActorByAuthUserId('room-capability', 42)!
    const saved = storage.saveMessageAndRefreshRoom({
      id: 'capability-source', roomId: 'room-capability', senderId: 'auth:42', senderName: 'Initiator',
      content: '@Worker run', timestamp: 1, role: 'user',
    }, {
      handoffs: [{ chainId: 'cap-chain', targetAgentId: participant.agentId, targetSessionId: participant.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: initiator.id, sourceActorId: initiator.id },
    })
    return { storage, participant, job: storage.claimHandoffJobs('cap-worker', Date.now(), 1, 60_000)[0] || saved.handoffJobs[0] }
  }

  it('authorizes only the exact durable Room participant server and tool while authority remains current', async () => {
    const { storage, participant, job } = runningHandoff()
    const token = await issueManagedMcpCapability(storage, {
      jobId: job.id,
      leaseToken: job.leaseToken,
      participantAgentId: participant.agentId,
      profile: 'work',
      serverTools: { 'hermes-studio-devices': ['hermes_studio_lan_devices_list'] },
    })

    await expect(authorizeManagedMcpCapability(storage, {
      token, server: 'hermes-studio-devices', toolset: 'devices', tool: 'hermes_studio_lan_devices_list',
    })).resolves.toMatchObject({ roomId: 'room-capability', profile: 'work', jobId: job.id })
    await expect(authorizeManagedMcpCapability(storage, {
      token, server: 'hermes-studio-devices', toolset: 'devices', tool: 'hermes_studio_lan_command_exec',
    })).rejects.toThrow(/not authorized/i)
  })

  it('revokes immediately after Profile assignment removal even when room.manage remains', async () => {
    const { storage, participant, job } = runningHandoff()
    const token = await issueManagedMcpCapability(storage, {
      jobId: job.id,
      leaseToken: job.leaseToken,
      participantAgentId: participant.agentId,
      profile: 'work',
      serverTools: { 'hermes-studio-api': ['hermes_studio_api_request'] },
    })
    harness.db.prepare('DELETE FROM user_profiles WHERE user_id = ? AND profile_name = ?').run(42, 'work')

    await expect(authorizeManagedMcpCapability(storage, {
      token, server: 'hermes-studio-api', toolset: 'api', tool: 'hermes_studio_api_request',
    })).rejects.toThrow(/Profile assignment|revoked/i)
    expect(storage.getActorCapabilities(storage.findActiveActorByAuthUserId('room-capability', 42)!.id)).toContain('room.manage')
  })

  it('rejects malformed, expired, stale-session, and revoked-lease capabilities fail closed', async () => {
    const { storage, participant, job } = runningHandoff()
    const expired = await issueManagedMcpCapability(storage, {
      jobId: job.id, leaseToken: job.leaseToken, participantAgentId: participant.agentId, profile: 'work',
      serverTools: { 'hermes-studio-use': ['hermes_studio_use_profiles_list'] }, expiresAt: Date.now() - 1,
    })
    const request = { server: 'hermes-studio-use', toolset: 'use', tool: 'hermes_studio_use_profiles_list' }
    await expect(authorizeManagedMcpCapability(storage, { token: 'not-a-token', ...request })).rejects.toThrow()
    await expect(authorizeManagedMcpCapability(storage, { token: expired, ...request })).rejects.toThrow(/expired/i)

    const live = await issueManagedMcpCapability(storage, {
      jobId: job.id, leaseToken: job.leaseToken, participantAgentId: participant.agentId, profile: 'work',
      serverTools: { 'hermes-studio-use': ['hermes_studio_use_profiles_list'] },
    })
    harness.db.prepare('UPDATE gc_room_agents SET sessionGeneration = sessionGeneration + 1 WHERE roomId = ? AND agentId = ?')
      .run('room-capability', participant.agentId)
    await expect(authorizeManagedMcpCapability(storage, { token: live, ...request })).rejects.toThrow(/session|lease|authority/i)

    storage.cancelHandoffJobs('room-capability')
    await expect(authorizeManagedMcpCapability(storage, { token: live, ...request })).rejects.toThrow(/durable|lease|revoked/i)
  })
})
