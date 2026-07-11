import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { detectHermesRootHome } from '../hermes-path'
import { getPersonalTwinDbPath, withPersonalTwinDb } from './database'
import {
  AssistantRole,
  AssistantRoleCapabilityScope,
  AssistantRoleDataScope,
  AssistantRoleInput,
  AssistantRoleDecisionAuthority,
  AssistantRoleSpendingLimits,
  AssistantRolePatch,
  AssistantRoleProfileMapping,
  AssistantRoleSummary,
  ContextRecipe,
  ContextRecipeInput,
  ContextRecipeLimits,
  ContextRecipePatch,
  TWIN_CONTEXT_SECTIONS,
  TWIN_DOMAINS,
  TwinContextSection,
  TwinDomain,
} from './types'

export const ASSISTANT_ROLE_PERSONA_MAX_LENGTH = 12_000
export const ASSISTANT_ROLE_DESCRIPTION_MAX_LENGTH = 500
export const ASSISTANT_ROLE_MAX_CAPABILITY_IDS = 64
export const ASSISTANT_ROLE_MAX_ESCALATION_RULES = 32

const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/
const NAMESPACE_PATTERN = /^[a-z][a-z0-9_.:-]{1,127}$/
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9][a-z0-9-]*)*$/
const RECIPE_ID_PATTERN = /^[a-z][a-z0-9-]{1,127}$/
const ROLE_NAME_MAX_LENGTH = 200
const CAPABILITY_ID_MAX_LENGTH = 128
const CONTEXT_RECIPE_QUERY_MAX_LENGTH = 4_000
const SEEDED_DATABASE_PATHS = new Set<string>()

interface AssistantRoleRow {
  id: string
  name: string
  description: string
  persona: string
  built_in: number
  enabled: number
  data_scope_json: string
  capability_scope_json: string
  decision_authority_json: string
  spending_limits_json: string
  memory_namespace: string
  escalation_rules_json: string
  created_at: string
  updated_at: string
}

interface ContextRecipeRow {
  id: string
  role_id: string
  name: string
  description: string
  built_in: number
  enabled: number
  domains_json: string
  sections_json: string
  query_template: string
  limits_json: string
  created_at: string
  updated_at: string
}

interface AssistantRoleProfileMappingRow {
  role_id: string
  profile_name: string
  is_primary: number
  created_at: string
  updated_at: string
}

interface BuiltInRoleTemplate extends AssistantRoleInput {
  id: string
  recipe: {
    id: string
    name: string
    description: string
    domains: TwinDomain[]
    sections: TwinContextSection[]
    queryTemplate: string
    limits: ContextRecipeLimits
  }
}

const ALL_DOMAINS = [...TWIN_DOMAINS]
const ALL_SECTIONS = [...TWIN_CONTEXT_SECTIONS]

const BUILT_IN_ROLES: BuiltInRoleTemplate[] = [
  builtInTemplate({
    id: 'chief-of-staff',
    name: 'Chief of Staff',
    description: 'Coordinates priorities across the personal operating system and keeps plans aligned.',
    persona: 'Act as a calm, rigorous chief of staff. Synthesize relevant context, expose trade-offs, keep commitments visible, and escalate consequential or uncertain decisions to the user.',
    domains: ALL_DOMAINS,
    memoryNamespace: 'assistant.chief-of-staff',
  }),
  builtInTemplate({
    id: 'entertainment-assistant',
    name: 'Entertainment Assistant',
    description: 'Supports leisure planning, media discovery, and bounded purchasing recommendations.',
    persona: 'Act as a thoughtful entertainment assistant. Learn the user\'s tastes from permitted context, offer varied options, respect time and spending constraints, and never represent a recommendation as a completed purchase.',
    domains: ['entertainment', 'life', 'commerce'],
    memoryNamespace: 'assistant.entertainment-assistant',
  }),
  builtInTemplate({
    id: 'fitness-coach',
    name: 'Fitness Coach',
    description: 'Turns fitness, nutrition, health, and body context into conservative training guidance.',
    persona: 'Act as a conservative fitness coach. Favor sustainable progression, recovery, and evidence-aware guidance. Treat health warning signs as escalation triggers and do not diagnose or prescribe medical treatment.',
    domains: ['body', 'fitness', 'nutrition', 'health'],
    memoryNamespace: 'assistant.fitness-coach',
  }),
  builtInTemplate({
    id: 'health-manager',
    name: 'Health Manager',
    description: 'Organizes health context, follow-ups, and questions for qualified care professionals.',
    persona: 'Act as a careful health manager. Organize observations and goals, distinguish facts from inferences, surface uncertainty and red flags, and defer diagnosis or treatment decisions to qualified clinicians.',
    domains: ['body', 'health', 'nutrition', 'fitness'],
    memoryNamespace: 'assistant.health-manager',
  }),
  builtInTemplate({
    id: 'home-manager',
    name: 'Home Manager',
    description: 'Coordinates household and digital-home routines without taking autonomous action.',
    persona: 'Act as a dependable home manager. Keep household and digital routines orderly, prefer reversible recommendations, respect privacy and safety boundaries, and request confirmation before consequential actions.',
    domains: ['home', 'digital'],
    memoryNamespace: 'assistant.home-manager',
  }),
]

