import { isDeepStrictEqual } from 'node:util'
import { ensureBuiltInAssistantRoles, getAssistantRole, updateAssistantRole } from '../personal-twin'
import { CommerceContractError, isCommerceCurrency, isCommerceDigest, isCommerceProviderKind, isCommerceSemanticId } from './contracts'
import {
  COMMERCE_CAPABILITY_IDS,
  COMMERCE_CART_CAPABILITY,
  COMMERCE_COMPARE_CAPABILITY,
  COMMERCE_SEARCH_CAPABILITY,
} from './fabric-contracts'
import type { CommerceExecutionMode, CommerceProviderKind } from './types'

export const COMMERCE_ASSISTANT_ROLE_ID = 'commerce-assistant'

export function refreshCommerceAssistantAuthorization(input: {
  accountId: string
  provider: CommerceProviderKind
  currency: string
  mode: CommerceExecutionMode
  merchantIds?: string[]
  destinationDigests?: string[]
}): string[] {
  if (!isCommerceSemanticId(input.accountId) || !isCommerceProviderKind(input.provider) || input.provider === 'virtual'
    || !isCommerceCurrency(input.currency) || !['observe', 'shadow'].includes(input.mode)) {
    throw new CommerceContractError('COMMERCE_AUTHORIZATION_INPUT_INVALID')
  }
  const merchantIds = uniqueSorted(input.merchantIds ?? [], value => isCommerceSemanticId(value))
  const destinationDigests = uniqueSorted(input.destinationDigests ?? [], value => isCommerceDigest(value))
  const allowedTargets = [
    `commerce:account:${input.accountId}`,
    `commerce:provider:${input.provider}`,
    `commerce:currency:${input.currency}`,
    ...merchantIds.map(id => `commerce:merchant:${id}`),
    ...destinationDigests.map(digest => `commerce:destination:${digest}`),
  ].sort(compareCodeUnits)
  const allow = input.mode === 'observe'
    ? [COMMERCE_SEARCH_CAPABILITY, COMMERCE_COMPARE_CAPABILITY, COMMERCE_CART_CAPABILITY].sort(compareCodeUnits)
    : [...COMMERCE_CAPABILITY_IDS].sort(compareCodeUnits)
  ensureBuiltInAssistantRoles()
  const role = getAssistantRole(COMMERCE_ASSISTANT_ROLE_ID)
  if (!role) throw new CommerceContractError('COMMERCE_ASSISTANT_ROLE_MISSING')
  const capabilityScope = { allow, deny: [], enforcement: 'action_fabric_v1' as const }
  const decisionAuthority = input.mode === 'observe'
    ? { maxRisk: 'low' as const, requireApprovalAbove: 'low' as const, allowedTargets }
    : { maxRisk: 'critical' as const, requireApprovalAbove: 'low' as const, allowedTargets }
  if (!isDeepStrictEqual(role.capabilityScope, capabilityScope)
    || !isDeepStrictEqual(role.decisionAuthority, decisionAuthority)) {
    updateAssistantRole(COMMERCE_ASSISTANT_ROLE_ID, { capabilityScope, decisionAuthority })
  }
  return allowedTargets
}

export function clearCommerceAssistantAuthorization(): void {
  ensureBuiltInAssistantRoles()
  const role = getAssistantRole(COMMERCE_ASSISTANT_ROLE_ID)
  if (!role) return
  const capabilityScope = { allow: ['twin.read'], deny: ['action.execute'], enforcement: 'action_fabric_v1' as const }
  const decisionAuthority = { maxRisk: 'none' as const, requireApprovalAbove: 'none' as const, allowedTargets: [] }
  if (!isDeepStrictEqual(role.capabilityScope, capabilityScope)
    || !isDeepStrictEqual(role.decisionAuthority, decisionAuthority)) {
    updateAssistantRole(COMMERCE_ASSISTANT_ROLE_ID, { capabilityScope, decisionAuthority })
  }
}

function uniqueSorted(values: string[], valid: (value: string) => boolean): string[] {
  if (!Array.isArray(values) || values.length > 30 || values.some(value => typeof value !== 'string' || !valid(value))) {
    throw new CommerceContractError('COMMERCE_AUTHORIZATION_INPUT_INVALID')
  }
  const result = [...values].sort(compareCodeUnits)
  if (result.some((value, index) => index > 0 && value === result[index - 1])) {
    throw new CommerceContractError('COMMERCE_AUTHORIZATION_INPUT_INVALID')
  }
  return result
}

function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
