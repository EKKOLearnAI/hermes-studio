import type { Context } from 'koa'
import {
  TWIN_CONTEXT_SECTIONS,
  TWIN_DOMAINS,
  buildRoleContext,
  cloneAssistantRole,
  createAssistantRole,
  deleteAssistantRole,
  listAssistantRolesWithMappings,
  listContextRecipes,
  setAssistantRoleProfileMapping,
  updateAssistantRole,
} from '../../services/hermes/personal-twin'
import type {
  AssistantRoleCapabilityScope,
  AssistantRoleDataScope,
  AssistantRoleInput,
  AssistantRolePatch,
  RoleContextOptions,
} from '../../services/hermes/personal-twin'

class RequestValidationError extends Error {}

const ROLE_FIELDS = new Set([
  'id', 'name', 'description', 'persona', 'enabled', 'dataScope', 'capabilityScope',
  'decisionAuthority', 'spendingLimits', 'memoryNamespace', 'escalationRules',
])
const PATCH_FIELDS = new Set([...ROLE_FIELDS].filter(field => field !== 'id'))

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
  if (value.enforcement !== 'declarative_phase_2') {
    throw new RequestValidationError('capabilityScope.enforcement must be declarative_phase_2')
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

function objectArray(value: unknown, field: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some(item => !isRecord(item))) {
    throw new RequestValidationError(`${field} must be an array of JSON objects`)
  }
  return value
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
  if (Object.prototype.hasOwnProperty.call(body, 'decisionAuthority')) input.decisionAuthority = jsonObject(body.decisionAuthority, 'decisionAuthority')
  if (Object.prototype.hasOwnProperty.call(body, 'spendingLimits')) input.spendingLimits = jsonObject(body.spendingLimits, 'spendingLimits')
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
  if (Object.prototype.hasOwnProperty.call(body, 'decisionAuthority')) patch.decisionAuthority = jsonObject(body.decisionAuthority, 'decisionAuthority')
  if (Object.prototype.hasOwnProperty.call(body, 'spendingLimits')) patch.spendingLimits = jsonObject(body.spendingLimits, 'spendingLimits')
  if (Object.prototype.hasOwnProperty.call(body, 'escalationRules')) patch.escalationRules = objectArray(body.escalationRules, 'escalationRules')
  return patch
}

function roleId(ctx: Context): string {
  const id = String(ctx.params.id ?? '').trim()
  if (!id) throw new RequestValidationError('Assistant role id is required')
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