function builtInTemplate(input: {
  id: string
  name: string
  description: string
  persona: string
  domains: TwinDomain[]
  memoryNamespace: string
}): BuiltInRoleTemplate {
  const sections = [...ALL_SECTIONS]
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    persona: input.persona,
    enabled: true,
    dataScope: { domains: [...input.domains], sections, includeProvenance: true },
    capabilityScope: {
      allow: ['twin.read'],
      deny: ['action.execute'],
      enforcement: 'action_fabric_v1',
    },
    decisionAuthority: { maxRisk: 'none', requireApprovalAbove: 'none', allowedTargets: [] },
    spendingLimits: { currency: null, perAction: 0, daily: 0 },
    memoryNamespace: input.memoryNamespace,
    escalationRules: [
      { when: 'high_impact_or_irreversible', action: 'ask_user' },
      { when: 'insufficient_or_conflicting_context', action: 'state_uncertainty_and_ask' },
    ],
    recipe: {
      id: `${input.id}-default`,
      name: `${input.name} Default`,
      description: `Default bounded Personal Twin context for ${input.name}.`,
      domains: [...input.domains],
      sections: [...sections],
      queryTemplate: '{{query}}',
      limits: { perSection: 10, totalCharacters: 12_000 },
    },
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(`Stored assistant role ${field} is invalid JSON`)
  }
}

