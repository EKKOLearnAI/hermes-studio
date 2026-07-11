import type { Context } from 'koa'
import {
  TWIN_CONTEXT_SECTIONS,
  TWIN_DOMAINS,
  buildRoleContext,
  cloneAssistantRole,
  createContextRecipe,
  createAssistantRole,
  deleteAssistantRole,
  deleteContextRecipe,
  listAssistantRolesWithMappings,
  listContextRecipes,
  setAssistantRoleProfileMapping,
  updateContextRecipe,
  updateAssistantRole,
} from '../../services/hermes/personal-twin'
import type {
  AssistantRoleCapabilityScope,
  AssistantRoleDataScope,
  AssistantRoleDecisionAuthority,
  AssistantRoleInput,
  AssistantRolePatch,
  AssistantRoleSpendingLimits,
  ContextRecipeInput,
  ContextRecipePatch,
  RoleContextOptions,
} from '../../services/hermes/personal-twin'

class RequestValidationError extends Error {}

const ROLE_FIELDS = new Set([
  'id', 'name', 'description', 'persona', 'enabled', 'dataScope', 'capabilityScope',
  'decisionAuthority', 'spendingLimits', 'memoryNamespace', 'escalationRules',
])
const PATCH_FIELDS = new Set([...ROLE_FIELDS].filter(field => field !== 'id'))
const RECIPE_FIELDS = new Set(['id', 'name', 'description', 'enabled', 'domains', 'sections', 'queryTemplate', 'limits'])
const RECIPE_PATCH_FIELDS = new Set([...RECIPE_FIELDS].filter(field => field !== 'id'))

function bodyObject(ctx: Context): Record<string, unknown> {
  const body = (ctx.request as { body?: unknown }).body
  if (!isRecord(body)) throw new RequestValidationError('Request body must be a JSON object')
  return body
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyFields(body: Record<string, unknown>, allowed: Set<string>): void {
  const unexpected = Object.keys(body).find(key => !allowed.has(key))
  if (unexpected) throw new RequestValidationError(`Unexpected field: ${unexpected}`)
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || !value.trim()) throw new RequestValidationError(`${field} must be a non-empty string`)
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return undefined
  const value = body[field]
  if (typeof value !== 'string') throw new RequestValidationError(`${field} must be a string`)
  return value
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return undefined
  const value = body[field]
  if (typeof value !== 'boolean') throw new RequestValidationError(`${field} must be a boolean`)
  return value
}

function stringArray(value: unknown, field: string, allowed?: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new RequestValidationError(`${field} must be an array of non-empty strings`)
  }
  if (allowed) {
    const invalid = value.find(item => !allowed.includes(item))
    if (invalid !== undefined) throw new RequestValidationError(`${field} contains an unsupported value`)
  }
  return [...new Set(value)]
}

function dataScope(value: unknown): AssistantRoleDataScope {
  if (!isRecord(value)) throw new RequestValidationError('dataScope must be a JSON object')
  onlyFields(value, new Set(['domains', 'sections', 'includeProvenance']))
  if (typeof value.includeProvenance !== 'boolean') throw new RequestValidationError('dataScope.includeProvenance must be a boolean')
  return {
    domains: stringArray(value.domains, 'dataScope.domains', TWIN_DOMAINS) as AssistantRoleDataScope['domains'],
    sections: stringArray(value.sections, 'dataScope.sections', TWIN_CONTEXT_SECTIONS) as AssistantRoleDataScope['sections'],
    includeProvenance: value.includeProvenance,
  }
}

function capabilityScope(value: unknown): AssistantRoleCapabilityScope {
  if (!isRecord(value)) throw new RequestValidationError('capabilityScope must be a JSON object')
  onlyFields(value, new Set(['allow', 'deny', 'enforcement']))
  if (value.enforcement !== 'action_fabric_v1') {
    throw new RequestValidationError('capabilityScope.enforcement must be action_fabric_v1')
  }
  return {
    allow: stringArray(value.allow, 'capabilityScope.allow'),
    deny: stringArray(value.deny, 'capabilityScope.deny'),
    enforcement: value.enforcement,
  }
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RequestValidationError(`${field} must be a JSON object`)
  return value
}

