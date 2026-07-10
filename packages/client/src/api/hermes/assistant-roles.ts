import { request } from '@/api/client'

export const TWIN_DOMAINS = [
  'body', 'health', 'fitness', 'nutrition', 'home', 'life', 'work', 'entertainment', 'commerce', 'digital',
] as const
export type TwinDomain = typeof TWIN_DOMAINS[number]

export const TWIN_CONTEXT_SECTIONS = [
  'subject', 'observations', 'events', 'goals', 'constraints', 'entities', 'relations',
] as const
export type TwinContextSection = typeof TWIN_CONTEXT_SECTIONS[number]
export type TwinConfirmationState = 'observed' | 'reported' | 'confirmed' | 'inferred'

export interface AssistantRoleDataScope {
  domains: TwinDomain[]
  sections: TwinContextSection[]
  includeProvenance: boolean
}

export interface AssistantRoleCapabilityScope {
  allow: string[]
  deny: string[]
  enforcement: 'declarative_phase_2'
}

export interface AssistantRole {
  id: string
  name: string
  description: string
  persona: string
  builtIn: boolean
  enabled: boolean
  dataScope: AssistantRoleDataScope
  capabilityScope: AssistantRoleCapabilityScope
  decisionAuthority: Record<string, unknown>
  spendingLimits: Record<string, unknown>
  memoryNamespace: string
  escalationRules: Array<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

export interface AssistantRoleInput {
  id?: string
  name: string
  description?: string
  persona: string
  enabled?: boolean
  dataScope: AssistantRoleDataScope
  capabilityScope: AssistantRoleCapabilityScope
  decisionAuthority?: Record<string, unknown>
  spendingLimits?: Record<string, unknown>
  memoryNamespace: string
  escalationRules?: Array<Record<string, unknown>>
}

export type AssistantRolePatch = Partial<Omit<AssistantRoleInput, 'id'>>

export interface AssistantRoleProfileMapping {
  roleId: string
  profileName: string
  isPrimary: boolean
  createdAt: string
  updatedAt: string
}

export interface ContextRecipeLimits {
  perSection: number
  totalCharacters: number
}

export interface ContextRecipe {
  id: string
  roleId: string
  name: string
  description: string
  builtIn: boolean
  enabled: boolean
  domains: TwinDomain[]
  sections: TwinContextSection[]
  queryTemplate: string
  limits: ContextRecipeLimits
  createdAt: string
  updatedAt: string
}

export interface ContextRecipeInput {
  id?: string
  name: string
  description?: string
  enabled?: boolean
  domains: TwinDomain[]
  sections: TwinContextSection[]
  queryTemplate?: string
  limits: ContextRecipeLimits
}

export type ContextRecipePatch = Partial<Omit<ContextRecipeInput, 'id'>>

export interface AssistantRoleSummary extends AssistantRole {
  profileMappings: AssistantRoleProfileMapping[]
  primaryProfileName: string | null
  mappingStale: boolean
  recipeCount: number
}

export interface AssistantRoleDetail extends AssistantRoleSummary {
  recipes: ContextRecipe[]
}

export interface RoleContextOptions {
  query?: string
  recipeId?: string
}

export interface RoleContextProvenance {
  recordId: string
  source: string
  sourceId: string
  actor?: string
  confirmationState?: TwinConfirmationState
  confidence?: number
}

export type RoleContextSections = Record<TwinContextSection, Array<Record<string, unknown>>>

export interface RoleContextBundle {
  role: AssistantRole
  profileMapping: { profileName: string | null; stale: boolean }
  recipe: Pick<ContextRecipe, 'id' | 'name'> | null
  generatedAt: string
  query: string
  appliedScope: AssistantRoleDataScope
  appliedLimits: ContextRecipeLimits
  sections: RoleContextSections
  sourceRecordIds: Partial<Record<TwinContextSection, string[]>>
  provenance: Partial<Record<TwinContextSection, RoleContextProvenance[]>>
  truncated: { total: boolean; sections: Partial<Record<TwinContextSection, boolean>> }
  renderedInstructions: string
}

export interface CloneAssistantRoleInput {
  id?: string
  name: string
}

function rolePath(id: string): string {
  return `/api/hermes/assistant-roles/${encodeURIComponent(id)}`
}

export async function fetchAssistantRoles(): Promise<AssistantRoleSummary[]> {
  const response = await request<{ roles: AssistantRoleSummary[] }>('/api/hermes/assistant-roles')
  return response.roles
}

export async function fetchAssistantRole(id: string): Promise<AssistantRoleDetail> {
  const response = await request<{ role: AssistantRoleSummary; recipes: ContextRecipe[] }>(rolePath(id))
  return { ...response.role, recipes: response.recipes }
}

export async function createAssistantRole(input: AssistantRoleInput): Promise<AssistantRole> {
  const response = await request<{ role: AssistantRole }>('/api/hermes/assistant-roles', {
    method: 'POST', body: JSON.stringify(input),
  })
  return response.role
}

export async function updateAssistantRole(id: string, patch: AssistantRolePatch): Promise<AssistantRole> {
  const response = await request<{ role: AssistantRole }>(rolePath(id), {
    method: 'PUT', body: JSON.stringify(patch),
  })
  return response.role
}

export async function deleteAssistantRole(id: string): Promise<void> {
  await request<{ success: true }>(rolePath(id), { method: 'DELETE' })
}

export async function cloneAssistantRole(id: string, input: CloneAssistantRoleInput): Promise<AssistantRole> {
  const response = await request<{ role: AssistantRole }>(`${rolePath(id)}/clone`, {
    method: 'POST', body: JSON.stringify(input),
  })
  return response.role
}

export async function updateAssistantRoleProfileMapping(
  id: string,
  profileName: string | null,
): Promise<AssistantRoleProfileMapping | null> {
  const response = await request<{ mapping: AssistantRoleProfileMapping | null }>(`${rolePath(id)}/profile-mapping`, {
    method: 'PUT', body: JSON.stringify({ profileName }),
  })
  return response.mapping
}

export async function previewAssistantRoleContext(id: string, input: RoleContextOptions): Promise<RoleContextBundle> {
  const response = await request<{ context: RoleContextBundle }>(`${rolePath(id)}/context/preview`, {
    method: 'POST', body: JSON.stringify(input),
  })
  return response.context
}

function recipesPath(roleId: string): string { return `${rolePath(roleId)}/context-recipes` }

export async function fetchContextRecipes(roleId: string): Promise<ContextRecipe[]> {
  const response = await request<{ recipes: ContextRecipe[] }>(recipesPath(roleId))
  return response.recipes
}

export async function createContextRecipe(roleId: string, input: ContextRecipeInput): Promise<ContextRecipe> {
  const response = await request<{ recipe: ContextRecipe }>(recipesPath(roleId), { method: 'POST', body: JSON.stringify(input) })
  return response.recipe
}

export async function updateContextRecipe(roleId: string, recipeId: string, patch: ContextRecipePatch): Promise<ContextRecipe> {
  const response = await request<{ recipe: ContextRecipe }>(`${recipesPath(roleId)}/${encodeURIComponent(recipeId)}`, { method: 'PUT', body: JSON.stringify(patch) })
  return response.recipe
}

export async function deleteContextRecipe(roleId: string, recipeId: string): Promise<void> {
  await request<{ success: true }>(`${recipesPath(roleId)}/${encodeURIComponent(recipeId)}`, { method: 'DELETE' })
}
