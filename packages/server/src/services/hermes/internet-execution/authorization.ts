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
  const capabilityScope = {
    allow: INTERNET_CAPABILITY_IDS,
    deny: [],
    enforcement: 'action_fabric_v1' as const,
  }
  const decisionAuthority = {
    maxRisk: 'low' as const,
    requireApprovalAbove: 'low' as const,
    allowedTargets,
  }
  const current = getAssistantRole(ENTERTAINMENT_ASSISTANT_ROLE_ID)
  if (!current || !isDeepStrictEqual(current.capabilityScope, capabilityScope)
    || !isDeepStrictEqual(current.decisionAuthority, decisionAuthority)) {
    updateAssistantRole(ENTERTAINMENT_ASSISTANT_ROLE_ID, { capabilityScope, decisionAuthority })
  }
}
