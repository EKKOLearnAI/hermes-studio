import { isDeepStrictEqual } from 'node:util'
import { ensureBuiltInAssistantRoles, getAssistantRole, updateAssistantRole } from '../personal-twin/assistant-roles'
import {
  BILIBILI_INSPECT_CAPABILITY,
  BILIBILI_ORIGIN,
  BILIBILI_PROVIDER,
  BILIBILI_SEARCH_CAPABILITY,
} from './fabric-contracts'

export const ENTERTAINMENT_ASSISTANT_ROLE_ID = 'entertainment-assistant'

const INTERNET_CAPABILITY_IDS = [BILIBILI_INSPECT_CAPABILITY, BILIBILI_SEARCH_CAPABILITY].sort()

export function refreshEntertainmentInternetAuthorization(profile: string): string[] {
  const allowedTargets = [
    `internet:origin:${BILIBILI_ORIGIN}`,
    `internet:profile:${profile}`,
    `internet:provider:${BILIBILI_PROVIDER}`,
  ].sort()
  updateAuthorization(allowedTargets)
  return allowedTargets
}

export function clearEntertainmentInternetAuthorization(): void {
  updateAuthorization([])
}

function updateAuthorization(allowedTargets: string[]): void {
  ensureBuiltInAssistantRoles()
  const current = getAssistantRole(ENTERTAINMENT_ASSISTANT_ROLE_ID)
  const lifeCapabilities = current?.capabilityScope.allow.filter(id => id.startsWith('life.')) ?? []
  const lifeTargets = current?.decisionAuthority.allowedTargets?.filter(target => target.startsWith('life:')) ?? []
  const lifeTransactional = lifeCapabilities.some(id => id === 'life.calendar.hold.create'
    || id === 'life.calendar.hold.cancel' || id === 'life.subscription.cancel')
  const capabilityScope = {
    allow: [...new Set([...INTERNET_CAPABILITY_IDS, ...lifeCapabilities])].sort(),
    deny: [],
    enforcement: 'action_fabric_v1' as const,
  }
  const decisionAuthority = {
    maxRisk: lifeTransactional ? 'high' as const : 'low' as const,
    requireApprovalAbove: 'low' as const,
    allowedTargets: [...new Set([...allowedTargets, ...lifeTargets])].sort(),
  }
  if (!current || !isDeepStrictEqual(current.capabilityScope, capabilityScope)
    || !isDeepStrictEqual(current.decisionAuthority, decisionAuthority)) {
    updateAssistantRole(ENTERTAINMENT_ASSISTANT_ROLE_ID, { capabilityScope, decisionAuthority })
  }
}
