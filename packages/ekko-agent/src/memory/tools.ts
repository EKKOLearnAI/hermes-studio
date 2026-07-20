import type { AgentTool, AgentToolContext, AgentToolResult } from '../tools/types'
import { MEMORY_KINDS, type MemoryForgetInput, type MemoryNode, type MemoryProposeUpdateInput, type MemoryQuery, type MemoryRuntimeIdentity } from './types'
import type { MemoryService } from './service'

export function createMemoryTools(service: MemoryService): AgentTool[] {
  return [
    new MemorySearchTool(service),
    new MemoryGetTool(service),
    new MemoryProposeUpdateTool(service),
    new MemoryForgetTool(service),
  ]
}

class MemorySearchTool implements AgentTool {
  readonly definition = {
    name: 'memory_search',
    description: 'Search current profile memory. Results include the canonical key, id, revision, value, and content required for precise mutations.',
    parameters: {
      type: 'object',
      properties: {
        queryText: { type: 'string' },
        domain: { type: 'string' },
        categoryPathPrefix: { type: 'array', items: { type: 'string' } },
        types: { type: 'array', items: { type: 'string' } },
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

class MemoryGetTool implements AgentTool {
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
      'Create or revision-check a durable memory. For create, provide a controlled kind and optional itemKey; ' +
      'the server generates the canonical key and automatically noops or replaces the active value in that slot. ' +
      'For update/supersede, first search/get, then provide targetId and expectedRevision; the server preserves the key. ' +
      'Use valuePatch/unsetValueFields for object fields. Never invent or submit a key. ' +
      'Persist only cross-session durable state, not transient requests or retraction history; forget an exact invalidated memory when no durable replacement remains.'
    ),
    parameters: {
      type: 'object',
      required: ['operation', 'reason'],
      properties: {
        operation: { type: 'string', enum: ['create', 'update', 'supersede', 'expire', 'delete'] },
        kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'Required for create. Server maps this controlled kind to a canonical key.' },
        itemKey: { type: 'string', description: 'Stable concept/entity discriminator required for itemized kinds, such as a preference dimension or entity name.' },
        targetId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1, description: 'Required for update, supersede, expire, and delete.' },
        node: {
          type: 'object',
          properties: {
            valueJson: { description: 'Optional structured or scalar value. Use this exact field name, not value.' },
            title: { type: 'string', description: 'Short human-readable memory title.' },
            content: { type: 'string', description: 'Complete durable memory statement.' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            tags: { type: 'array', items: { type: 'string' } },
            entities: { type: 'array', items: { type: 'string' } },
            expiresAt: { type: 'string', description: 'Optional ISO-8601 expiration timestamp.' },
          },
          additionalProperties: false,
        },
        valuePatch: { type: 'object', description: 'Object fields to set while preserving unspecified fields in the current value.' },
        unsetValueFields: { type: 'array', items: { type: 'string' }, description: 'Object fields to remove without deleting the whole memory.' },
        reason: { type: 'string' },
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
    const operation = optionalString(input.operation) as MemoryProposeUpdateInput['operation'] | undefined
    const reason = optionalString(input.reason)
    if (!operation || !reason) return failure('operation and reason are required.')
    const rawNode = input.node && typeof input.node === 'object' && !Array.isArray(input.node)
      ? input.node as Record<string, unknown>
      : {}
    if (operation === 'create' && !input.node) return failure('create requires node.')
    const node = normalizeToolMemoryNode(rawNode)
    node.sourceMessageIds = uniqueStrings(context?.sourceMessageIds || [])
    const explicitUserIntent = input.explicitUserIntent === true
    const result = await this.service.proposeUpdate({
      operation,
      kind: optionalString(input.kind) as MemoryProposeUpdateInput['kind'],
      itemKey: optionalString(input.itemKey),
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
  readonly definition = {
    name: 'memory_forget',
    description: 'Delete memory by id and expectedRevision. Exact soft deletion is immediate; broad or hard deletion requires confirmation.',
    parameters: {
      type: 'object',
      required: ['reason'],
      properties: {
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

  constructor(private readonly service: MemoryService) {}

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const identity = runtimeIdentity(context)
    if (!identity) return failure('memory_forget requires a sessionId.')
    const reason = optionalString(input.reason)
    if (!reason) return failure('reason is required.')
    const request: MemoryForgetInput = {
      id: optionalString(input.id),
      expectedRevision: optionalNumber(input.expectedRevision),
      domain: optionalString(input.domain),
      categoryPathPrefix: stringArray(input.categoryPathPrefix),
      type: optionalString(input.type) as MemoryNode['type'] | undefined,
      key: optionalString(input.key),
      valueJson: input.valueJson,
      mode: optionalString(input.mode) as 'soft' | 'hard' | undefined,
      reason,
      confirmed: input.confirmed === true,
      identity,
      actor: 'ekko-agent-tool',
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
  if (!optionalString(node.title)) {
    const key = optionalString(node.key)?.replaceAll('_', ' ')
    const value = typeof node.valueJson === 'string' ? node.valueJson : undefined
    node.title = truncateTitle([key, value].filter(Boolean).join(': ') || summary || optionalString(node.content) || 'Memory')
  }
  return node as Partial<MemoryNode>
}

function truncateTitle(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 79)}…`
}
