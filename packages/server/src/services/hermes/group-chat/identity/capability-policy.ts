export const SUPPORTED_GROUP_CHAT_CAPABILITIES = [
  'room.read',
  'room.write',
  'room.type',
  'room.manage',
  'agent.invoke',
  'approval.respond',
] as const

export type GroupChatCapability = (typeof SUPPORTED_GROUP_CHAT_CAPABILITIES)[number]

export interface GroupChatCapabilityDecision {
  capabilities: GroupChatCapability[]
  canRead: boolean
  canWrite: boolean
  canType: boolean
  canManage: boolean
  canInvokeAgents: boolean
  canApprove: boolean
  isReadOnly: boolean
}

const SUPPORTED_GROUP_CHAT_CAPABILITY_SET = new Set<string>(SUPPORTED_GROUP_CHAT_CAPABILITIES)

export const READ_ONLY_GROUP_CHAT_CAPABILITIES: readonly GroupChatCapability[] = [
  'room.read',
]

export const AGENT_GROUP_CHAT_CAPABILITIES: readonly GroupChatCapability[] = [
  'room.read',
  'room.write',
  'room.type',
  'agent.invoke',
]

export const LOCAL_GROUP_CHAT_CAPABILITIES: readonly GroupChatCapability[] = [
  'room.read',
  'room.write',
  'room.type',
  'room.manage',
  'agent.invoke',
  'approval.respond',
]

export const SYSTEM_GROUP_CHAT_CAPABILITIES: readonly GroupChatCapability[] = AGENT_GROUP_CHAT_CAPABILITIES

export function isSupportedGroupChatCapability(value: unknown): value is GroupChatCapability {
  return typeof value === 'string' && SUPPORTED_GROUP_CHAT_CAPABILITY_SET.has(value)
}

export function normalizeGroupChatCapabilities(capabilities: Iterable<unknown>): GroupChatCapability[] {
  const selected = new Set<GroupChatCapability>()
  for (const capability of capabilities) {
    if (isSupportedGroupChatCapability(capability)) {
      selected.add(capability)
    }
  }
  return SUPPORTED_GROUP_CHAT_CAPABILITIES.filter((capability) => selected.has(capability))
}

export function groupChatCapabilityFlags(capabilities: Iterable<unknown>): GroupChatCapabilityDecision {
  const normalized = normalizeGroupChatCapabilities(capabilities)
  const granted = new Set(normalized)
  const canRead = granted.has('room.read')
  const canWrite = granted.has('room.write')
  const canType = granted.has('room.type')
  const canManage = granted.has('room.manage')
  const canInvokeAgents = granted.has('agent.invoke')
  const canApprove = granted.has('approval.respond')

  return {
    capabilities: normalized,
    canRead,
    canWrite,
    canType,
    canManage,
    canInvokeAgents,
    canApprove,
    isReadOnly: canRead && !canWrite && !canType && !canManage && !canInvokeAgents && !canApprove,
  }
}
