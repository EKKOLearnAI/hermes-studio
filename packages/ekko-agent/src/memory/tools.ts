import type { AgentTool, AgentToolContext, AgentToolResult } from '../tools/types'
import { memorySlotForKind } from './schema'
import { normalizeMemoryScope } from './scope'
import { MEMORY_KINDS, type MemoryForgetInput, type MemoryNode, type MemoryProposeUpdateInput, type MemoryQuery, type MemoryRuntimeIdentity } from './types'
import type { MemoryService } from './service'

const ITEMIZED_MEMORY_KINDS = MEMORY_KINDS.filter(kind => memorySlotForKind(kind).itemized)
const ITEMIZED_MEMORY_KIND_LIST = ITEMIZED_MEMORY_KINDS.join(', ')

export function createMemoryTools(
  service: MemoryService,
  options: { writable?: boolean; reviewable?: boolean; forgetReviewable?: boolean } = {},
): AgentTool[] {
  const tools: AgentTool[] = [
    new MemorySearchTool(service),
    new MemoryGetTool(service),
  ]
  if (options.reviewable === true) tools.push(new MemoryReviewTool())
  if (options.writable !== false) {
    tools.push(new MemoryProposeUpdateTool(service), new MemoryForgetTool(service))
  } else if (options.forgetReviewable === true) {
    tools.push(new MemoryForgetTool(service, true))
  }
  return tools
}

class MemoryReviewTool implements AgentTool {
  readonly definition = {
    name: 'memory_review',
    description: 'Request an immediate isolated memory review of the current host-selected conversation evidence. Call this exactly once when the user asks to remember, correct, update, or forget durable information, or when the current turn contains a clearly useful durable memory candidate. This tool does not accept memory content and cannot write memory directly.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  }

  async execute(_input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    if (!context?.sessionId) return failure('memory_review requires a sessionId.')
    if (context.memoryReviewPolicy === 'explicit-only' && context.memoryExplicitIntent !== true) {
      return failure('This host allows memory review only when the current user explicitly asks to remember, update, or forget something.')
    }
    if (!context.requestMemoryReview) return failure('Memory review is not available in this runtime context.')
    const queued = await context.requestMemoryReview({ trigger: 'review' })
    return success(
      { requested: true, queued: true, ...queued },
      'Memory review was queued and started asynchronously. Continue the current run without waiting, re-checking memory, or attempting another mutation path.',
    )
  }
}

class MemorySearchTool implements AgentTool {
  readonly concurrency = 'parallel' as const

  readonly definition = {
    name: 'memory_search',
    description: 'Search memory in the host-authorized recall scopes. Results include the canonical key, scope, id, revision, value, and content required for precise mutations. Do not search again when automatic recall already contains a direct, conflict-free answer. Otherwise, use this tool to verify remembered information or before saying that you do not know or remember. Prefer kinds for known categories and queryText for open-ended questions.',
    parameters: {
      type: 'object',
      properties: {
        queryText: { type: 'string' },
        domain: { type: 'string' },
        categoryPathPrefix: { type: 'array', items: { type: 'string' } },
        types: { type: 'array', items: { type: 'string' } },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: [...MEMORY_KINDS] },
          description: 'Query one or more controlled memory kinds exactly. Prefer this field over natural-language keywords for known categories such as name, home location, relationships, preferences, habits, or goals.',
        },
        key: { type: 'string' },
        valueJson: {},
        tags: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  }

  constructor(private readonly service: MemoryService) {}

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const identity = runtimeIdentity(context)
    if (!identity) return failure('memory_search requires a sessionId.')
    const query: MemoryQuery = {
      queryText: optionalString(input.queryText),
      domain: optionalString(input.domain),
      categoryPathPrefix: stringArray(input.categoryPathPrefix),
      types: stringArray(input.types) as MemoryNode['type'][] | undefined,
      kinds: validMemoryKinds(input.kinds),
      key: optionalString(input.key),
      valueJson: input.valueJson,
      tags: stringArray(input.tags),
      entities: stringArray(input.entities),
      limit: optionalNumber(input.limit),
    }
    const result = await this.service.search(identity, query)
    return success(result)
  }
}

function validMemoryKinds(value: unknown): MemoryQuery['kinds'] {
  const allowed = new Set<string>(MEMORY_KINDS)
  return stringArray(value)?.filter(kind => allowed.has(kind)) as MemoryQuery['kinds']
}

class MemoryGetTool implements AgentTool {
  readonly concurrency = 'parallel' as const

