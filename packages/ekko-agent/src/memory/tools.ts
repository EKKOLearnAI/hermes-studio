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
    description: '搜索当前 profile 的长期记忆。结果包含规范 key、id、revision、value 和 content，可用于准确读取或修改记忆。自动召回已有直接且无冲突的答案时不必重复搜索；否则在询问个人信息、记忆内容，或准备回答“不知道”“不记得”时，应调用本工具核实。已知类别时优先使用 kinds，开放性问题再使用 queryText。',
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
          description: '按一个或多个受控记忆类别精确查询。询问姓名、常住地、关系、偏好、习惯、目标等已知类别时，优先使用本字段，不要依赖自然语言关键词。',
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
  readonly definition = {
    name: 'memory_get',
    description: '根据 id 获取一张完整记忆卡片，包括服务端生成的规范 key 和当前 revision。',
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
      '创建或按 revision 校验并修改持久记忆。创建时提供受控 kind 和可选 itemKey；' +
      '服务端会生成规范 key，并对同一槽位自动执行 noop 或替换 active 值。' +
      '执行 update/supersede 前先搜索或读取卡片，再提供 targetId 和 expectedRevision；服务端会保留原 key。' +
      '修改对象字段时使用 valuePatch/unsetValueFields。绝不能自行编造或提交 key。' +
      '只保存跨会话仍有用的持久状态，不保存临时请求或撤回历史；旧记忆失效且没有持久替代值时，应精确忘记旧记忆。'
    ),
    parameters: {
      type: 'object',
      required: ['operation', 'reason'],
      properties: {
        operation: { type: 'string', enum: ['create', 'update', 'supersede', 'expire', 'delete'] },
        kind: { type: 'string', enum: [...MEMORY_KINDS], description: '创建记忆时必填。服务端会把受控 kind 映射为规范 key。' },
        itemKey: { type: 'string', description: '条目化 kind 必填的稳定概念或实体标识，例如偏好维度或实体名称。' },
        targetId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1, description: '执行 update、supersede、expire 或 delete 时必填。' },
        node: {
          type: 'object',
          properties: {
            valueJson: { description: '可选的结构化值或标量值。必须使用 valueJson 这个字段名，不能写成 value。' },
            title: { type: 'string', description: '简短、便于理解的记忆标题。' },
            content: { type: 'string', description: '完整、独立的持久记忆陈述。' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            tags: { type: 'array', items: { type: 'string' } },
            entities: { type: 'array', items: { type: 'string' } },
            expiresAt: { type: 'string', description: '可选的 ISO-8601 过期时间。' },
          },
          additionalProperties: false,
        },
        valuePatch: { type: 'object', description: '要设置的对象字段；当前值中未指定的字段会保留。' },
        unsetValueFields: { type: 'array', items: { type: 'string' }, description: '要移除的对象字段，不会删除整条记忆。' },
        reason: { type: 'string' },
        explicitUserIntent: {
          type: 'boolean',
          description: '只有用户明确要求记住、更改、纠正或删除持久信息时，才设置为 true。',
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
    description: '使用 id 和 expectedRevision 删除记忆。精确软删除可立即执行；宽泛删除或硬删除需要确认。',
    parameters: {
      type: 'object',
      required: ['reason'],
      properties: {
        id: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1, description: '按 id 删除时必填。' },
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
