import { createHash, timingSafeEqual } from 'node:crypto'

import {
  groupChatCapabilityFlags,
  normalizeGroupChatCapabilities,
  SUPPORTED_GROUP_CHAT_CAPABILITIES,
  type GroupChatCapability,
  type GroupChatCapabilityDecision,
} from './identity/capability-policy'
import type { GroupActor, GroupActorType } from './identity/types'
import { revisionNumber } from './identity/types'

export interface GroupChatAuthenticatedUserLike {
  id?: number | null
  role: string
  profiles?: readonly string[]
}

export interface GroupChatRoomRecord {
  id: string
  inviteCode?: string | null
  ownerAuthUserId?: number | null
  authorizationRevision?: number
}

export interface GroupChatMemberRecord {
  id: string
  userId: string
  name: string
  description: string
  joinedAt: number
  avatar: string
  authUserId?: number | null
}

export interface GroupChatAccessStore {
  getRoom?: (roomId: string) => GroupChatRoomRecord | null | undefined
  getMemberByAuthUserId?: (roomId: string, authUserId: number) => GroupChatMemberRecord | null
  getMemberByUserId?: (roomId: string, userId: string) => GroupChatMemberRecord | null
  findActiveActorByAuthUserId?: (roomId: string, authUserId: number) => GroupActor | null
  findActiveActorByAgentIdentity?: (roomId: string, agentId: string) => GroupActor | null
  findActiveActorByLocalSubjectId?: (roomId: string, localSubjectId: string) => GroupActor | null
  findActiveActorBySystemKey?: (roomId: string, systemKey: string) => GroupActor | null
  getActorCapabilities?: (actorId: string) => readonly string[]
}

export type GroupChatSubject =
  | {
      kind: 'authenticated_human'
      authUserId: number | null
      role: string
      profiles: readonly string[]
    }
  | {
      kind: 'agent'
      agentId: string
    }
  | {
      kind: 'local'
      localSubjectId: string
    }
  | {
      kind: 'system'
      systemKey: string
    }

export interface GroupChatAccessDecision extends GroupChatCapabilityDecision {
  roomId: string
  roomExists: boolean
  canDiscover: boolean
  canJoin: boolean
  canInvokeAgent: boolean
  canRespondApproval: boolean
  actorId: string | null
  actorType: GroupActorType | null
  actorAuthorizationRevision: number
  actorContextRevision: number
  roomAuthorizationRevision: number
}

export interface GroupChatAccessPolicyInput {
  roomId: string
  room: GroupChatRoomRecord | null
  subject: GroupChatSubject
  actor: GroupActor | null
  storedCapabilities: readonly string[]
  hasMembership: boolean
}

function inviteDigest(value: string): Buffer {
  return createHash('sha256')
    .update('group-chat-invite-v1\0', 'utf8')
    .update(value, 'utf8')
    .digest()
}

export function groupChatInviteCodeMatches(
  requestedInviteCode: string | null | undefined,
  storedInviteCode: string | null | undefined,
): boolean {
  if (
    typeof requestedInviteCode !== 'string' ||
    requestedInviteCode.length === 0 ||
    typeof storedInviteCode !== 'string' ||
    storedInviteCode.length === 0
  ) {
    return false
  }
  return timingSafeEqual(inviteDigest(requestedInviteCode), inviteDigest(storedInviteCode))
}

function toPositiveInteger(value: number): number | null {
  return Number.isInteger(value) && value > 0 ? value : null
}

function groupChatDecision(
  roomId: string,
  roomExists: boolean,
  roomAuthorizationRevision: number,
  actor: GroupActor | null,
  capabilities: readonly string[],
): GroupChatAccessDecision {
  const flags = groupChatCapabilityFlags(capabilities)
  return {
    roomId,
    roomExists,
    canDiscover: flags.canRead,
    canJoin: flags.canRead,
    canInvokeAgent: flags.canInvokeAgents,
    canRespondApproval: flags.canApprove,
    actorId: actor?.id ?? null,
    actorType: actor?.actorType ?? null,
    actorAuthorizationRevision: revisionNumber(actor?.authorizationRevision),
    actorContextRevision: revisionNumber(actor?.contextRevision),
    roomAuthorizationRevision,
    ...flags,
  }
}

function actorCapabilities(storage: GroupChatAccessStore, actor: GroupActor | null): GroupChatCapability[] {
  if (!actor || typeof storage.getActorCapabilities !== 'function') {
    return []
  }
  return normalizeGroupChatCapabilities(storage.getActorCapabilities(actor.id))
}

function profileList(user: GroupChatAuthenticatedUserLike | null | undefined): string[] {
  return Array.isArray(user?.profiles) ? user.profiles.map(String).filter(Boolean) : []
}

function isRoomOwner(room: GroupChatRoomRecord, authUserId: number): boolean {
  const ownerAuthUserId = toPositiveInteger(Number(room.ownerAuthUserId ?? 0))
  return ownerAuthUserId !== null && ownerAuthUserId === authUserId
}