  readonly definition = {
    name: 'memory_get',
    description: 'Get one complete memory card by id, including its server canonical key and current revision.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        domain: { type: 'string' },
        type: { type: 'string' },
        key: { type: 'string' },
        valueJson: {},
      },
      additionalProperties: false,
    },
  }

  constructor(private readonly service: MemoryService) {}

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const id = optionalString(input.id)
    const identity = runtimeIdentity(context)
    if (id) {
      if (!identity) return failure('memory_get requires a sessionId.')
      return success(await this.service.get(id, identity))
    }
    if (!identity) return failure('memory_get requires a sessionId.')
    const result = await this.service.search(identity, {
      domain: optionalString(input.domain),
      types: optionalString(input.type) ? [optionalString(input.type)! as MemoryNode['type']] : undefined,
      key: optionalString(input.key),
      valueJson: input.valueJson,
      limit: 2,
    })
    const matches = [...result.exact, ...result.relevant]
    return success(matches.length === 1 ? matches[0] : undefined, matches.length > 1 ? 'Multiple memories matched.' : undefined)
  }
}

class MemoryProposeUpdateTool implements AgentTool {
  readonly definition = {
    name: 'memory_propose_update',
    description: (
      'Create or revision-check a durable memory. For create, provide a controlled kind. itemKey is REQUIRED for every itemized kind ' +
      `(${ITEMIZED_MEMORY_KIND_LIST}) and must be a short stable identifier; for example, project_context for Hermes Studio requires itemKey="hermes_studio". ` +
      'Single-slot kinds do not require itemKey. ' +
      'the server generates the canonical key and automatically noops or replaces the active value in that slot. ' +
      'For update/supersede, first search/get, then provide targetId and expectedRevision; the server preserves the key. ' +
      'Use valuePatch/unsetValueFields for object fields. Never invent or submit a key. ' +
      'Persist only durable state appropriate to an authorized scope, not transient requests or retraction history; forget an exact invalidated memory when no durable replacement remains.'
    ),
    parameters: {
      type: 'object',
      required: ['operation', 'reason'],
      properties: {
        operation: {
          type: 'string',
          enum: ['create', 'update', 'supersede', 'expire', 'delete'],
          description: 'create requires kind and node; every other operation requires targetId and expectedRevision from memory_search or memory_get.',
        },
        kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'REQUIRED for operation=create. Server maps this controlled kind to a canonical key.' },
        itemKey: {
          type: 'string',
          description: `CONDITIONALLY REQUIRED for operation=create when kind is one of: ${ITEMIZED_MEMORY_KIND_LIST}. Use a short stable concept/entity identifier, never a sentence, timestamp, or random value. Example: kind=project_context, itemKey=hermes_studio.`,
        },
        scope: {
          type: 'object',
          description: 'Required for create. Select one of the host-provided writable scopes exactly.',
          properties: {
            type: { type: 'string', enum: ['profile', 'context', 'session'] },
            namespace: { type: 'string' },
            id: { type: 'string' },
          },
          required: ['type'],
          additionalProperties: false,
        },
        targetId: { type: 'string', description: 'REQUIRED for update, supersede, expire, and delete. Copy the exact id returned by memory_search or memory_get.' },
        expectedRevision: { type: 'integer', minimum: 1, description: 'REQUIRED for update, supersede, expire, and delete. Copy the current revision returned by memory_search or memory_get.' },
        node: {
          type: 'object',
          description: 'REQUIRED for create. title and content are required; include valueJson when the durable fact has a scalar or structured value.',
          properties: {
            valueJson: { description: 'Optional structured or scalar value. Use this exact field name, not value.' },
            title: { type: 'string', description: 'Short memory title in the language of the cited user evidence.' },
            content: { type: 'string', description: 'Complete durable statement in the language of the cited user evidence.' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            tags: { type: 'array', items: { type: 'string' } },
            entities: { type: 'array', items: { type: 'string' } },
            sourceMessageIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of the user-authored transcript messages that directly support this memory. Every id must come from the host-provided review transcript.',
            },
            expiresAt: { type: 'string', description: 'Optional ISO-8601 expiration timestamp.' },
          },
          additionalProperties: false,
        },
        valuePatch: { type: 'object', description: 'Object fields to set while preserving unspecified fields in the current value.' },
        unsetValueFields: { type: 'array', items: { type: 'string' }, description: 'Object fields to remove without deleting the whole memory.' },
        reason: { type: 'string', description: 'Mutation reason in the language of the user evidence supporting this change.' },
        explicitUserIntent: {
          type: 'boolean',
          description: 'Set true only when the user clearly asked to remember, change, correct, or delete durable information.',
        },
      },
      additionalProperties: false,
    },
  }

  constructor(private readonly service: MemoryService) {}

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const identity = runtimeIdentity(context)
    if (!identity) return failure('memory_propose_update requires a sessionId.')
    if (context?.memoryReviewPolicy === 'explicit-only' && context.memoryExplicitIntent !== true) {
      return failure('This host allows memory writes only when the current user explicitly asks to remember, update, or forget something.')
    }
    const operation = optionalString(input.operation) as MemoryProposeUpdateInput['operation'] | undefined
    const reason = optionalString(input.reason)
    if (!operation || !reason) return failure('operation and reason are required.')
    const rawKind = optionalString(input.kind)
    const kind = rawKind && (MEMORY_KINDS as readonly string[]).includes(rawKind)
      ? rawKind as MemoryProposeUpdateInput['kind']
      : undefined
    const itemKey = optionalString(input.itemKey)
    if (operation === 'create' && !kind) {
      return failure(`create requires kind to be one of: ${MEMORY_KINDS.join(', ')}.`)
    }
    if (operation === 'create' && kind && memorySlotForKind(kind).itemized && !itemKey) {
      return failure(
        `itemKey is required when operation=create and kind=${kind}. Retry this tool call with a short stable identifier; ` +
        'for example, project_context for Hermes Studio uses itemKey="hermes_studio".',
      )
    }
    const rawNode = input.node && typeof input.node === 'object' && !Array.isArray(input.node)
      ? input.node as Record<string, unknown>
      : {}
    if (operation === 'create' && !input.node) {
      return failure('create requires node with title, content, and the durable valueJson when applicable.')
    }
    if (operation !== 'create') {
      const targetId = optionalString(input.targetId)
      const expectedRevision = optionalNumber(input.expectedRevision)
      if (!targetId) return failure(`${operation} requires targetId from memory_search or memory_get.`)
      if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1) {
        return failure(`${operation} requires expectedRevision from memory_search or memory_get.`)
      }
    }
    const node = normalizeToolMemoryNode(rawNode)
    const allowedSourceMessageIds = uniqueStrings(context?.sourceMessageIds || [])
    const requestedSourceMessageIds = uniqueStrings(node.sourceMessageIds || [])
    if (requestedSourceMessageIds.some(id => !allowedSourceMessageIds.includes(id))) {
      return failure('Memory sourceMessageIds must be selected from the host-provided user evidence.')
    }
    node.sourceMessageIds = requestedSourceMessageIds.length ? requestedSourceMessageIds : allowedSourceMessageIds
    const explicitUserIntent = input.explicitUserIntent === true
    const result = await this.service.proposeUpdate({
      operation,
      kind,
      itemKey,
      scope: normalizeMemoryScope(input.scope) || context?.memoryDefaultWriteScope,
      targetId: optionalString(input.targetId),
      expectedRevision: optionalNumber(input.expectedRevision),
      valuePatch: recordValue(input.valuePatch),
      unsetValueFields: stringArray(input.unsetValueFields),
      node,
      reason,
      explicitUserIntent,
      identity,
      actor: 'ekko-agent-tool',
    })
    return result.accepted ? success(result) : failure(result.reason || 'Memory update was rejected.', result)
  }
}

