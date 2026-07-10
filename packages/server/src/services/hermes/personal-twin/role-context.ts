import {
  getAssistantRole,
  listAssistantRolesWithMappings,
  listContextRecipes,
  resolveAssistantRoleForProfile,
} from './assistant-roles'
import {
  getTwinEntity,
  listTwinConstraintsForContext,
  listTwinEntitiesForContext,
  listTwinEvents,
  listTwinGoalsForContext,
  listTwinObservations,
  listTwinRelationsForContext,
} from './store'
import {
  AssistantRole,
  ContextRecipe,
  ContextRecipeLimits,
  RoleContextBundle,
  RoleContextOptions,
  RoleContextProvenance,
  RoleContextSections,
  TwinContextSection,
  TwinDomain,
} from './types'

const SECTION_ORDER: TwinContextSection[] = [
  'subject', 'goals', 'constraints', 'observations', 'events', 'entities', 'relations',
]
const DEFAULT_LIMITS: ContextRecipeLimits = { perSection: 10, totalCharacters: 12_000 }

type SectionRecord = Record<string, unknown>

export function buildRoleContext(roleId: string, options: RoleContextOptions = {}): RoleContextBundle {
  const role = getAssistantRole(roleId)
  if (!role) throw new Error(`Assistant role not found: ${roleId}`)
  if (!role.enabled) throw new Error(`Assistant role is disabled: ${roleId}`)
  return buildBundle(role, { profileName: null, stale: false }, options)
}

export function buildRoleContextForProfile(
  profileName: string,
  options: RoleContextOptions = {},
): RoleContextBundle | null {
  const role = resolveAssistantRoleForProfile(profileName)
  if (!role) return null
  const summary = listAssistantRolesWithMappings()
  const mapped = summary.find(item => item.profileMappings.some(mapping => mapping.profileName === profileName.trim()))
  return buildBundle(role, {
    profileName: profileName.trim(),
    stale: mapped?.mappingStale ?? false,
  }, options)
}

export function buildSafeRoleContextInstructionsForProfile(
  profileName: string,
  options: RoleContextOptions = {},
): string {
  try {
    return buildRoleContextForProfile(profileName, options)?.renderedInstructions ?? ''
  } catch (error) {
    console.warn('[assistant-role-context] generation failed', {
      profile: safeLogIdentifier(profileName),
      error: error instanceof Error ? error.name : 'UnknownError',
    })
    return ''
  }
}

function buildBundle(
  role: AssistantRole,
  profileMapping: RoleContextBundle['profileMapping'],
  options: RoleContextOptions,
): RoleContextBundle {
  const recipe = selectRecipe(role.id, options.recipeId)
  const domains = intersectInOrder(role.dataScope.domains, recipe?.domains ?? role.dataScope.domains)
  const sections = SECTION_ORDER.filter(section =>
    role.dataScope.sections.includes(section) && (recipe?.sections ?? role.dataScope.sections).includes(section),
  )
  const query = applyQueryTemplate(recipe?.queryTemplate ?? '{{query}}', options.query ?? '')
  const limits = recipe?.limits ?? DEFAULT_LIMITS
  const appliedScope = { domains, sections, includeProvenance: role.dataScope.includeProvenance }
  const raw = loadSections(domains, sections, query, limits.perSection)
  const sourceRecordIds: RoleContextBundle['sourceRecordIds'] = {}
  const provenance: RoleContextBundle['provenance'] = {}
  const publicSections = emptySections()

  for (const section of SECTION_ORDER) {
    for (const item of raw[section]) {
      publicSections[section].push(item.data)
      if (item.id) (sourceRecordIds[section] ||= []).push(item.id)
      if (role.dataScope.includeProvenance && item.provenance) {
        (provenance[section] ||= []).push(item.provenance)
      }
    }
  }

  const bundle: RoleContextBundle = {
    role,
    profileMapping,
    recipe: recipe ? { id: recipe.id, name: recipe.name } : null,
    generatedAt: new Date().toISOString(),
    query,
    appliedScope,
    appliedLimits: { ...limits },
    sections: emptySections(),
    sourceRecordIds: {},
    provenance: {},
    truncated: { total: false, sections: {} },
    renderedInstructions: '',
  }

  applyCharacterBudget(bundle, publicSections, sourceRecordIds, provenance)
  bundle.renderedInstructions = renderRoleContext(bundle)
  return bundle
}