function findActorForSubject(
  storage: GroupChatAccessStore,
  roomId: string,
  subject: GroupChatSubject,
): GroupActor | null {
  if (subject.kind === 'authenticated_human') {
    return typeof storage.findActiveActorByAuthUserId === 'function' && subject.authUserId !== null
      ? storage.findActiveActorByAuthUserId(roomId, subject.authUserId)
      : null
  }
  if (subject.kind === 'agent') {
    return typeof storage.findActiveActorByAgentIdentity === 'function'
      ? storage.findActiveActorByAgentIdentity(roomId, subject.agentId)
      : null
  }
  if (subject.kind === 'local') {
    return typeof storage.findActiveActorByLocalSubjectId === 'function'
      ? storage.findActiveActorByLocalSubjectId(roomId, subject.localSubjectId)
      : null
  }
  return typeof storage.findActiveActorBySystemKey === 'function'
    ? storage.findActiveActorBySystemKey(roomId, subject.systemKey)
    : null
}

export function createAuthenticatedGroupChatSubject(
  user: GroupChatAuthenticatedUserLike | null | undefined,
): GroupChatSubject | null {
  const authUserId = toPositiveInteger(Number(user?.id))
  const role = String(user?.role ?? '')
  if (authUserId === null && role !== 'super_admin') {
    return null
  }
  return {
    kind: 'authenticated_human',
    authUserId,
    role,
    profiles: profileList(user),
  }
}

export function createAgentGroupChatSubject(agentId: string): GroupChatSubject {
  return {
    kind: 'agent',
    agentId: String(agentId || ''),
  }
}

export function createLocalGroupChatSubject(localSubjectId: string): GroupChatSubject {
  return {
    kind: 'local',
    localSubjectId: String(localSubjectId || ''),
  }
}

export function createSystemGroupChatSubject(systemKey = 'room-system'): GroupChatSubject {
  return {
    kind: 'system',
    systemKey: String(systemKey || 'room-system'),
  }
}

export function groupChatUserProfiles(user: GroupChatAuthenticatedUserLike | null | undefined): string[] {
  return profileList(user)
}

export function decideGroupChatAccessPolicy(input: GroupChatAccessPolicyInput): GroupChatAccessDecision {
  const { roomId, room, subject, actor, storedCapabilities, hasMembership } = input
  const roomAuthorizationRevision = revisionNumber(room?.authorizationRevision)

  if (!room) {
    return groupChatDecision(roomId, false, roomAuthorizationRevision, actor, [])
  }

  if (subject.kind === 'authenticated_human') {
    if (
      subject.role === 'super_admin' ||
      (subject.authUserId !== null && isRoomOwner(room, subject.authUserId))
    ) {
      return groupChatDecision(
        roomId,
        true,
        roomAuthorizationRevision,
        actor,
        SUPPORTED_GROUP_CHAT_CAPABILITIES,
      )
    }
    const effectiveCapabilities = hasMembership
      ? normalizeGroupChatCapabilities([...storedCapabilities, 'room.read'])
      : storedCapabilities
    return groupChatDecision(roomId, true, roomAuthorizationRevision, actor, effectiveCapabilities)
  }

  return groupChatDecision(
    roomId,
    true,
    roomAuthorizationRevision,
    actor,
    actor ? storedCapabilities : [],
  )
}

export function evaluateGroupChatAccessPolicy(
  storage: GroupChatAccessStore,
  roomId: string,
  subject: GroupChatSubject,
): GroupChatAccessDecision {
  const room = typeof storage.getRoom === 'function' ? storage.getRoom(roomId) ?? null : null
  const actor = findActorForSubject(storage, roomId, subject)
  const storedCapabilities = actorCapabilities(storage, actor)
  const hasMembership = subject.kind === 'authenticated_human'
    && subject.authUserId !== null
    && typeof storage.getMemberByAuthUserId === 'function'
    ? Boolean(storage.getMemberByAuthUserId(roomId, subject.authUserId))
    : false

  return decideGroupChatAccessPolicy({
    roomId,
    room,
    subject,
    actor,
    storedCapabilities,
    hasMembership,
  })
}

export function canAuthenticatedUserAccessRoom(
  storage: GroupChatAccessStore,
  roomId: string,
  user: GroupChatAuthenticatedUserLike,
  inviteCode?: string,
): boolean {
  const room = typeof storage.getRoom === 'function' ? storage.getRoom(roomId) ?? null : null
  if (!room) {
    return false
  }
  if (groupChatInviteCodeMatches(inviteCode, room.inviteCode)) {
    return true
  }
  const subject = createAuthenticatedGroupChatSubject(user)
  if (!subject) {
    return false
  }
  return evaluateGroupChatAccessPolicy(storage, roomId, subject).canRead
}

export function canLocalSubjectAccessRoom(
  storage: GroupChatAccessStore,
  roomId: string,
  localSubjectId: string,
  inviteCode?: string,
): boolean {
  const room = typeof storage.getRoom === 'function' ? storage.getRoom(roomId) ?? null : null
  if (!room) {
    return false
  }
  if (!room.inviteCode || groupChatInviteCodeMatches(inviteCode, room.inviteCode)) {
    return true
  }
  return evaluateGroupChatAccessPolicy(
    storage,
    roomId,
    createLocalGroupChatSubject(localSubjectId),
  ).canRead
}