class MemoryForgetTool implements AgentTool {
  readonly definition: AgentTool['definition']

  constructor(
    private readonly service: MemoryService,
    private readonly reviewOnly = false,
  ) {
    this.definition = {
      name: 'memory_forget',
      description: reviewOnly
        ? 'Queue one explicit memory deletion for immediate isolated review. Use all=true once when the user explicitly asks to forget every authorized memory; use targets for multiple resolved id/revision pairs; otherwise resolve one target with memory_search/get. Never make multiple memory_forget calls. This foreground tool never writes the database directly.'
        : 'Delete memory once by all authorized memories, multiple exact targets, one id/revision, or a broad selector. Multiple or hard deletion requires confirmation.',
      parameters: {
        type: 'object',
        required: ['reason'],
        properties: {
          all: { type: 'boolean', description: 'Delete every memory visible in the host-authorized scopes. Use only for an explicit forget-all request.' },
          targets: {
            type: 'array',
            description: 'Multiple exact cards to delete in one operation. Never split these into multiple memory_forget calls.',
            items: {
              type: 'object',
              required: ['id', 'expectedRevision'],
              properties: {
                id: { type: 'string' },
                expectedRevision: { type: 'integer', minimum: 1 },
              },
              additionalProperties: false,
            },
          },
          id: { type: 'string' },
          expectedRevision: { type: 'integer', minimum: 1, description: 'Required when deleting by id.' },
          domain: { type: 'string' },
          categoryPathPrefix: { type: 'array', items: { type: 'string' } },
          type: { type: 'string' },
          key: { type: 'string' },
          valueJson: {},
          mode: { type: 'string', enum: ['soft', 'hard'] },
          reason: { type: 'string' },
          confirmed: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    }
  }

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const identity = runtimeIdentity(context)
    if (!identity) return failure('memory_forget requires a sessionId.')
    if (context?.memoryReviewPolicy === 'explicit-only' && context.memoryExplicitIntent !== true) {
      return failure('This host allows memory deletion only when the current user explicitly asks to forget or change something.')
    }
    if (this.reviewOnly && context?.memoryForgetIntent !== true) {
      return failure('Foreground memory deletion requires an explicit forget or change request from the current user.')
    }
    const reason = optionalString(input.reason)
    if (!reason) return failure('reason is required.')
    const forgetAll = input.all === true || (this.reviewOnly && context?.memoryForgetAllIntent === true)
    if (this.reviewOnly && input.all === true && context?.memoryForgetAllIntent !== true) {
      return failure('all=true requires an explicit request from the current user to forget every memory.')
    }
    const targets = forgetAll ? undefined : forgetTargets(input.targets)
    const request: MemoryForgetInput = {
      all: forgetAll || undefined,
      targets,
      id: forgetAll ? undefined : optionalString(input.id),
      expectedRevision: forgetAll ? undefined : optionalNumber(input.expectedRevision),
      domain: forgetAll ? undefined : optionalString(input.domain),
      categoryPathPrefix: forgetAll ? undefined : stringArray(input.categoryPathPrefix),
      type: forgetAll ? undefined : optionalString(input.type) as MemoryNode['type'] | undefined,
      key: forgetAll ? undefined : optionalString(input.key),
      valueJson: forgetAll ? undefined : input.valueJson,
      mode: optionalString(input.mode) as 'soft' | 'hard' | undefined,
      reason,
      confirmed: input.confirmed === true || (forgetAll && context?.memoryForgetAllIntent === true),
      identity,
      actor: 'ekko-agent-tool',
    }
    if (this.reviewOnly) {
      if (!context?.requestMemoryReview) return failure('Memory review is not available in this runtime context.')
      const queued = await context.requestMemoryReview({
        trigger: 'forget',
        forget: {
          all: request.all,
          targets: request.targets,
          id: request.id,
          expectedRevision: request.expectedRevision,
          domain: request.domain,
          categoryPathPrefix: request.categoryPathPrefix,
          type: request.type,
          key: request.key,
          valueJson: request.valueJson,
          mode: request.mode,
          reason: request.reason,
          confirmed: request.confirmed,
        },
      })
      return success(
        { requested: true, queued: true, operation: 'forget', ...queued },
        'Memory deletion was queued for isolated review. Continue the current run without waiting, re-checking memory, calling application APIs, or using the shell to mutate memory.',
      )
    }
    const result = await this.service.forget(request)
    if (result.requiresConfirmation) return failure(result.reason || 'Confirmation required.', result)
    return success(result)
  }
}

function runtimeIdentity(context?: AgentToolContext): MemoryRuntimeIdentity | undefined {
  if (!context?.sessionId) return undefined
  return {
    sessionId: context.sessionId,
    profileId: context.profileId || 'default',
    origin: context.memoryOrigin,
    recallScopes: context.memoryRecallScopes,
    writeScopes: context.memoryWriteScopes,
    defaultWriteScope: context.memoryDefaultWriteScope,
  }
}

function success(data: unknown, note?: string): AgentToolResult {
  return { ok: true, content: note || JSON.stringify(data ?? null), data }
}

function failure(message: string, data?: unknown): AgentToolResult {
  return { ok: false, content: message, error: message, data }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(item => String(item).trim()).filter(Boolean)
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function forgetTargets(value: unknown): Array<{ id: string; expectedRevision: number }> | undefined {
  if (!Array.isArray(value)) return undefined
  const targets = value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const id = optionalString(record.id)
    const expectedRevision = optionalNumber(record.expectedRevision)
    return id && Number.isInteger(expectedRevision) && Number(expectedRevision) >= 1
      ? [{ id, expectedRevision: Number(expectedRevision) }]
      : []
  })
  return targets.length ? targets : undefined
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))]
}

function normalizeToolMemoryNode(input: Record<string, unknown>): Partial<MemoryNode> {
  const node = { ...input }
  const typeAliases: Record<string, MemoryNode['type']> = {
    user_preference: 'preference',
    user_fact: 'fact',
    user_constraint: 'constraint',
    todo: 'task',
  }
  const rawType = optionalString(node.type)
  if (rawType && typeAliases[rawType]) node.type = typeAliases[rawType]
  if (node.valueJson === undefined && Object.prototype.hasOwnProperty.call(node, 'value')) {
    node.valueJson = node.value
  }
  const summary = optionalString(node.summary) || optionalString(node.description)
  if (!optionalString(node.content) && summary) node.content = summary
  return node as Partial<MemoryNode>
}