const RISKS = ['none', 'low', 'medium', 'high', 'critical'] as const
function decisionAuthority(value: unknown): AssistantRoleDecisionAuthority {
  const authority = jsonObject(value, 'decisionAuthority')
  onlyFields(authority, new Set(['maxRisk', 'requireApprovalAbove', 'allowedTargets']))
  if (!RISKS.includes(authority.maxRisk as typeof RISKS[number])) throw new RequestValidationError('decisionAuthority.maxRisk is invalid')
  if (authority.requireApprovalAbove !== undefined
    && !RISKS.includes(authority.requireApprovalAbove as typeof RISKS[number])) {
    throw new RequestValidationError('decisionAuthority.requireApprovalAbove is invalid')
  }
  const targets = authority.allowedTargets === undefined ? undefined : stringArray(authority.allowedTargets, 'decisionAuthority.allowedTargets')
  if (targets?.some(target => target === '*')) throw new RequestValidationError('decisionAuthority.allowedTargets must be literal')
  return { maxRisk: authority.maxRisk as typeof RISKS[number],
    ...(authority.requireApprovalAbove === undefined ? {} : { requireApprovalAbove: authority.requireApprovalAbove as typeof RISKS[number] }),
    ...(targets === undefined ? {} : { allowedTargets: targets }) }
}

function spendingLimits(value: unknown): AssistantRoleSpendingLimits {
  const limits = jsonObject(value, 'spendingLimits')
  onlyFields(limits, new Set(['currency', 'perAction', 'daily']))
  if (!(limits.currency === null || (typeof limits.currency === 'string' && /^[A-Z]{3}$/.test(limits.currency)))) {
    throw new RequestValidationError('spendingLimits.currency is invalid')
  }
  if (!Number.isSafeInteger(limits.perAction) || (limits.perAction as number) < 0
    || !Number.isSafeInteger(limits.daily) || (limits.daily as number) < 0) {
    throw new RequestValidationError('spendingLimits values must be non-negative integer minor units')
  }
  return { currency: limits.currency as string | null, perAction: limits.perAction as number, daily: limits.daily as number }
}

function objectArray(value: unknown, field: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some(item => !isRecord(item))) {
    throw new RequestValidationError(`${field} must be an array of JSON objects`)
  }
  return value
}

function recipeLimits(value: unknown): { perSection: number; totalCharacters: number } {
  if (!isRecord(value)) throw new RequestValidationError('limits must be a JSON object')
  onlyFields(value, new Set(['perSection', 'totalCharacters']))
  if (!Number.isInteger(value.perSection) || (value.perSection as number) < 1 || (value.perSection as number) > 50) throw new RequestValidationError('limits.perSection must be an integer from 1 to 50')
  if (!Number.isInteger(value.totalCharacters) || (value.totalCharacters as number) < 1000 || (value.totalCharacters as number) > 40000) throw new RequestValidationError('limits.totalCharacters must be an integer from 1000 to 40000')
  return { perSection: value.perSection as number, totalCharacters: value.totalCharacters as number }
}

function parseRecipeCreate(ctx: Context): ContextRecipeInput {
  const body = bodyObject(ctx)
  onlyFields(body, RECIPE_FIELDS)
  const input: ContextRecipeInput = {
    name: requiredString(body, 'name'),
    domains: stringArray(body.domains, 'domains', TWIN_DOMAINS) as ContextRecipeInput['domains'],
    sections: stringArray(body.sections, 'sections', TWIN_CONTEXT_SECTIONS) as ContextRecipeInput['sections'],
    limits: recipeLimits(body.limits),
  }
  const id = optionalString(body, 'id'); if (id !== undefined) input.id = id
  const description = optionalString(body, 'description'); if (description !== undefined) input.description = description
  const enabled = optionalBoolean(body, 'enabled'); if (enabled !== undefined) input.enabled = enabled
  const queryTemplate = optionalString(body, 'queryTemplate'); if (queryTemplate !== undefined) input.queryTemplate = queryTemplate
  return input
}

function parseRecipePatch(ctx: Context): ContextRecipePatch {
  const body = bodyObject(ctx)
  onlyFields(body, RECIPE_PATCH_FIELDS)
  if (!Object.keys(body).length) throw new RequestValidationError('Recipe patch must not be empty')
  const patch: ContextRecipePatch = {}
  for (const field of ['name', 'description', 'queryTemplate'] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue
    patch[field] = field === 'name' ? requiredString(body, field) : optionalString(body, field)!
  }
  const enabled = optionalBoolean(body, 'enabled'); if (enabled !== undefined) patch.enabled = enabled
  if (Object.prototype.hasOwnProperty.call(body, 'domains')) patch.domains = stringArray(body.domains, 'domains', TWIN_DOMAINS) as ContextRecipePatch['domains']
  if (Object.prototype.hasOwnProperty.call(body, 'sections')) patch.sections = stringArray(body.sections, 'sections', TWIN_CONTEXT_SECTIONS) as ContextRecipePatch['sections']
  if (Object.prototype.hasOwnProperty.call(body, 'limits')) patch.limits = recipeLimits(body.limits)
  return patch
}