function selectRecipe(roleId: string, recipeId?: string): ContextRecipe | null {
  const recipes = listContextRecipes(roleId)
  if (recipeId) {
    const selected = recipes.find(recipe => recipe.id === recipeId)
    if (!selected) throw new Error(`Context recipe not found: ${recipeId}`)
    if (!selected.enabled) throw new Error(`Context recipe is disabled: ${recipeId}`)
    return selected
  }
  return recipes.find(recipe => recipe.enabled) ?? null
}

function intersectInOrder<T>(left: T[], right: T[]): T[] {
  const allowed = new Set(right)
  return left.filter(value => allowed.has(value))
}

function applyQueryTemplate(template: string, query: string): string {
  const normalized = query.trim()
  if (!template) return normalized
  return template.replaceAll('{{query}}', normalized).trim()
}

interface LoadedRecord {
  id: string
  data: SectionRecord
  provenance?: RoleContextProvenance
}

function loadSections(
  domains: TwinDomain[],
  sections: TwinContextSection[],
  query: string,
  limit: number,
): Record<TwinContextSection, LoadedRecord[]> {
  const output = Object.fromEntries(SECTION_ORDER.map(section => [section, []])) as unknown as Record<TwinContextSection, LoadedRecord[]>
  if (sections.includes('subject')) {
    const subject = getTwinEntity('person:self')
    if (subject) output.subject.push({
      id: subject.id,
      data: sanitize({ type: subject.type, label: subject.label, attributes: subject.attributes }),
      provenance: provenance(subject.id, subject.source, subject.sourceId),
    })
  }
  if (sections.includes('goals')) output.goals = listTwinGoalsForContext({ domains, query, limit }).map(goal => ({
    id: goal.id,
    data: sanitize({ subjectId: goal.subjectId, domain: goal.domain, title: goal.title, target: goal.target, status: goal.status, priority: goal.priority, startsAt: goal.startsAt, dueAt: goal.dueAt }),
    provenance: provenance(goal.id, goal.source, goal.sourceId),
  }))
  if (sections.includes('constraints')) output.constraints = listTwinConstraintsForContext({ domains, query, limit }).map(item => ({
    id: item.id,
    data: sanitize({ subjectId: item.subjectId, domain: item.domain, key: item.key, value: item.value, enforcement: item.enforcement }),
    provenance: provenance(item.id, item.source, item.sourceId),
  }))
  if (sections.includes('observations')) output.observations = listTwinObservations({ metricPrefixes: domains.map(domain => `${domain}.`), query, limit }).map(item => ({
    id: item.id,
    data: sanitize({ entityId: item.entityId, metric: item.metric, value: item.value, unit: item.unit, observedAt: item.observedAt }),
    provenance: provenance(item.id, item.provenance.source, item.provenance.sourceId, item.provenance),
  }))
  if (sections.includes('events')) output.events = listTwinEvents({ eventTypePrefixes: domains.map(domain => `${domain}.`), query, limit }).map(item => ({
    id: item.id,
    data: sanitize({ eventType: item.eventType, subjectId: item.subjectId, payload: item.payload, occurredAt: item.occurredAt }),
    provenance: provenance(item.id, item.provenance.source, item.provenance.sourceId, item.provenance),
  }))
  if (sections.includes('entities')) output.entities = listTwinEntitiesForContext({ domains, query, limit }).map(item => ({
    id: item.id,
    data: sanitize({ type: item.type, label: item.label, attributes: item.attributes }),
    provenance: provenance(item.id, item.source, item.sourceId),
  }))
  if (sections.includes('relations')) output.relations = listTwinRelationsForContext({ domains, query, limit }).map(item => ({
    id: item.id,
    data: sanitize({ subjectId: item.subjectId, predicate: item.predicate, objectId: item.objectId, attributes: item.attributes, validFrom: item.validFrom, validTo: item.validTo }),
    provenance: provenance(item.id, item.source, item.sourceId),
  }))
  return output
}

