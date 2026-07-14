import { isDeepStrictEqual } from 'node:util'
import { ensureBuiltInAssistantRoles, getAssistantRole, updateAssistantRole } from '../personal-twin/assistant-roles'
import { assertHomeCapabilityBindingAllowed, HOME_FABRIC_CAPABILITIES } from './fabric-contracts'
import { HomeTwinStore } from './store'
import type { HomeDeviceBinding } from './types'

export const HOME_MANAGER_ROLE_ID = 'home-manager'
export const HOME_ASSISTANT_PROVIDER = 'home-assistant'

const HOME_CAPABILITY_IDS = HOME_FABRIC_CAPABILITIES.map(capability => capability.id).sort()

/** Refreshes the exact literal Home targets without rewriting an unchanged role snapshot. */
export function refreshHomeManagerAuthorization(store: HomeTwinStore): string[] {
  ensureBuiltInAssistantRoles()
  const allowedTargets = authorizedHomeTargets(store)
  if (allowedTargets.length > 64) throw new Error('HOME_RUNTIME_AUTHORIZATION_TARGET_LIMIT')
  const capabilityScope = { allow: HOME_CAPABILITY_IDS, deny: [], enforcement: 'action_fabric_v1' as const }
  const decisionAuthority = { maxRisk: 'medium' as const, requireApprovalAbove: 'low' as const, allowedTargets }
  const current = getAssistantRole(HOME_MANAGER_ROLE_ID)
  if (!current || !isDeepStrictEqual(current.capabilityScope, capabilityScope)
    || !isDeepStrictEqual(current.decisionAuthority, decisionAuthority)) {
    updateAssistantRole(HOME_MANAGER_ROLE_ID, { capabilityScope, decisionAuthority })
  }
  return allowedTargets
}

export function clearHomeManagerAuthorization(): void {
  ensureBuiltInAssistantRoles()
  const capabilityScope = { allow: HOME_CAPABILITY_IDS, deny: [], enforcement: 'action_fabric_v1' as const }
  const decisionAuthority = { maxRisk: 'medium' as const, requireApprovalAbove: 'low' as const, allowedTargets: [] }
  const current = getAssistantRole(HOME_MANAGER_ROLE_ID)
  if (!current || !isDeepStrictEqual(current.capabilityScope, capabilityScope)
    || !isDeepStrictEqual(current.decisionAuthority, decisionAuthority)) {
    updateAssistantRole(HOME_MANAGER_ROLE_ID, { capabilityScope, decisionAuthority })
  }
}

function authorizedHomeTargets(store: HomeTwinStore): string[] {
  const targets = new Set<string>()
  for (const binding of store.listBindings({ provider: HOME_ASSISTANT_PROVIDER, limit: 500 })) {
    const capabilities = governedCapabilities(binding)
    if (capabilities.length === 0) continue
    targets.add(`home:provider:${HOME_ASSISTANT_PROVIDER}`)
    targets.add(`home:binding:${HOME_ASSISTANT_PROVIDER}:${binding.externalId}`)
    if (capabilities.some(capability => capability.startsWith('home.device.'))) {
      targets.add(`home:device:${binding.deviceId}`)
    }
    if (capabilities.includes('home.scene.activate.safe')) targets.add(`home:scene:${binding.deviceId}`)
  }
  return [...targets].sort()
}

function governedCapabilities(binding: HomeDeviceBinding): string[] {
  const candidates = ['home.device.refresh']
  if (binding.capabilities.includes('power')) candidates.push('home.device.set_power')
  if (binding.capabilities.includes('level')) candidates.push('home.device.set_level')
  if (binding.capabilities.includes('temperature')) candidates.push('home.device.set_temperature')
  if (binding.metadata.safeScene === true) candidates.push('home.scene.activate.safe')
  return candidates.filter(capabilityId => {
    try {
      assertHomeCapabilityBindingAllowed(capabilityId, binding.externalId, binding.metadata)
      return true
    } catch {
      return false
    }
  })
}