function parseCreate(ctx: Context): AssistantRoleInput {
  const body = bodyObject(ctx)
  onlyFields(body, ROLE_FIELDS)
  const input: AssistantRoleInput = {
    name: requiredString(body, 'name'),
    persona: requiredString(body, 'persona'),
    dataScope: dataScope(body.dataScope),
    capabilityScope: capabilityScope(body.capabilityScope),
    memoryNamespace: requiredString(body, 'memoryNamespace'),
  }
  const id = optionalString(body, 'id')
  const description = optionalString(body, 'description')
  const enabled = optionalBoolean(body, 'enabled')
  if (id !== undefined) input.id = id
  if (description !== undefined) input.description = description
  if (enabled !== undefined) input.enabled = enabled
  if (Object.prototype.hasOwnProperty.call(body, 'decisionAuthority')) input.decisionAuthority = decisionAuthority(body.decisionAuthority)
  if (Object.prototype.hasOwnProperty.call(body, 'spendingLimits')) input.spendingLimits = spendingLimits(body.spendingLimits)
  if (Object.prototype.hasOwnProperty.call(body, 'escalationRules')) input.escalationRules = objectArray(body.escalationRules, 'escalationRules')
  return input
}

function parsePatch(ctx: Context): AssistantRolePatch {
  const body = bodyObject(ctx)
  onlyFields(body, PATCH_FIELDS)
  const patch: AssistantRolePatch = {}
  for (const field of ['name', 'description', 'persona', 'memoryNamespace'] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue
    patch[field] = field === 'description' ? optionalString(body, field)! : requiredString(body, field)
  }
  const enabled = optionalBoolean(body, 'enabled')
  if (enabled !== undefined) patch.enabled = enabled
  if (Object.prototype.hasOwnProperty.call(body, 'dataScope')) patch.dataScope = dataScope(body.dataScope)
  if (Object.prototype.hasOwnProperty.call(body, 'capabilityScope')) patch.capabilityScope = capabilityScope(body.capabilityScope)
  if (Object.prototype.hasOwnProperty.call(body, 'decisionAuthority')) patch.decisionAuthority = decisionAuthority(body.decisionAuthority)
  if (Object.prototype.hasOwnProperty.call(body, 'spendingLimits')) patch.spendingLimits = spendingLimits(body.spendingLimits)
  if (Object.prototype.hasOwnProperty.call(body, 'escalationRules')) patch.escalationRules = objectArray(body.escalationRules, 'escalationRules')
  if (Object.keys(patch).length === 0) throw new RequestValidationError('Assistant role patch must include at least one field')
  return patch
}

function roleId(ctx: Context): string {
  const id = String(ctx.params.id ?? '').trim()
  if (!id) throw new RequestValidationError('Assistant role id is required')
  return id
}

function contextRecipeId(ctx: Context): string {
  const id = String(ctx.params.recipeId ?? '').trim()
  if (!id) throw new RequestValidationError('Context recipe id is required')
  return id
}

function safeError(ctx: Context, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RequestValidationError) {
    ctx.status = 400
    ctx.body = { error: message }
  } else if (/unique constraint failed:\s*twin_assistant_roles\./i.test(message)) {
    ctx.status = 409
    ctx.body = { error: 'Assistant role already exists' }
  } else if (/unique constraint failed:\s*twin_context_recipes\./i.test(message)) {
    ctx.status = 409
    ctx.body = { error: 'Context recipe already exists' }
  } else if (/context recipe not found/i.test(message)) {
    ctx.status = 404
    ctx.body = { error: 'Context recipe not found' }
  } else if (/context recipe is disabled/i.test(message)) {
    ctx.status = 400
    ctx.body = { error: 'Context recipe is disabled' }
  } else if (/assistant role not found/i.test(message)) {
    ctx.status = 404
    ctx.body = { error: 'Assistant role not found' }
  } else if (/cannot delete built-in/i.test(message)) {
    ctx.status = 409
    ctx.body = { error: 'Built-in assistant roles cannot be deleted' }
  } else if (/profile name/i.test(message)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid profile mapping' }
  } else if (/context recipe/i.test(message)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid context recipe configuration' }
  } else if (/assistant role/i.test(message)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid assistant role configuration' }
  } else {
    ctx.status = 500
    ctx.body = { error: 'Internal server error' }
  }
}