function roleFromRow(row: AssistantRoleRow): AssistantRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    persona: row.persona,
    builtIn: row.built_in === 1,
    enabled: row.enabled === 1,
    dataScope: parseJson<AssistantRoleDataScope>(row.data_scope_json, 'data scope'),
    capabilityScope: parseJson<AssistantRoleCapabilityScope>(row.capability_scope_json, 'capability scope'),
    decisionAuthority: parseJson<AssistantRoleDecisionAuthority>(row.decision_authority_json, 'decision authority'),
    spendingLimits: parseJson<AssistantRoleSpendingLimits>(row.spending_limits_json, 'spending limits'),
    memoryNamespace: row.memory_namespace,
    escalationRules: parseJson<Array<Record<string, unknown>>>(row.escalation_rules_json, 'escalation rules'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mappingFromRow(row: AssistantRoleProfileMappingRow): AssistantRoleProfileMapping {
  return {
    roleId: row.role_id,
    profileName: row.profile_name,
    isPrimary: row.is_primary === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function recipeFromRow(row: ContextRecipeRow): ContextRecipe {
  return {
    id: row.id,
    roleId: row.role_id,
    name: row.name,
    description: row.description,
    builtIn: row.built_in === 1,
    enabled: row.enabled === 1,
    domains: parseJson<TwinDomain[]>(row.domains_json, 'recipe domains'),
    sections: parseJson<TwinContextSection[]>(row.sections_json, 'recipe sections'),
    queryTemplate: row.query_template,
    limits: parseJson<ContextRecipeLimits>(row.limits_json, 'recipe limits'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function assertString(value: unknown, field: string, options: { required?: boolean; max: number }): asserts value is string {
  if (typeof value !== 'string') throw new Error(`Assistant role ${field} must be a string`)
  if (options.required && !value.trim()) throw new Error(`Assistant role ${field} is required`)
  if (value.length > options.max) throw new Error(`Assistant role ${field} exceeds ${options.max} characters`)
}

function assertUniqueAllowedValues<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): asserts value is T[] {
  if (!Array.isArray(value)) throw new Error(`Assistant role ${field} must be an array`)
  if (value.some(item => typeof item !== 'string' || !allowed.includes(item as T))) {
    throw new Error(`Assistant role ${field} contains an unsupported value`)
  }
  if (new Set(value).size !== value.length) throw new Error(`Assistant role ${field} values must be unique`)
}

function assertJsonSafe(value: unknown, field: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Assistant role ${field} must contain only JSON-safe values`)
    return
  }
  if (typeof value !== 'object') throw new Error(`Assistant role ${field} must contain only JSON-safe values`)
  if (seen.has(value)) throw new Error(`Assistant role ${field} must contain only JSON-safe values`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach(item => assertJsonSafe(item, field, seen))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Assistant role ${field} must contain only JSON-safe values`)
    }
    Object.entries(value).forEach(([key, item]) => {
      if (!key) throw new Error(`Assistant role ${field} contains an empty JSON key`)
      assertJsonSafe(item, field, seen)
    })
  }
  seen.delete(value)
}

function assertJsonObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Assistant role ${field} must be a JSON object`)
  }
  assertJsonSafe(value, field)
}

function validateCapabilityScope(value: unknown): asserts value is AssistantRoleCapabilityScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Assistant role capability scope must be an object')
  }
  const scope = value as Partial<AssistantRoleCapabilityScope>
  if (!Array.isArray(scope.allow) || !Array.isArray(scope.deny)) {
    throw new Error('Assistant role capability allow and deny lists must be arrays')
  }
  const identifiers = [...scope.allow, ...scope.deny]
  if (identifiers.length > ASSISTANT_ROLE_MAX_CAPABILITY_IDS) {
    throw new Error(`Assistant role capability scope exceeds ${ASSISTANT_ROLE_MAX_CAPABILITY_IDS} identifiers`)
  }
  if (identifiers.some(id => typeof id !== 'string' || id.length > CAPABILITY_ID_MAX_LENGTH || !CAPABILITY_ID_PATTERN.test(id))) {
    throw new Error('Assistant role capability identifiers must be semantic IDs')
  }
  if (new Set(scope.allow).size !== scope.allow.length || new Set(scope.deny).size !== scope.deny.length) {
    throw new Error('Assistant role capability identifiers must be unique within each list')
  }
  if (scope.enforcement !== 'action_fabric_v1') {
    throw new Error('Assistant role capability enforcement must be action_fabric_v1')
  }
}

const ROLE_RISKS = new Set(['none', 'low', 'medium', 'high', 'critical'])
function validateDecisionAuthority(value: unknown): asserts value is AssistantRoleDecisionAuthority {
  assertJsonObject(value, 'decision authority')
  const keys = Object.keys(value)
  if (keys.some(key => !['maxRisk', 'requireApprovalAbove', 'allowedTargets'].includes(key))) {
    throw new Error('Assistant role decision authority contains unsupported fields')
  }
  if (!ROLE_RISKS.has(value.maxRisk as string)) throw new Error('Assistant role decision authority maxRisk is invalid')
  if (value.requireApprovalAbove !== undefined && !ROLE_RISKS.has(value.requireApprovalAbove as string)) {
    throw new Error('Assistant role decision authority requireApprovalAbove is invalid')
  }
  if (value.allowedTargets !== undefined) {
    if (!Array.isArray(value.allowedTargets) || value.allowedTargets.length > 64
      || value.allowedTargets.some(item => typeof item !== 'string' || !item || item === '*' || item.length > 256)
      || new Set(value.allowedTargets).size !== value.allowedTargets.length) {
      throw new Error('Assistant role decision authority allowedTargets must be unique literal targets')
    }
  }
}

function validateSpendingLimits(value: unknown): asserts value is AssistantRoleSpendingLimits {
  assertJsonObject(value, 'spending limits')
  if (Object.keys(value).some(key => !['currency', 'perAction', 'daily'].includes(key))) {
    throw new Error('Assistant role spending limits contain unsupported fields')
  }
  if (!(value.currency === null || (typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency)))) {
    throw new Error('Assistant role spending limits currency is invalid')
  }
  if (!Number.isSafeInteger(value.perAction) || (value.perAction as number) < 0
    || !Number.isSafeInteger(value.daily) || (value.daily as number) < 0) {
    throw new Error('Assistant role spending limits must use non-negative integer minor units')
  }
  if (value.currency === null && (value.perAction !== 0 || value.daily !== 0)) {
    throw new Error('Assistant role spending limits require a currency')
  }
}

function validateRoleInput(input: AssistantRoleInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Assistant role input must be an object')
  if (input.id !== undefined && (typeof input.id !== 'string' || !ROLE_ID_PATTERN.test(input.id))) {
    throw new Error('Assistant role id must be a lowercase semantic slug')
  }
  assertString(input.name, 'name', { required: true, max: ROLE_NAME_MAX_LENGTH })
  assertString(input.description === undefined ? '' : input.description, 'description', { max: ASSISTANT_ROLE_DESCRIPTION_MAX_LENGTH })
  assertString(input.persona, 'persona', { required: true, max: ASSISTANT_ROLE_PERSONA_MAX_LENGTH })
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Assistant role enabled must be a boolean')
  if (!input.dataScope || typeof input.dataScope !== 'object' || Array.isArray(input.dataScope)) {
    throw new Error('Assistant role data scope must be an object')
  }
  assertUniqueAllowedValues(input.dataScope.domains, TWIN_DOMAINS, 'domains')
  assertUniqueAllowedValues(input.dataScope.sections, TWIN_CONTEXT_SECTIONS, 'sections')
  if (typeof input.dataScope.includeProvenance !== 'boolean') {
    throw new Error('Assistant role data scope includeProvenance must be a boolean')
  }
  validateCapabilityScope(input.capabilityScope)
  validateDecisionAuthority(input.decisionAuthority === undefined ? { maxRisk: 'none' } : input.decisionAuthority)
  validateSpendingLimits(input.spendingLimits === undefined ? { currency: null, perAction: 0, daily: 0 } : input.spendingLimits)
  if (typeof input.memoryNamespace !== 'string' || !NAMESPACE_PATTERN.test(input.memoryNamespace)) {
    throw new Error('Assistant role memory namespace must be a lowercase semantic namespace')
  }
  const escalationRules = input.escalationRules === undefined ? [] : input.escalationRules
  if (!Array.isArray(escalationRules)) throw new Error('Assistant role escalation rules must be an array')
  if (escalationRules.length > ASSISTANT_ROLE_MAX_ESCALATION_RULES) {
    throw new Error(`Assistant role escalation rules exceed ${ASSISTANT_ROLE_MAX_ESCALATION_RULES}`)
  }
  escalationRules.forEach(rule => assertJsonObject(rule, 'escalation rules'))
}

function validateRecipeInput(input: ContextRecipeInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Context recipe input must be an object')
  if (input.id !== undefined && (typeof input.id !== 'string' || !RECIPE_ID_PATTERN.test(input.id))) {
    throw new Error('Context recipe id must be a lowercase semantic slug')
  }
  assertString(input.name, 'recipe name', { required: true, max: ROLE_NAME_MAX_LENGTH })
  assertString(input.description === undefined ? '' : input.description, 'recipe description', { max: ASSISTANT_ROLE_DESCRIPTION_MAX_LENGTH })
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Context recipe enabled must be a boolean')
  assertUniqueAllowedValues(input.domains, TWIN_DOMAINS, 'recipe domains')
  assertUniqueAllowedValues(input.sections, TWIN_CONTEXT_SECTIONS, 'recipe sections')
  assertString(input.queryTemplate === undefined ? '' : input.queryTemplate, 'recipe query template', { max: CONTEXT_RECIPE_QUERY_MAX_LENGTH })
  if (!input.limits || typeof input.limits !== 'object' || Array.isArray(input.limits)) {
    throw new Error('Context recipe limits must be an object')
  }
  if (!Number.isInteger(input.limits.perSection)) {
    throw new Error('Context recipe perSection must be an integer')
  }
  if (!Number.isInteger(input.limits.totalCharacters)) {
    throw new Error('Context recipe totalCharacters must be an integer')
  }
}

function clampRecipeLimits(limits: ContextRecipeLimits): ContextRecipeLimits {
  return {
    perSection: Math.min(50, Math.max(1, limits.perSection)),
    totalCharacters: Math.min(40_000, Math.max(1_000, limits.totalCharacters)),
  }
}

function toRoleId(name: string): string {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!ROLE_ID_PATTERN.test(id)) throw new Error('Assistant role id could not be derived from name; provide a valid id')
  return id
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function requireRoleRow(db: DatabaseSync, id: string): AssistantRoleRow {
  const row = db.prepare('SELECT * FROM twin_assistant_roles WHERE id = ?').get(id) as unknown as AssistantRoleRow | undefined
  if (!row) throw new Error(`Assistant role not found: ${id}`)
  return row
}

function ensureNamespaceAvailable(db: DatabaseSync, namespace: string, exceptId?: string): void {
  const existing = db.prepare('SELECT id FROM twin_assistant_roles WHERE memory_namespace = ?').get(namespace) as { id: string } | undefined
  if (existing && existing.id !== exceptId) throw new Error(`Assistant role memory namespace is already in use: ${namespace}`)
}

function insertRole(db: DatabaseSync, input: AssistantRoleInput, builtIn: boolean, timestamp: string): AssistantRole {
  validateRoleInput(input)
  const id = input.id || toRoleId(input.name)
  const normalized = { ...input, id }
  ensureNamespaceAvailable(db, normalized.memoryNamespace)
  db.prepare(`
    INSERT INTO twin_assistant_roles (
      id, name, description, persona, built_in, enabled, data_scope_json,
      capability_scope_json, decision_authority_json, spending_limits_json,
      memory_namespace, escalation_rules_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    normalized.name.trim(),
    normalized.description ?? '',
    normalized.persona,
    builtIn ? 1 : 0,
    normalized.enabled === false ? 0 : 1,
    JSON.stringify(normalized.dataScope),
    JSON.stringify(normalized.capabilityScope),
    JSON.stringify(normalized.decisionAuthority ?? { maxRisk: 'none' }),
    JSON.stringify(normalized.spendingLimits ?? { currency: null, perAction: 0, daily: 0 }),
    normalized.memoryNamespace,
    JSON.stringify(normalized.escalationRules ?? []),
    timestamp,
    timestamp,
  )
  return roleFromRow(requireRoleRow(db, id))
}

function ensureRegistry(): void {
  if (!SEEDED_DATABASE_PATHS.has(getPersonalTwinDbPath())) ensureBuiltInAssistantRoles()
}

export function ensureBuiltInAssistantRoles(): void {
  withPersonalTwinDb(db => transaction(db, () => {
    const timestamp = nowIso()
    const insertRoleStatement = db.prepare(`
      INSERT INTO twin_assistant_roles (
        id, name, description, persona, built_in, enabled, data_scope_json,
        capability_scope_json, decision_authority_json, spending_limits_json,
        memory_namespace, escalation_rules_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)
    const insertRecipeStatement = db.prepare(`
      INSERT INTO twin_context_recipes (
        id, role_id, name, description, built_in, enabled, domains_json,
        sections_json, query_template, limits_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)

    for (const role of BUILT_IN_ROLES) {
      validateRoleInput(role)
      insertRoleStatement.run(
        role.id,
        role.name,
        role.description ?? '',
        role.persona,
        role.enabled === false ? 0 : 1,
        JSON.stringify(role.dataScope),
        JSON.stringify(role.capabilityScope),
        JSON.stringify(role.decisionAuthority ?? {}),
        JSON.stringify(role.spendingLimits ?? {}),
        role.memoryNamespace,
        JSON.stringify(role.escalationRules ?? []),
        timestamp,
        timestamp,
      )
      insertRecipeStatement.run(
        role.recipe.id,
        role.id,
        role.recipe.name,
        role.recipe.description,
        JSON.stringify(role.recipe.domains),
        JSON.stringify(role.recipe.sections),
        role.recipe.queryTemplate,
        JSON.stringify(role.recipe.limits),
        timestamp,
        timestamp,
      )
    }
  }))
  SEEDED_DATABASE_PATHS.add(getPersonalTwinDbPath())
}

/** One-time Phase 3 activation. Reads intentionally never invoke this writer. */
export function migrateAssistantRoleCapabilityEnforcement(): number {
  ensureRegistry()
  const needsMigration = withPersonalTwinDb(db => db.prepare(
    "SELECT 1 AS present FROM twin_assistant_roles WHERE capability_scope_json LIKE '%declarative_phase_2%' LIMIT 1",
  ).get() !== undefined)
  if (!needsMigration) return 0
  return withPersonalTwinDb(db => transaction(db, () => {
    const rows = db.prepare('SELECT id, capability_scope_json FROM twin_assistant_roles').all() as Array<{
      id: string
      capability_scope_json: string
    }>
    let migrated = 0
    const update = db.prepare('UPDATE twin_assistant_roles SET capability_scope_json = ?, updated_at = ? WHERE id = ?')
    for (const row of rows) {
      const scope = parseJson<AssistantRoleCapabilityScope>(row.capability_scope_json, 'capability scope')
      if (scope.enforcement !== 'declarative_phase_2') continue
      const next: AssistantRoleCapabilityScope = { allow: [...scope.allow], deny: [...scope.deny], enforcement: 'action_fabric_v1' }
      validateCapabilityScope(next)
      update.run(JSON.stringify(next), nowIso(), row.id)
      migrated += 1
    }
    return migrated
  }))
}

export function listAssistantRoles(): AssistantRole[] {
  ensureRegistry()
  return withPersonalTwinDb(db => (db.prepare(
    'SELECT * FROM twin_assistant_roles ORDER BY id',
  ).all() as unknown as AssistantRoleRow[]).map(roleFromRow))
}

export function getAssistantRole(id: string): AssistantRole | null {
  ensureRegistry()
  return withPersonalTwinDb(db => {
    const row = db.prepare('SELECT * FROM twin_assistant_roles WHERE id = ?').get(id) as unknown as AssistantRoleRow | undefined
    return row ? roleFromRow(row) : null
  })
}

export function createAssistantRole(input: AssistantRoleInput): AssistantRole {
  ensureRegistry()
  return withPersonalTwinDb(db => transaction(db, () => insertRole(db, input, false, nowIso())))
}

export function updateAssistantRole(id: string, patch: AssistantRolePatch): AssistantRole {
  ensureRegistry()
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Assistant role patch must be an object')
  if (Object.prototype.hasOwnProperty.call(patch, 'id')) throw new Error('Assistant role id cannot be changed')
  return withPersonalTwinDb(db => transaction(db, () => {
    const current = roleFromRow(requireRoleRow(db, id))
    const input: AssistantRoleInput = {
      id: current.id,
      name: patchValue(patch, 'name', current.name),
      description: patchValue(patch, 'description', current.description),
      persona: patchValue(patch, 'persona', current.persona),
      enabled: patchValue(patch, 'enabled', current.enabled),
      dataScope: patchValue(patch, 'dataScope', current.dataScope),
      capabilityScope: patchValue(patch, 'capabilityScope', current.capabilityScope),
      decisionAuthority: patchValue(patch, 'decisionAuthority', current.decisionAuthority),
      spendingLimits: patchValue(patch, 'spendingLimits', current.spendingLimits),
      memoryNamespace: patchValue(patch, 'memoryNamespace', current.memoryNamespace),
      escalationRules: patchValue(patch, 'escalationRules', current.escalationRules),
    }
    validateRoleInput(input)
    ensureNamespaceAvailable(db, input.memoryNamespace, id)
    const timestamp = nowIso()
    db.prepare(`
      UPDATE twin_assistant_roles SET
        name = ?, description = ?, persona = ?, enabled = ?, data_scope_json = ?,
        capability_scope_json = ?, decision_authority_json = ?, spending_limits_json = ?,
        memory_namespace = ?, escalation_rules_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name.trim(),
      input.description ?? '',
      input.persona,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.dataScope),
      JSON.stringify(input.capabilityScope),
      JSON.stringify(input.decisionAuthority ?? {}),
      JSON.stringify(input.spendingLimits ?? {}),
      input.memoryNamespace,
      JSON.stringify(input.escalationRules ?? []),
      timestamp,
      id,
    )
    return roleFromRow(requireRoleRow(db, id))
  }))
}

function patchValue<T>(patch: AssistantRolePatch, key: keyof AssistantRolePatch, current: T): T {
  if (!Object.prototype.hasOwnProperty.call(patch, key)) return current
  return (patch as Record<string, unknown>)[key] as T
}

export function deleteAssistantRole(id: string): void {
  ensureRegistry()
  withPersonalTwinDb(db => transaction(db, () => {
    const role = requireRoleRow(db, id)
    if (role.built_in === 1) throw new Error(`Cannot delete built-in assistant role: ${id}`)
    db.prepare('DELETE FROM twin_assistant_roles WHERE id = ?').run(id)
  }))
}

export function cloneAssistantRole(id: string, input: { name: string; id?: string }): AssistantRole {
  ensureRegistry()
  assertString(input?.name, 'name', { required: true, max: ROLE_NAME_MAX_LENGTH })
  if (input.id !== undefined && !ROLE_ID_PATTERN.test(input.id)) {
    throw new Error('Assistant role id must be a lowercase semantic slug')
  }
  return withPersonalTwinDb(db => transaction(db, () => {
    const source = roleFromRow(requireRoleRow(db, id))
    const cloneId = input.id || toRoleId(input.name)
    const clone = insertRole(db, {
      id: cloneId,
      name: input.name,
      description: source.description,
      persona: source.persona,
      enabled: source.enabled,
      dataScope: source.dataScope,
      capabilityScope: source.capabilityScope,
      decisionAuthority: source.decisionAuthority,
      spendingLimits: source.spendingLimits,
      memoryNamespace: `assistant.${cloneId}`,
      escalationRules: source.escalationRules,
    }, false, nowIso())

    const recipes = db.prepare(
      'SELECT * FROM twin_context_recipes WHERE role_id = ? ORDER BY id',
    ).all(id) as unknown as ContextRecipeRow[]
    const insertRecipe = db.prepare(`
      INSERT INTO twin_context_recipes (
        id, role_id, name, description, built_in, enabled, domains_json,
        sections_json, query_template, limits_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `)
    const timestamp = nowIso()
    recipes.forEach((recipe, index) => insertRecipe.run(
      `${cloneId}-recipe-${index + 1}`,
      cloneId,
      recipe.name,
      recipe.description,
      recipe.enabled,
      recipe.domains_json,
      recipe.sections_json,
      recipe.query_template,
      recipe.limits_json,
      timestamp,
      timestamp,
    ))
    return clone
  }))
}

function normalizeProfileMappingName(profileName: string): string {
  if (typeof profileName !== 'string') throw new Error('Profile name must be a string')
  const normalized = profileName.trim()
  if (!normalized || normalized.length > 200 || normalized === '.' || normalized === '..'
    || normalized.includes('/') || normalized.includes('\\') || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('Profile name is invalid for assistant role mapping')
  }
  return normalized
}

function profileExistsOnDisk(profileName: string): boolean {
  if (profileName === 'default') return true
  return existsSync(join(detectHermesRootHome(), 'profiles', profileName))
}

export function setAssistantRoleProfileMapping(
  roleId: string,
  profileName: string | null,
): AssistantRoleProfileMapping | null {
  ensureRegistry()
  const normalized = profileName === null ? null : normalizeProfileMappingName(profileName)
  return withPersonalTwinDb(db => transaction(db, () => {
    requireRoleRow(db, roleId)
    if (normalized === null) {
      db.prepare('DELETE FROM twin_role_profile_mappings WHERE role_id = ?').run(roleId)
      return null
    }
    db.prepare('DELETE FROM twin_role_profile_mappings WHERE role_id = ? OR profile_name = ?').run(roleId, normalized)
    const timestamp = nowIso()
    db.prepare(`
      INSERT INTO twin_role_profile_mappings (
        role_id, profile_name, is_primary, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?)
    `).run(roleId, normalized, timestamp, timestamp)
    const row = db.prepare(`
      SELECT * FROM twin_role_profile_mappings WHERE role_id = ? AND profile_name = ?
    `).get(roleId, normalized) as unknown as AssistantRoleProfileMappingRow
    return mappingFromRow(row)
  }))
}

export function resolveAssistantRoleForProfile(profileName: string): AssistantRole | null {
  ensureRegistry()
  const normalized = normalizeProfileMappingName(profileName)
  return withPersonalTwinDb(db => {
    const mapped = db.prepare(`
      SELECT role.* FROM twin_assistant_roles role
      JOIN twin_role_profile_mappings mapping ON mapping.role_id = role.id
      WHERE mapping.profile_name = ? AND mapping.is_primary = 1 AND role.enabled = 1
    `).get(normalized) as unknown as AssistantRoleRow | undefined
    if (mapped && profileExistsOnDisk(normalized)) return roleFromRow(mapped)
    const fallback = db.prepare(
      "SELECT * FROM twin_assistant_roles WHERE id = 'chief-of-staff' AND enabled = 1",
    ).get() as unknown as AssistantRoleRow | undefined
    return fallback ? roleFromRow(fallback) : null
  })
}

export function renameAssistantRoleProfileMappings(oldName: string, newName: string): void {
  ensureRegistry()
  const oldProfileName = normalizeProfileMappingName(oldName)
  const newProfileName = normalizeProfileMappingName(newName)
  withPersonalTwinDb(db => transaction(db, () => {
    if (oldProfileName === newProfileName) return
    db.prepare('DELETE FROM twin_role_profile_mappings WHERE profile_name = ?').run(newProfileName)
    db.prepare(`
      UPDATE twin_role_profile_mappings
      SET profile_name = ?, updated_at = ?
      WHERE profile_name = ?
    `).run(newProfileName, nowIso(), oldProfileName)
  }))
}

export function removeAssistantRoleProfileMappings(profileName: string): void {
  ensureRegistry()
  const normalized = normalizeProfileMappingName(profileName)
  withPersonalTwinDb(db => {
    db.prepare('DELETE FROM twin_role_profile_mappings WHERE profile_name = ?').run(normalized)
  })
}

export function listAssistantRolesWithMappings(): AssistantRoleSummary[] {
  ensureRegistry()
  return withPersonalTwinDb(db => {
    const roles = (db.prepare('SELECT * FROM twin_assistant_roles ORDER BY id').all() as unknown as AssistantRoleRow[])
      .map(roleFromRow)
    const mappings = (db.prepare(`
      SELECT * FROM twin_role_profile_mappings ORDER BY role_id, profile_name
    `).all() as unknown as AssistantRoleProfileMappingRow[]).map(mappingFromRow)
    const recipeCounts = db.prepare(`
      SELECT role_id, COUNT(*) AS count FROM twin_context_recipes GROUP BY role_id
    `).all() as unknown as Array<{ role_id: string; count: number }>
    const countsByRole = new Map(recipeCounts.map(row => [row.role_id, row.count]))

    return roles.map(role => {
      const profileMappings = mappings.filter(mapping => mapping.roleId === role.id)
      const primary = profileMappings.find(mapping => mapping.isPrimary) || null
      return {
        ...role,
        profileMappings,
        primaryProfileName: primary?.profileName ?? null,
        mappingStale: primary ? !profileExistsOnDisk(primary.profileName) : false,
        recipeCount: countsByRole.get(role.id) ?? 0,
      }
    })
  })
}

function requireRecipeRow(db: DatabaseSync, roleId: string, recipeId: string): ContextRecipeRow {
  const row = db.prepare(
    'SELECT * FROM twin_context_recipes WHERE id = ? AND role_id = ?',
  ).get(recipeId, roleId) as unknown as ContextRecipeRow | undefined
  if (!row) throw new Error(`Context recipe not found: ${recipeId}`)
  return row
}

export function listContextRecipes(roleId: string): ContextRecipe[] {
  ensureRegistry()
  return withPersonalTwinDb(db => {
    requireRoleRow(db, roleId)
    return (db.prepare(
      'SELECT * FROM twin_context_recipes WHERE role_id = ? ORDER BY id',
    ).all(roleId) as unknown as ContextRecipeRow[]).map(recipeFromRow)
  })
}

export function createContextRecipe(roleId: string, input: ContextRecipeInput): ContextRecipe {
  ensureRegistry()
  validateRecipeInput(input)
  const limits = clampRecipeLimits(input.limits)
  return withPersonalTwinDb(db => transaction(db, () => {
    requireRoleRow(db, roleId)
    const id = input.id || `${roleId}-${toRoleId(input.name)}`
    if (!RECIPE_ID_PATTERN.test(id)) throw new Error('Context recipe id must be a lowercase semantic slug')
    const timestamp = nowIso()
    db.prepare(`
      INSERT INTO twin_context_recipes (
        id, role_id, name, description, built_in, enabled, domains_json,
        sections_json, query_template, limits_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      roleId,
      input.name.trim(),
      input.description ?? '',
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.domains),
      JSON.stringify(input.sections),
      input.queryTemplate ?? '',
      JSON.stringify(limits),
      timestamp,
      timestamp,
    )
    return recipeFromRow(requireRecipeRow(db, roleId, id))
  }))
}

export function updateContextRecipe(roleId: string, recipeId: string, patch: ContextRecipePatch): ContextRecipe {
  ensureRegistry()
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Context recipe patch must be an object')
  if (Object.prototype.hasOwnProperty.call(patch, 'id')) throw new Error('Context recipe id cannot be changed')
  return withPersonalTwinDb(db => transaction(db, () => {
    const current = recipeFromRow(requireRecipeRow(db, roleId, recipeId))
    const input: ContextRecipeInput = {
      id: current.id,
      name: recipePatchValue(patch, 'name', current.name),
      description: recipePatchValue(patch, 'description', current.description),
      enabled: recipePatchValue(patch, 'enabled', current.enabled),
      domains: recipePatchValue(patch, 'domains', current.domains),
      sections: recipePatchValue(patch, 'sections', current.sections),
      queryTemplate: recipePatchValue(patch, 'queryTemplate', current.queryTemplate),
      limits: recipePatchValue(patch, 'limits', current.limits),
    }
    validateRecipeInput(input)
    const limits = clampRecipeLimits(input.limits)
    db.prepare(`
      UPDATE twin_context_recipes SET
        name = ?, description = ?, enabled = ?, domains_json = ?, sections_json = ?,
        query_template = ?, limits_json = ?, updated_at = ?
      WHERE id = ? AND role_id = ?
    `).run(
      input.name.trim(),
      input.description ?? '',
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.domains),
      JSON.stringify(input.sections),
      input.queryTemplate ?? '',
      JSON.stringify(limits),
      nowIso(),
      recipeId,
      roleId,
    )
    return recipeFromRow(requireRecipeRow(db, roleId, recipeId))
  }))
}

function recipePatchValue<T>(patch: ContextRecipePatch, key: keyof ContextRecipePatch, current: T): T {
  if (!Object.prototype.hasOwnProperty.call(patch, key)) return current
  return (patch as Record<string, unknown>)[key] as T
}

export function deleteContextRecipe(roleId: string, recipeId: string): void {
  ensureRegistry()
  withPersonalTwinDb(db => transaction(db, () => {
    const recipe = requireRecipeRow(db, roleId, recipeId)
    if (recipe.built_in === 1) throw new Error(`Cannot delete built-in context recipe: ${recipeId}`)
    db.prepare('DELETE FROM twin_context_recipes WHERE id = ? AND role_id = ?').run(recipeId, roleId)
  }))
}