function provenance(
  recordId: string,
  source: string,
  sourceId: string,
  fact?: { actor: string; confirmationState: RoleContextProvenance['confirmationState']; confidence: number },
): RoleContextProvenance {
  return {
    recordId, source, sourceId,
    ...(fact ? { actor: fact.actor, confirmationState: fact.confirmationState, confidence: fact.confidence } : {}),
  }
}

function emptySections(): RoleContextSections {
  return Object.fromEntries(SECTION_ORDER.map(section => [section, []])) as unknown as RoleContextSections
}

function applyCharacterBudget(
  bundle: RoleContextBundle,
  available: RoleContextSections,
  ids: RoleContextBundle['sourceRecordIds'],
  provenanceBySection: RoleContextBundle['provenance'],
): void {
  for (const section of SECTION_ORDER) {
    const records = available[section]
    for (let index = 0; index < records.length; index += 1) {
      bundle.sections[section].push(records[index])
      const rendered = renderRoleContext(bundle)
      if (rendered.length > bundle.appliedLimits.totalCharacters) {
        bundle.sections[section].pop()
        bundle.truncated.total = true
        bundle.truncated.sections[section] = true
        break
      }
      const sourceId = ids[section]?.[index]
      if (sourceId) (bundle.sourceRecordIds[section] ||= []).push(sourceId)
      const sourceProvenance = provenanceBySection[section]?.[index]
      if (sourceProvenance) (bundle.provenance[section] ||= []).push(sourceProvenance)
    }
  }
}

export function renderRoleContext(bundle: RoleContextBundle): string {
  const lines = [
    '# Assistant Role Context',
    `Role: ${bundle.role.name} (${bundle.role.id})`,
    `Persona: ${bundle.role.persona}`,
    `Declared capability scope (Phase 2, not enforced): ${stableJson(bundle.role.capabilityScope)}`,
  ]
  for (const section of SECTION_ORDER) {
    if (!bundle.appliedScope.sections.includes(section)) continue
    lines.push('', `## ${section[0].toUpperCase()}${section.slice(1)}`)
    for (const record of bundle.sections[section]) lines.push(stableJson(record))
  }
  return lines.join('\n')
}

function sanitize(value: unknown): SectionRecord {
  return sanitizeValue(value) as SectionRecord
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (isSensitiveKey(key)) continue
    output[key] = sanitizeValue((value as Record<string, unknown>)[key])
  }
  return output
}

function isSensitiveKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const has = (token: string) => tokens.includes(token)
  if (tokens.some(token => ['password', 'passphrase', 'credential', 'secret', 'token', 'authorization', 'authentication'].includes(token))) return true
  if (/password|passphrase|credential/.test(compact)) return true
  if (compact === 'token' || compact.endsWith('token') || compact === 'secret' || compact.endsWith('secret')) return true
  if ((has('private') || has('api') || has('access')) && has('key')) return true
  if (has('auth') && (tokens.length === 1 || has('header') || has('token'))) return true
  if (compact === 'apikey' || compact === 'privatekey' || compact === 'accesskeyid') return true
  if (compact === 'auth' || compact.endsWith('authorization') || compact === 'authentication') return true
  if (compact === 'dsn' || compact === 'connectionstring') return true
  if (has('database') && (has('url') || has('uri') || has('dsn'))) return true
  if (compact === 'databaseurl' || compact === 'databaseuri') return true
  if (compact.endsWith('path') || compact.endsWith('directory')) return true
  if (/^(?:database|sqlite|config|home|root|workspace|storage|data|cache|credential|secret|key|cert|certificate)file$/.test(compact)) return true
  return false
}

function stableJson(value: unknown): string {
  return JSON.stringify(sanitizeValue(value))
}

function safeLogIdentifier(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(value) ? value : '[invalid]'
}
