import { DatabaseSync } from 'node:sqlite'
import { withPersonalTwinDb } from './database'
import {
  AssistantRole,
  AssistantRoleCapabilityScope,
  AssistantRoleDataScope,
  AssistantRoleInput,
  AssistantRolePatch,
  ContextRecipeLimits,
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
const ROLE_NAME_MAX_LENGTH = 200
const CAPABILITY_ID_MAX_LENGTH = 128

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
      enforcement: 'declarative_phase_2',
    },
    decisionAuthority: {
      mode: 'recommend_only',
      requiresConfirmation: ['external_action', 'financial_commitment', 'sensitive_data_disclosure'],
    },
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
    decisionAuthority: parseJson<Record<string, unknown>>(row.decision_authority_json, 'decision authority'),
    spendingLimits: parseJson<Record<string, unknown>>(row.spending_limits_json, 'spending limits'),
    memoryNamespace: row.memory_namespace,
    escalationRules: parseJson<Array<Record<string, unknown>>>(row.escalation_rules_json, 'escalation rules'),
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
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error('Assistant role capability identifiers must be unique across allow and deny lists')
  }
  if (scope.enforcement !== 'declarative_phase_2') {
    throw new Error('Assistant role capability enforcement must be declarative_phase_2')
  }
}

function validateRoleInput(input: AssistantRoleInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Assistant role input must be an object')
  if (input.id !== undefined && (typeof input.id !== 'string' || !ROLE_ID_PATTERN.test(input.id))) {
    throw new Error('Assistant role id must be a lowercase semantic slug')
  }
  assertString(input.name, 'name', { required: true, max: ROLE_NAME_MAX_LENGTH })
  assertString(input.description ?? '', 'description', { max: ASSISTANT_ROLE_DESCRIPTION_MAX_LENGTH })
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
  assertJsonObject(input.decisionAuthority ?? {}, 'decision authority')
  assertJsonObject(input.spendingLimits ?? {}, 'spending limits')
  if (typeof input.memoryNamespace !== 'string' || !NAMESPACE_PATTERN.test(input.memoryNamespace)) {
    throw new Error('Assistant role memory namespace must be a lowercase semantic namespace')
  }
  const escalationRules = input.escalationRules ?? []
  if (!Array.isArray(escalationRules)) throw new Error('Assistant role escalation rules must be an array')
  if (escalationRules.length > ASSISTANT_ROLE_MAX_ESCALATION_RULES) {
    throw new Error(`Assistant role escalation rules exceed ${ASSISTANT_ROLE_MAX_ESCALATION_RULES}`)
  }
  escalationRules.forEach(rule => assertJsonObject(rule, 'escalation rules'))
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
  const id = input.id || toRoleId(input.name)
  const normalized = { ...input, id }
  validateRoleInput(normalized)
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
    JSON.stringify(normalized.decisionAuthority ?? {}),
    JSON.stringify(normalized.spendingLimits ?? {}),
    normalized.memoryNamespace,
    JSON.stringify(normalized.escalationRules ?? []),
    timestamp,
    timestamp,
  )
  return roleFromRow(requireRoleRow(db, id))
}

function ensureRegistry(): void {
  ensureBuiltInAssistantRoles()
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
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      persona: patch.persona ?? current.persona,
      enabled: patch.enabled ?? current.enabled,
      dataScope: patch.dataScope ?? current.dataScope,
      capabilityScope: patch.capabilityScope ?? current.capabilityScope,
      decisionAuthority: patch.decisionAuthority ?? current.decisionAuthority,
      spendingLimits: patch.spendingLimits ?? current.spendingLimits,
      memoryNamespace: patch.memoryNamespace ?? current.memoryNamespace,
      escalationRules: patch.escalationRules ?? current.escalationRules,
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
