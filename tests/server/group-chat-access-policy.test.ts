import { describe, expect, it } from 'vitest'

import {
  decideGroupChatAccessPolicy,
  evaluateGroupChatAccessPolicy,
  groupChatInviteCodeMatches,
  type GroupChatAccessStore,
} from '../../packages/server/src/services/hermes/group-chat/access-policy'

describe('group chat access policy', () => {
  const room = {
    id: 'room-1',
    name: 'Room 1',
    ownerAuthUserId: 7,
    inviteCode: 'ROOM1',
    authorizationRevision: 3,
    sessionSeed: '11111111111111111111111111111111',
  }

  it('compares transport-decoded invite bytes exactly without normalization', () => {
    expect(groupChatInviteCodeMatches('ROOM1', 'ROOM1')).toBe(true)
    expect(groupChatInviteCodeMatches(' ROOM1', 'ROOM1')).toBe(false)
    expect(groupChatInviteCodeMatches('ROOM1 ', 'ROOM1')).toBe(false)
    expect(groupChatInviteCodeMatches('room1', 'ROOM1')).toBe(false)
    expect(groupChatInviteCodeMatches('ＲＯＯＭ１', 'ROOM1')).toBe(false)
    expect(groupChatInviteCodeMatches('', '')).toBe(false)
  })

  it('keeps invite-only authenticated actors read-only while super admins stay writable', () => {
    const storage: GroupChatAccessStore = {
      getRoom: () => room,
      findActiveActorByAuthUserId: (_roomId: string, authUserId: number) => authUserId === 42 ? {
        id: 'actor-readonly-1',
        roomId: 'room-1',
        actorType: 'authenticated_human',
        active: 1,
        authUserId: 42,
        agentId: null,
        localSubjectId: null,
        systemKey: null,
        name: 'Read Only',
        description: '',
        avatar: '',
        authorizationRevision: 0,
        contextRevision: 0,
        tombstonedAt: null,
        createdAt: 1,
        updatedAt: 1,
      } : null,
      getActorCapabilities: (actorId: string) => actorId === 'actor-readonly-1'
        ? ['room.read']
        : [],
    }

    const readonly = evaluateGroupChatAccessPolicy(storage, 'room-1', {
      kind: 'authenticated_human',
      authUserId: 42,
      role: 'admin',
      profiles: [],
    })
    const superAdmin = evaluateGroupChatAccessPolicy(storage, 'room-1', {
      kind: 'authenticated_human',
      authUserId: 1,
      role: 'super_admin',
      profiles: [],
    })

    expect(readonly).toMatchObject({
      actorId: 'actor-readonly-1',
      canDiscover: true,
      canJoin: true,
      canRead: true,
      canWrite: false,
      canType: false,
      canManage: false,
      canInvokeAgent: false,
      canInvokeAgents: false,
      canRespondApproval: false,
      canApprove: false,
    })
    expect(superAdmin).toMatchObject({
      canRead: true,
      canWrite: true,
      canType: true,
      canManage: true,
      canInvokeAgent: true,
      canInvokeAgents: true,
      canRespondApproval: true,
      canApprove: true,
    })
  })

  it('does not treat matching agent profiles as invite or membership authority', () => {
    const storage: GroupChatAccessStore = {
      getRoom: () => room,
      findActiveActorByAuthUserId: () => null,
      getActorCapabilities: () => [],
      getMemberByAuthUserId: () => null,
    }

    const matchingProfileUser = evaluateGroupChatAccessPolicy(storage, 'room-1', {
      kind: 'authenticated_human',
      authUserId: 42,
      role: 'admin',
      profiles: ['default', 'researcher'],
    })

    expect(matchingProfileUser).toMatchObject({
      actorId: null,
      canDiscover: false,
      canJoin: false,
      canRead: false,
      canWrite: false,
      canType: false,
      canManage: false,
      canInvokeAgent: false,
      canInvokeAgents: false,
      canRespondApproval: false,
      canApprove: false,
    })
  })

  it('treats persisted room agents as writable without granting approval controls', () => {
    const storage: GroupChatAccessStore = {
      getRoom: () => room,
      findActiveActorByAgentIdentity: (_roomId: string, agentId: string) => agentId === 'agent-1' ? {
        id: 'actor-agent-1',
        roomId: 'room-1',
        actorType: 'agent',
        active: 1,
        authUserId: null,
        agentId: 'agent-1',
        localSubjectId: null,
        systemKey: null,
        name: 'Agent',
        description: '',
        avatar: '',
        authorizationRevision: 2,
        contextRevision: 4,
        tombstonedAt: null,
        createdAt: 1,
        updatedAt: 1,
      } : null,
      getActorCapabilities: (actorId: string) => actorId === 'actor-agent-1'
        ? ['room.read', 'room.write', 'room.type', 'agent.invoke']
        : [],
    }

    const agent = evaluateGroupChatAccessPolicy(storage, 'room-1', {
      kind: 'agent',
      agentId: 'agent-1',
    })

    expect(agent).toMatchObject({
      actorId: 'actor-agent-1',
      canRead: true,
      canWrite: true,
      canType: true,
      canManage: false,
      canInvokeAgents: true,
      canApprove: false,
      actorAuthorizationRevision: 2,
      actorContextRevision: 4,
      roomAuthorizationRevision: 3,
    })
  })

  it('fails closed for active non-human actors with no persisted grants', () => {
    const actorBase = {
      id: 'actor-1',
      roomId: room.id,
      active: 1,
      authUserId: null,
      agentId: null,
      localSubjectId: null,
      systemKey: null,
      name: 'Actor',
      description: '',
      avatar: '',
      authorizationRevision: 4,
      contextRevision: 2,
      tombstonedAt: null,
      createdAt: 1,
      updatedAt: 1,
    } as const
    const subjects = [
      {
        subject: { kind: 'agent' as const, agentId: 'agent-1' },
        actor: { ...actorBase, actorType: 'agent' as const, agentId: 'agent-1' },
      },
      {
        subject: { kind: 'local' as const, localSubjectId: 'local-1' },
        actor: { ...actorBase, actorType: 'local' as const, localSubjectId: 'local-1' },
      },
      {
        subject: { kind: 'system' as const, systemKey: 'room-system' },
        actor: { ...actorBase, actorType: 'system' as const, systemKey: 'room-system' },
      },
    ]

    for (const { subject, actor } of subjects) {
      expect(decideGroupChatAccessPolicy({
        roomId: room.id,
        room,
        subject,
        actor,
        storedCapabilities: [],
        hasMembership: false,
      })).toMatchObject({
        actorId: actor.id,
        canDiscover: false,
        canJoin: false,
        canRead: false,
        canWrite: false,
        canType: false,
        canManage: false,
        canInvokeAgents: false,
        canApprove: false,
      })
    }
  })

  it('exposes a pure typed decision contract and never treats a routing id as local authority', () => {
    const decision = decideGroupChatAccessPolicy({
      roomId: room.id,
      room,
      subject: { kind: 'local', localSubjectId: 'client-routing-id' },
      actor: null,
      storedCapabilities: [],
      hasMembership: true,
    })

    expect(decision).toMatchObject({
      canDiscover: false,
      canJoin: false,
      canRead: false,
      canWrite: false,
      canType: false,
      canInvokeAgent: false,
      canRespondApproval: false,
      canManage: false,
    })
  })
})