export async function list(ctx: Context): Promise<void> {
  try {
    ctx.body = { roles: listAssistantRolesWithMappings() }
  } catch (error) { safeError(ctx, error) }
}

export async function detail(ctx: Context): Promise<void> {
  try {
    const id = roleId(ctx)
    const role = listAssistantRolesWithMappings().find(item => item.id === id)
    if (!role) {
      ctx.status = 404
      ctx.body = { error: 'Assistant role not found' }
      return
    }
    ctx.body = { role, recipes: listContextRecipes(id) }
  } catch (error) { safeError(ctx, error) }
}

export async function create(ctx: Context): Promise<void> {
  try {
    ctx.body = { role: createAssistantRole(parseCreate(ctx)) }
    ctx.status = 201
  } catch (error) { safeError(ctx, error) }
}

export async function update(ctx: Context): Promise<void> {
  try {
    ctx.body = { role: updateAssistantRole(roleId(ctx), parsePatch(ctx)) }
  } catch (error) { safeError(ctx, error) }
}

export async function remove(ctx: Context): Promise<void> {
  try {
    deleteAssistantRole(roleId(ctx))
    ctx.body = { success: true }
  } catch (error) { safeError(ctx, error) }
}

export async function clone(ctx: Context): Promise<void> {
  try {
    const body = bodyObject(ctx)
    onlyFields(body, new Set(['id', 'name']))
    const input: { name: string; id?: string } = { name: requiredString(body, 'name') }
    const id = optionalString(body, 'id')
    if (id !== undefined) input.id = id
    ctx.body = { role: cloneAssistantRole(roleId(ctx), input) }
    ctx.status = 201
  } catch (error) { safeError(ctx, error) }
}

export async function updateProfileMapping(ctx: Context): Promise<void> {
  try {
    const body = bodyObject(ctx)
    onlyFields(body, new Set(['profileName']))
    if (!Object.prototype.hasOwnProperty.call(body, 'profileName')) throw new RequestValidationError('profileName is required')
    if (body.profileName !== null && typeof body.profileName !== 'string') throw new RequestValidationError('profileName must be a string or null')
    const profileName = typeof body.profileName === 'string' ? body.profileName.trim() : null
    if (profileName === '') throw new RequestValidationError('profileName must not be empty')
    ctx.body = { mapping: setAssistantRoleProfileMapping(roleId(ctx), profileName) }
  } catch (error) { safeError(ctx, error) }
}

export async function previewContext(ctx: Context): Promise<void> {
  try {
    const body = bodyObject(ctx)
    onlyFields(body, new Set(['query', 'recipeId']))
    const options: RoleContextOptions = {}
    const query = optionalString(body, 'query')
    const recipeId = optionalString(body, 'recipeId')
    if (query !== undefined) options.query = query.trim()
    if (recipeId !== undefined) options.recipeId = recipeId.trim()
    ctx.body = { context: buildRoleContext(roleId(ctx), options) }
  } catch (error) { safeError(ctx, error) }
}

export async function listRecipes(ctx: Context): Promise<void> {
  try { ctx.body = { recipes: listContextRecipes(roleId(ctx)) } } catch (error) { safeError(ctx, error) }
}

export async function createRecipe(ctx: Context): Promise<void> {
  try { ctx.body = { recipe: createContextRecipe(roleId(ctx), parseRecipeCreate(ctx)) }; ctx.status = 201 } catch (error) { safeError(ctx, error) }
}

export async function updateRecipe(ctx: Context): Promise<void> {
  try { ctx.body = { recipe: updateContextRecipe(roleId(ctx), contextRecipeId(ctx), parseRecipePatch(ctx)) } } catch (error) { safeError(ctx, error) }
}

export async function removeRecipe(ctx: Context): Promise<void> {
  try { deleteContextRecipe(roleId(ctx), contextRecipeId(ctx)); ctx.body = { success: true } } catch (error) { safeError(ctx, error) }
}
