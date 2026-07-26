import { createHash, randomUUID } from 'node:crypto'

import type { GroupActorType } from './types'

type GroupActorIdentitySeed = {
  roomId: string
  actorType: GroupActorType
  authUserId?: number | null
  agentId?: string | null
  localSubjectId?: string | null
  systemKey?: string | null
  stableSourceKey: string
}

function sha256Hex(parts: ReadonlyArray<string | number>): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(part))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function authoritativeIdentity(seed: GroupActorIdentitySeed): string {
  if (seed.actorType === 'authenticated_human') {
    return `auth:${seed.authUserId ?? ''}`
  }
  if (seed.actorType === 'agent') {
    return `agent:${seed.agentId ?? ''}`
  }
  if (seed.actorType === 'local') {
    return `local:${seed.localSubjectId ?? ''}`
  }
  return `system:${seed.systemKey ?? ''}`
}

export function createGroupActorId(): string {
  return `gca_${randomUUID()}`
}

export function createGroupActorCapabilityId(): string {
  return `gcac_${randomUUID()}`
}

export function createDeterministicGroupActorId(seed: GroupActorIdentitySeed): string {
  return `gca_${sha256Hex([
    'group-chat-identity-v1',
    seed.roomId,
    seed.actorType,
    authoritativeIdentity(seed),
    seed.stableSourceKey,
  ]).slice(0, 32)}`
}

export function createDeterministicGroupActorCapabilityId(
  roomId: string,
  actorId: string,
  capability: string,
): string {
  return `gcac_${sha256Hex([
    'group-chat-capability-v1',
    roomId,
    actorId,
    capability,
  ]).slice(0, 32)}`
}

export function createDeterministicLocalSubjectId(roomId: string, stableSourceKey: string): string {
  return `local:${sha256Hex([
    'group-chat-local-subject-v1',
    roomId,
    stableSourceKey,
  ]).slice(0, 32)}`
}
