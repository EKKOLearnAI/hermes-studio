import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openapi } from '../../packages/server/src/controllers/api-docs'

describe('api docs controller', () => {
  it('returns the OpenAPI route catalog', async () => {
    const ctx = {
      set: vi.fn(),
      status: 200,
      body: undefined as any,
    }

    await openapi(ctx as any)

    expect(ctx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(ctx.body.openapi).toBe('3.0.3')
    expect(ctx.body.paths['/api/openapi.json']).toBeTruthy()
    expect(ctx.body.paths['/api/auth/login'].post.requestBody.content['application/json'].schema.required).toEqual([
      'password',
      'username',
    ])
    expect(ctx.body.paths['/api/auth/users/{id}'].put.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    ])
    expect(ctx.body.paths['/api/hermes/kanban/search-sessions'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'task_id', in: 'query', required: true }),
        expect.objectContaining({ name: 'profile', in: 'query', required: true }),
        expect.objectContaining({ name: 'q', in: 'query', required: false }),
      ]),
    )
    expect(
      ctx.body.paths['/api/chat-run/runs'].post.requestBody.content['application/json'].schema.properties.source.enum,
    ).toEqual(['cli', 'coding_agent', 'global_agent'])
    expect(ctx.body.paths['/api/hermes/personal-twin/overview'].get.tags).toEqual(['Personal Twin'])
    expect(
      ctx.body.paths['/api/hermes/personal-twin/imports/legacy'].post.requestBody.content['application/json'].schema.properties.profiles,
    ).toEqual({ type: 'array', items: { type: 'string' } })
    expect(ctx.body.paths['/api/hermes/personal-twin/entities'].get.parameters).toEqual([
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'source', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'type', in: 'query', required: false, schema: { type: 'string' } },
    ])
    expect(ctx.body.paths['/api/hermes/personal-twin/observations'].get.parameters).toEqual([
      { name: 'entityId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'metric', in: 'query', required: false, schema: { type: 'string' } },
    ])
    expect(ctx.body.paths['/api/hermes/personal-twin/events'].get.parameters).toEqual([
      { name: 'eventType', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'subjectId', in: 'query', required: false, schema: { type: 'string' } },
    ])
    expect(ctx.body.paths['/api/hermes/personal-twin/context'].get.parameters).toEqual([
      { name: 'domains', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'query', in: 'query', required: false, schema: { type: 'string' } },
    ])

    const assistantRolePaths = {
      '/api/hermes/assistant-roles': ['get', 'post'],
      '/api/hermes/assistant-roles/{id}': ['get', 'put', 'delete'],
      '/api/hermes/assistant-roles/{id}/clone': ['post'],
      '/api/hermes/assistant-roles/{id}/profile-mapping': ['put'],
      '/api/hermes/assistant-roles/{id}/context/preview': ['post'],
      '/api/hermes/assistant-roles/{id}/context-recipes': ['get', 'post'],
      '/api/hermes/assistant-roles/{id}/context-recipes/{recipeId}': ['put', 'delete'],
    } as const
    const assistantRoleOperations = Object.entries(assistantRolePaths).flatMap(([path, methods]) =>
      methods.map(method => ctx.body.paths[path]?.[method]),
    )
    expect(assistantRoleOperations).toHaveLength(12)
    expect(assistantRoleOperations.every(Boolean)).toBe(true)
    expect(assistantRoleOperations.every(operation => operation.tags[0] === 'Assistant Roles')).toBe(true)
    expect(ctx.body.tags).toContainEqual(expect.objectContaining({ name: 'Personal Twin' }))
    expect(ctx.body.tags).toContainEqual(expect.objectContaining({ name: 'Assistant Roles' }))

    const actionFabricPaths = {
      '/api/hermes/action-fabric/capabilities': ['get'],
      '/api/hermes/action-fabric/executors': ['get'],
      '/api/hermes/action-fabric/intents': ['post'],
      '/api/hermes/action-fabric/workflows': ['get'],
      '/api/hermes/action-fabric/workflows/{id}': ['get'],
      '/api/hermes/action-fabric/workflows/{id}/approve': ['post'],
      '/api/hermes/action-fabric/workflows/{id}/reject': ['post'],
      '/api/hermes/action-fabric/workflows/{id}/cancel': ['post'],
      '/api/hermes/action-fabric/workflows/{id}/retry': ['post'],
      '/api/hermes/action-fabric/workflows/{id}/compensate': ['post'],
      '/api/hermes/action-fabric/audit': ['get'],
      '/api/hermes/action-fabric/audit/verify': ['get'],
      '/api/hermes/action-fabric/control': ['get'],
      '/api/hermes/action-fabric/control/emergency-stop': ['put'],
    } as const
    const actionFabricOperations = Object.entries(actionFabricPaths).flatMap(([path, methods]) =>
      methods.map(method => ctx.body.paths[path]?.[method]),
    )
    expect(actionFabricOperations).toHaveLength(14)
    expect(actionFabricOperations.every(Boolean)).toBe(true)
    expect(actionFabricOperations.every(operation => operation.tags[0] === 'Action Fabric')).toBe(true)
    expect(ctx.body.tags).toContainEqual(expect.objectContaining({ name: 'Action Fabric' }))

    const capabilities = ctx.body.paths['/api/hermes/action-fabric/capabilities'].get
    expect(capabilities.parameters).toEqual([
      { name: 'domain', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'enabled', in: 'query', required: false, schema: { type: 'boolean' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'risk', in: 'query', required: false, schema: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'critical'] } },
    ])
    expect(ctx.body.paths['/api/hermes/action-fabric/executors'].get.parameters).toEqual([
      { name: 'enabled', in: 'query', required: false, schema: { type: 'boolean' } },
      { name: 'environment', in: 'query', required: false, schema: { type: 'string', enum: ['simulator', 'internal', 'sandbox', 'production'] } },
      { name: 'health', in: 'query', required: false, schema: { type: 'string', enum: ['unknown', 'healthy', 'degraded', 'unhealthy'] } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['simulator', 'internal'] } },
    ])
    expect(ctx.body.paths['/api/hermes/action-fabric/workflows'].get.parameters).toEqual([
      { name: 'capabilityId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'requestedByRoleId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'requestedByUserId', in: 'query', required: false, schema: { type: 'string' } },
      expect.objectContaining({ name: 'state', in: 'query', required: false, schema: expect.objectContaining({ type: 'string', enum: expect.arrayContaining(['waiting_user', 'succeeded', 'failed']) }) }),
    ])
    expect(ctx.body.paths['/api/hermes/action-fabric/audit'].get.parameters).toEqual([
      { name: 'afterSequence', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'aggregateId', in: 'query', required: false, schema: { type: 'string' } },
      expect.objectContaining({ name: 'aggregateType', in: 'query', required: false, schema: { type: 'string', enum: ['capability', 'executor', 'intent', 'workflow', 'control', 'system'] } }),
      { name: 'eventType', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
    ])
    for (const suffix of ['', '/approve', '/reject', '/cancel', '/retry', '/compensate']) {
      const operation = ctx.body.paths[`/api/hermes/action-fabric/workflows/{id}${suffix}`][suffix ? 'post' : 'get']
      expect(operation.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }])
    }

    const intentBody = ctx.body.paths['/api/hermes/action-fabric/intents'].post.requestBody.content['application/json'].schema
    expect(intentBody.required).toEqual([
      'capabilityId', 'constraints', 'goal', 'idempotencyKey', 'input', 'rationale', 'requestedByRoleId', 'target',
    ])
    expect(intentBody.properties).toEqual(expect.objectContaining({
      capabilityId: { type: 'string' },
      requestedByRoleId: { type: 'string' },
      idempotencyKey: { type: 'string' },
      goal: { type: 'string' },
      target: { type: 'object', additionalProperties: true },
      input: { type: 'object', additionalProperties: true },
      constraints: { type: 'object', additionalProperties: true },
      rationale: { type: 'string' },
      expectedCost: { $ref: '#/components/schemas/ActionFabricMoney' },
    }))
    expect(ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/reject'].post.requestBody.content['application/json'].schema).toEqual({
      type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false,
    })
    for (const action of ['reject', 'cancel', 'compensate']) {
      expect(ctx.body.paths[`/api/hermes/action-fabric/workflows/{id}/${action}`].post.requestBody.content['application/json'].schema).toEqual({
        type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false,
      })
    }
    for (const action of ['approve', 'retry']) {
      expect(ctx.body.paths[`/api/hermes/action-fabric/workflows/{id}/${action}`].post.requestBody.content['application/json'].schema).toEqual({
        type: 'object', properties: {}, additionalProperties: false,
      })
    }
    for (const operation of actionFabricOperations.filter(operation => operation.operationId !== 'createIntent'
      && !['approveWorkflow', 'rejectWorkflow', 'cancelWorkflow', 'retryWorkflow', 'compensateWorkflow', 'updateEmergencyStop'].includes(operation.operationId))) {
      expect(operation.requestBody).toBeUndefined()
    }
    expect(ctx.body.paths['/api/hermes/action-fabric/control/emergency-stop'].put.requestBody.content['application/json'].schema).toEqual({
      type: 'object',
      properties: {
        expectedVersion: { type: 'integer' },
        level: { type: 'integer', minimum: 0, maximum: 3 },
        reason: { type: 'string' },
      },
      required: ['expectedVersion', 'level', 'reason'],
      additionalProperties: false,
    })

    const successSchemas = new Map([
      [capabilities, 'ActionFabricCapabilityListResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/executors'].get, 'ActionFabricExecutorListResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/intents'].post, 'ActionFabricIntentResult'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows'].get, 'ActionFabricWorkflowListResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}'].get, 'ActionFabricWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/approve'].post, 'ActionFabricWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/reject'].post, 'ActionFabricWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/cancel'].post, 'ActionFabricWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/retry'].post, 'ActionFabricWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/compensate'].post, 'ActionFabricWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/audit'].get, 'ActionFabricAuditListResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/audit/verify'].get, 'ActionFabricAuditVerificationResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/control'].get, 'ActionFabricControlResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/control/emergency-stop'].put, 'ActionFabricControlResponse'],
    ])
    for (const [operation, schemaName] of successSchemas) {
      expect(operation.responses['200'].content['application/json'].schema).toEqual({ $ref: `#/components/schemas/${schemaName}` })
    }
    for (const operation of actionFabricOperations) {
      expect(operation.responses['400'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/ActionFabricError' })
      expect(operation.responses['500'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/ActionFabricError' })
    }
    expect(ctx.body.components.schemas.ActionFabricAvailableActions).toEqual(expect.objectContaining({
      type: 'object',
      properties: {
        approve: { type: 'boolean' }, reject: { type: 'boolean' }, cancel: { type: 'boolean' },
        retry: { type: 'boolean' }, compensate: { type: 'boolean' },
      },
      required: ['approve', 'reject', 'cancel', 'retry', 'compensate'],
      additionalProperties: false,
    }))
    expect(ctx.body.components.schemas.ActionFabricControl).toEqual(expect.objectContaining({
      required: ['level', 'version', 'actorUserId', 'reason', 'updatedAt'], additionalProperties: false,
    }))
    expect(ctx.body.components.schemas.ActionFabricWorkflowListResponse.properties.nextCursor).toEqual({ type: 'string', nullable: true })
    expect(ctx.body.components.schemas.ActionFabricAuditListResponse.properties).toEqual(expect.objectContaining({
      events: { type: 'array', items: { $ref: '#/components/schemas/ActionFabricAuditEvent' } },
      nextAfterSequence: { type: 'integer', nullable: true },
    }))

    expect(ctx.body.paths['/api/hermes/assistant-roles/{id}'].put.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true, schema: { type: 'string' } }),
    ])
    expect(ctx.body.paths['/api/hermes/assistant-roles/{id}/context-recipes/{recipeId}'].put.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true, schema: { type: 'string' } }),
      expect.objectContaining({ name: 'recipeId', in: 'path', required: true, schema: { type: 'string' } }),
    ])

    const roleSchema = ctx.body.paths['/api/hermes/assistant-roles'].post.requestBody.content['application/json'].schema
    expect(roleSchema.required).toEqual(expect.arrayContaining(['name', 'persona', 'dataScope', 'capabilityScope', 'memoryNamespace']))
    expect(roleSchema.properties.dataScope).toEqual(expect.objectContaining({
      type: 'object',
      properties: expect.objectContaining({
        domains: { type: 'array', items: { type: 'string' } },
        sections: { type: 'array', items: { type: 'string' } },
        includeProvenance: { type: 'boolean' },
      }),
    }))
    expect(roleSchema.properties.capabilityScope).toEqual(expect.objectContaining({
      type: 'object',
      properties: expect.objectContaining({
        allow: { type: 'array', items: { type: 'string' } },
        deny: { type: 'array', items: { type: 'string' } },
        enforcement: { type: 'string', enum: ['action_fabric_v1'] },
      }),
    }))

    const mappingSchema = ctx.body.paths['/api/hermes/assistant-roles/{id}/profile-mapping'].put.requestBody.content['application/json'].schema
    expect(mappingSchema.required).toContain('profileName')
    expect(mappingSchema.properties.profileName).toEqual({ type: 'string', nullable: true })

    const previewSchema = ctx.body.paths['/api/hermes/assistant-roles/{id}/context/preview'].post.requestBody.content['application/json'].schema
    expect(previewSchema.properties).toEqual(expect.objectContaining({
      query: { type: 'string' },
      recipeId: { type: 'string' },
    }))

    const recipeSchema = ctx.body.paths['/api/hermes/assistant-roles/{id}/context-recipes'].post.requestBody.content['application/json'].schema
    expect(recipeSchema.required).toEqual(expect.arrayContaining(['name', 'domains', 'sections', 'limits']))
    expect(recipeSchema.properties.domains).toEqual({ type: 'array', items: { type: 'string' } })
    expect(recipeSchema.properties.sections).toEqual({ type: 'array', items: { type: 'string' } })
    expect(recipeSchema.properties.limits).toEqual(expect.objectContaining({
      type: 'object',
      properties: {
        perSection: { type: 'integer', minimum: 1, maximum: 50 },
        totalCharacters: { type: 'integer', minimum: 1000, maximum: 40000 },
      },
      required: ['perSection', 'totalCharacters'],
    }))

    const rolePatchSchema = ctx.body.paths['/api/hermes/assistant-roles/{id}'].put.requestBody.content['application/json'].schema
    expect(Object.keys(rolePatchSchema.properties).sort()).toEqual([
      'capabilityScope', 'dataScope', 'decisionAuthority', 'description', 'enabled',
      'escalationRules', 'memoryNamespace', 'name', 'persona', 'spendingLimits',
    ])
    expect(rolePatchSchema.required).toBeUndefined()
    expect(rolePatchSchema.properties).toEqual(expect.objectContaining({
      name: { type: 'string' },
      description: { type: 'string' },
      persona: { type: 'string' },
      memoryNamespace: { type: 'string' },
      enabled: { type: 'boolean' },
    }))

    const recipePatchSchema = ctx.body.paths['/api/hermes/assistant-roles/{id}/context-recipes/{recipeId}'].put.requestBody.content['application/json'].schema
    expect(Object.keys(recipePatchSchema.properties).sort()).toEqual([
      'description', 'domains', 'enabled', 'limits', 'name', 'queryTemplate', 'sections',
    ])
    expect(recipePatchSchema.required).toBeUndefined()
    expect(recipePatchSchema.properties).toEqual(expect.objectContaining({
      name: { type: 'string' },
      description: { type: 'string' },
      queryTemplate: { type: 'string' },
      enabled: { type: 'boolean' },
    }))
  })

  it('advertises assistant role discovery with Action Fabric enforcement', () => {
    const source = readFileSync(resolve(process.cwd(), 'bin/hermes-web-ui-mcp.mjs'), 'utf8')
    expect(source).toContain("'Assistant Roles': {")
    expect(source).toContain('role list, profile mapping, context preview, and context recipe CRUD')
    expect(source).toContain('Capability permissions are enforced by Action Fabric policy in Phase 3.')
  })
})
