import { isDeepStrictEqual } from 'node:util'
import { ensureBuiltInAssistantRoles, getAssistantRole, updateAssistantRole } from '../personal-twin'
import { isLifeCurrency, isLifeDigest, isLifeExecutionMode, isLifeSemanticId,
  isLifeSourceKind, LifeContractError } from './contracts'
import {
  LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
  LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
  LIFE_PLAN_VERIFY_CAPABILITY,
  LIFE_SOURCE_SYNC_CAPABILITY,
  LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
} from './fabric-contracts'
import type { LifeExecutionMode, LifeSourceKind } from './types'

export const LIFE_ASSISTANT_ROLE_ID = 'entertainment-assistant'

export interface LifeAuthorizationBinding {
  accountId: string
  sourceKind: LifeSourceKind
  mode: LifeExecutionMode
  currency: string
  calendarIds: string[]
  subscriptionIds: string[]
  planDigests: string[]
}

export function refreshLifeAssistantAuthorizations(inputs: LifeAuthorizationBinding[]): string[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 30) {
    throw new LifeContractError('LIFE_AUTHORIZATION_INPUT_INVALID')
  }
  const capabilities = new Set<string>([LIFE_SOURCE_SYNC_CAPABILITY, LIFE_PLAN_VERIFY_CAPABILITY])
  const targets = new Set<string>()
  let transactional = false
  for (const input of inputs) {
    if (!isLifeSemanticId(input.accountId) || !isLifeSourceKind(input.sourceKind)
      || !isLifeExecutionMode(input.mode) || !isLifeCurrency(input.currency)) {
      throw new LifeContractError('LIFE_AUTHORIZATION_INPUT_INVALID')
    }
    const calendarIds = uniqueSorted(input.calendarIds, isLifeSemanticId)
    const subscriptionIds = uniqueSorted(input.subscriptionIds, isLifeSemanticId)
    const planDigests = uniqueSorted(input.planDigests, isLifeDigest)
    targets.add(`life:account:${input.accountId}`)
    targets.add(`life:source:${input.sourceKind}`)
    targets.add(`life:currency:${input.currency}`)
    calendarIds.forEach(id => targets.add(`life:calendar:${id}`))
    subscriptionIds.forEach(id => targets.add(`life:subscription:${id}`))
    planDigests.forEach(value => targets.add(`life:plan:${value}`))
    if (input.mode !== 'observe' && input.sourceKind === 'calendar') {
      transactional = true
      capabilities.add(LIFE_CALENDAR_HOLD_CREATE_CAPABILITY)
      capabilities.add(LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY)
    }
    if (input.mode !== 'observe' && input.sourceKind === 'subscriptions') {
      transactional = true
      capabilities.add(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY)
    }
  }
  updateAuthorization([...capabilities].sort(compare), [...targets].sort(compare), transactional)
  return [...targets].sort(compare)
}

export function clearLifeAssistantAuthorization(): void {
  updateAuthorization([], [], false)
}

function updateAuthorization(lifeCapabilities: string[], lifeTargets: string[], transactional: boolean): void {
  ensureBuiltInAssistantRoles()
  const current = getAssistantRole(LIFE_ASSISTANT_ROLE_ID)
  if (!current) throw new LifeContractError('LIFE_ASSISTANT_ROLE_MISSING')
  const otherCapabilities = current.capabilityScope.allow.filter(id => !id.startsWith('life.'))
  const otherDenied = current.capabilityScope.deny.filter(id => !id.startsWith('life.'))
  const otherTargets = (current.decisionAuthority.allowedTargets ?? []).filter(value => !value.startsWith('life:'))
  const allow = [...new Set([...otherCapabilities, ...lifeCapabilities])].sort(compare)
  const allowedTargets = [...new Set([...otherTargets, ...lifeTargets])].sort(compare)
  const hasLife = lifeCapabilities.length > 0
  const hasOther = otherCapabilities.some(id => id !== 'twin.read')
  const deny = hasLife || hasOther ? otherDenied.filter(id => id !== 'action.execute')
    : [...new Set([...otherDenied, 'action.execute'])].sort(compare)
  const capabilityScope = { allow, deny, enforcement: 'action_fabric_v1' as const }
  const decisionAuthority = {
    maxRisk: transactional ? 'high' as const : hasLife || hasOther ? 'low' as const : 'none' as const,
    requireApprovalAbove: hasLife || hasOther ? 'low' as const : 'none' as const,
    allowedTargets,
  }
  if (!isDeepStrictEqual(current.capabilityScope, capabilityScope)
    || !isDeepStrictEqual(current.decisionAuthority, decisionAuthority)) {
    updateAssistantRole(LIFE_ASSISTANT_ROLE_ID, { capabilityScope, decisionAuthority })
  }
}

function uniqueSorted(values: string[], valid: (value: unknown) => boolean): string[] {
  if (!Array.isArray(values) || values.length > 64 || values.some(value => !valid(value))) {
    throw new LifeContractError('LIFE_AUTHORIZATION_INPUT_INVALID')
  }
  const result = [...values].sort(compare)
  if (result.some((value, index) => index > 0 && value === result[index - 1])) {
    throw new LifeContractError('LIFE_AUTHORIZATION_INPUT_INVALID')
  }
  return result
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
