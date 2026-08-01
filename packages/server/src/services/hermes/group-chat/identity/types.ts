export const GROUP_CHAT_IDENTITY_READER_EPOCH = 1 as const

export type GroupActorType = 'authenticated_human' | 'agent' | 'local' | 'system'

export interface GroupActor {
  id: string
  roomId: string
  actorType: GroupActorType
  authUserId: number | null
  agentId: string | null
  localSubjectId: string | null
  systemKey: string | null
  name: string
  description: string
  avatar: string
  active: 0 | 1
  authorizationRevision: number
  contextRevision: number
  tombstonedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface GroupActorRevisions {
  actorId: string | null
  roomAuthorizationRevision: number
  actorAuthorizationRevision: number
  actorContextRevision: number
}

export interface EnsureAuthenticatedHumanActorInput {
  roomId: string
  authUserId: number
  userName: string
  description: string
  avatar: string
  capabilities?: readonly string[]
  preserveAuthorizationRevisionOnLegacyRepair?: boolean
}

export interface EnsureLocalActorInput {
  roomId: string
  localSubjectId: string
  userName: string
  description: string
  avatar: string
  grantDefaultCapabilities?: boolean
}

export interface EnsureAgentActorInput {
  roomId: string
  agentId: string
  name: string
  description: string
}

export interface EnsureSystemActorInput {
  roomId: string
  systemKey?: string
}

export interface GroupActorMetadata {
  name: string
  description: string
  avatar: string
}

function requireIdentifier(value: string, fieldName: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`${fieldName} is required`)
  }
  return normalized
}

function requirePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`)
  }
  return value
}

function normalizeMetadata(name: string, description: string, avatar: string): GroupActorMetadata {
  return {
    name: name.trim(),
    description: description.trim(),
    avatar: avatar.trim(),
  }
}

export function revisionNumber(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0
}

export function verifyAuthenticatedHumanActorInput(
  input: EnsureAuthenticatedHumanActorInput,
): EnsureAuthenticatedHumanActorInput {
  const metadata = normalizeMetadata(input.userName, input.description, input.avatar)
  return {
    roomId: requireIdentifier(input.roomId, 'roomId'),
    authUserId: requirePositiveInteger(input.authUserId, 'authUserId'),
    userName: metadata.name,
    description: metadata.description,
    avatar: metadata.avatar,
    capabilities: input.capabilities ?? [],
  }
}

export function verifyLocalActorInput(input: EnsureLocalActorInput): EnsureLocalActorInput {
  const metadata = normalizeMetadata(input.userName, input.description, input.avatar)
  return {
    roomId: requireIdentifier(input.roomId, 'roomId'),
    localSubjectId: requireIdentifier(input.localSubjectId, 'localSubjectId'),
    userName: metadata.name,
    description: metadata.description,
    avatar: metadata.avatar,
    grantDefaultCapabilities: input.grantDefaultCapabilities === true,
  }
}

export function verifyAgentActorInput(input: EnsureAgentActorInput): EnsureAgentActorInput {
  const metadata = normalizeMetadata(input.name, input.description, '')
  return {
    roomId: requireIdentifier(input.roomId, 'roomId'),
    agentId: requireIdentifier(input.agentId, 'agentId'),
    name: metadata.name,
    description: metadata.description,
  }
}

export function verifySystemActorInput(input: EnsureSystemActorInput): EnsureSystemActorInput {
  return {
    roomId: requireIdentifier(input.roomId, 'roomId'),
    systemKey: requireIdentifier(input.systemKey ?? 'room-system', 'systemKey'),
  }
}
