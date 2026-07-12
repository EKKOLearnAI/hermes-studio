import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
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

    for (const method of ['get', 'put']) {
      const operation = ctx.body.paths['/api/coding-agents/{id}/config-files/{key}'][method]
      expect(operation.parameters).toEqual(expect.arrayContaining([
        { name: 'profile', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'provider', in: 'query', required: false, schema: { type: 'string' } },
      ]))
    }
    expect(ctx.body.paths['/api/coding-agents/{id}/config-files/{key}'].put.requestBody.content['application/json'].schema.properties).toEqual(expect.objectContaining({
      profile: { type: 'string' }, provider: { type: 'string' },
    }))
    expect(ctx.body.paths['/api/hermes/auth/codex/start'].post.parameters).toEqual(expect.arrayContaining([
      { name: 'profile', in: 'query', required: false, schema: { type: 'string' } },
    ]))
    const typeSentinels = new Set(['string', 'number', 'boolean', 'object', 'undefined', 'function', 'symbol', 'bigint'])
    const inspectEnums = (value: any): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value.enum)) expect(value.enum.some((entry: unknown) => typeSentinels.has(String(entry)))).toBe(false)
      if (value.properties) {
        expect(value.properties.trim).toBeUndefined()
        expect(value.properties.toLowerCase).toBeUndefined()
      }
      for (const child of Object.values(value)) inspectEnums(child)
    }
    inspectEnums(ctx.body)
    expect(ctx.body.paths['/api/hermes/workspace/folders/rename'].post.requestBody.content['application/json'].schema.properties).toEqual({
      name: { type: 'string' }, path: { type: 'string' },
    })
    expect(ctx.body.paths['/api/hermes/kanban'].post.requestBody.content['application/json'].schema.properties.value).toBeUndefined()
    expect(ctx.body.paths['/api/hermes/kanban/{id}/comments'].post.requestBody.content['application/json'].schema.properties.value).toBeUndefined()
    expect(ctx.body.paths['/api/hermes/kanban'].post.requestBody.content['application/json'].schema.properties.title).toEqual({ type: 'string' })
    expect(ctx.body.paths['/api/hermes/kanban/{id}/comments'].post.requestBody.content['application/json'].schema.properties.body).toEqual({ type: 'string' })
    for (const path of ['/api/hermes/config', '/api/hermes/config/credentials']) {
      expect(ctx.body.paths[path].put.requestBody.content['application/json'].schema.properties.values).toEqual({
        type: 'object', additionalProperties: true,
      })
    }
    const providerModes = ['chat_completions', 'codex_responses', 'anthropic_messages', 'bedrock_converse', 'codex_app_server']
    for (const [path, method] of [['/api/hermes/config/providers', 'post'], ['/api/hermes/config/providers/{poolKey}', 'put']] as const) {
      expect(ctx.body.paths[path][method].requestBody.content['application/json'].schema.properties.api_mode).toEqual({
        type: 'string', enum: providerModes,
      })
    }
    expect(ctx.body.paths['/api/hermes/sessions/batch-delete'].post.requestBody.content['application/json'].schema.properties.sessions).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, profile: { type: 'string', nullable: true } },
        required: ['id'],
        additionalProperties: false,
      },
    })

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
      expectedCost: { type: 'object', properties: { currency: { type: 'string' }, amountMinor: { type: 'integer', minimum: 0 } }, required: ['currency', 'amountMinor'], additionalProperties: false },
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
      [capabilities, 'ActionCapabilityListResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/executors'].get, 'ActionExecutorListResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/intents'].post, 'ActionIntentResultDto'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows'].get, 'ActionWorkflowListResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}'].get, 'ActionWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/approve'].post, 'ActionWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/reject'].post, 'ActionWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/cancel'].post, 'ActionWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/retry'].post, 'ActionWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/workflows/{id}/compensate'].post, 'ActionWorkflowResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/audit'].get, 'ActionAuditListResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/audit/verify'].get, 'ActionAuditVerificationResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/control'].get, 'ActionControlResponse'],
      [ctx.body.paths['/api/hermes/action-fabric/control/emergency-stop'].put, 'ActionControlResponse'],
    ])
    for (const [operation, schemaName] of successSchemas) {
      expect(operation.responses['200'].content['application/json'].schema).toEqual({ $ref: `#/components/schemas/${schemaName}` })
    }
    for (const operation of actionFabricOperations) {
      expect(operation.responses['400'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/ActionFabricError' })
      expect(operation.responses['500'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/ActionFabricError' })
      expect(operation.responses['401'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/AuthError' })
      expect(operation.responses['403'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/AuthError' })
    }
    expect(ctx.body.components.schemas.ActionWorkflowAvailableActionsDto).toEqual(expect.objectContaining({
      type: 'object',
      properties: {
        approve: { type: 'boolean' }, reject: { type: 'boolean' }, cancel: { type: 'boolean' },
        retry: { type: 'boolean' }, compensate: { type: 'boolean' },
      },
      required: ['approve', 'reject', 'cancel', 'retry', 'compensate'],
      additionalProperties: false,
    }))
    expect(ctx.body.components.schemas.ActionControlDto).toEqual(expect.objectContaining({
      required: ['level', 'version', 'actorUserId', 'reason', 'updatedAt'], additionalProperties: false,
    }))
    expect(ctx.body.components.schemas.ActionWorkflowListResponse.properties.nextCursor).toEqual({ type: 'string', nullable: true })
    expect(ctx.body.components.schemas.ActionAuditListResponse.properties).toEqual(expect.objectContaining({
      events: { type: 'array', items: { $ref: '#/components/schemas/ActionAuditEventDto' } },
      nextAfterSequence: { type: 'number', nullable: true },
    }))
    expect(ctx.body.components.schemas.ActionWorkflowDetailDto).toEqual(expect.objectContaining({
      type: 'object', additionalProperties: false,
      properties: expect.objectContaining({ steps: { type: 'array', items: { $ref: '#/components/schemas/ActionStepDto' } } }),
    }))
    expect(ctx.body.components.schemas.ActionStepDto.properties).toEqual(expect.objectContaining({
      ordinal: { type: 'number' }, kind: { type: 'string' }, state: { type: 'string' },
      evidence: { type: 'array', items: { $ref: '#/components/schemas/ActionEvidenceDto' } },
    }))
    expect(ctx.body.components.schemas.AuthError.required).toEqual(['error'])
    expect(ctx.body.components.schemas.ActionFabricError.required).toEqual(['error', 'code'])
    for (const schema of Object.values(ctx.body.components.schemas) as any[]) {
      const refs = JSON.stringify(schema).match(/#\/components\/schemas\/[A-Za-z_$][\w$]*/g) ?? []
      for (const ref of refs) expect(ctx.body.components.schemas[ref.split('/').at(-1)!]).toBeTruthy()
    }

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

  it('derives annotated DTO contracts without controller-name or copied-schema tables', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/generate-openapi.mjs'), 'utf8')
    expect(source).toContain('ts.createSourceFile')
    expect(source).toContain('@openapi-response')
    expect(source).not.toContain('generateActionFabricResponses')
    expect(source).not.toContain("createIntent: 'Action")
    expect(source).not.toContain('ActionCapabilityListResponse')
    expect(source).not.toContain('ActionWorkflowDetailDto')
    expect(source).not.toContain("tagInfo.name === 'Action Fabric'")
    expect(source).not.toContain('packages/client/src/api/hermes/action-fabric.ts')
    expect(source.indexOf("process.argv.indexOf('--infer-controller-request')"))
      .toBeLessThan(source.indexOf('discoverTypeScriptSchemas(selectedSchemaRoots)'))
  })

  it('discovers multiple annotated schema sources and rejects conflicts or missing refs', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'openapi-schema-sources-'))
    const script = resolve(process.cwd(), 'scripts/generate-openapi.mjs')
    const run = () => spawnSync(process.execPath, [script, '--validate-schema-sources', root], { encoding: 'utf8' })
    try {
      writeFileSync(resolve(root, 'one.ts'), '/** @openapi-schema-source */\nexport interface Alpha { value: string }\n')
      writeFileSync(resolve(root, 'two.ts'), '/** @openapi-schema-source */\nexport interface Beta { alpha: Alpha; enabled?: boolean }\n')
      const success = run()
      expect(success.status).toBe(0)
      expect(JSON.parse(success.stdout)).toEqual(expect.objectContaining({
        Alpha: expect.objectContaining({ required: ['value'] }),
        Beta: expect.objectContaining({ properties: expect.objectContaining({ alpha: { $ref: '#/components/schemas/Alpha' } }) }),
      }))

      writeFileSync(resolve(root, 'conflict.ts'), '/** @openapi-schema-source */\nexport interface Alpha { value: number }\n')
      const conflict = run()
      expect(conflict.status).not.toBe(0)
      expect(conflict.stderr).toContain('Conflicting OpenAPI schema declaration: Alpha')
      rmSync(resolve(root, 'conflict.ts'))
      writeFileSync(resolve(root, 'missing.ts'), '/** @openapi-schema-source */\nexport interface MissingRef { child: DoesNotExist }\n')
      const missing = run()
      expect(missing.status).not.toBe(0)
      expect(missing.stderr).toContain('Missing OpenAPI schema references: DoesNotExist')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it('binds controller helper calls without following imports, exported handlers, shadows, or cycles', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'openapi-controller-graph-'))
    const fixture = resolve(root, 'controller.ts')
    const script = resolve(process.cwd(), 'scripts/generate-openapi.mjs')
    try {
      writeFileSync(fixture, `
export async function target(ctx: any) {
  const { rename } = await import('fs/promises')
  localBody(ctx)
  cycleA(ctx)
  rename('a', 'b')
}
function localBody(ctx: any) {
  const { path, name } = ctx.request.body as { path?: string; name?: string }
  return { path, name }
}
function cycleA(ctx: any) { cycleB(ctx) }
function cycleB(ctx: any) { cycleA(ctx) }
export function rename(ctx: any) {
  const { title } = ctx.request.body as { title?: string }
  return title
}
`)
      const result = spawnSync(process.execPath, [script, '--extract-controller-source', fixture, 'target'], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('function localBody')
      expect(result.stdout).toContain('{ path?: string; name?: string }')
      expect(result.stdout).not.toContain('function rename')
      expect(result.stdout).not.toContain('title?: string')
      expect(result.stdout.match(/function cycleA/g)).toHaveLength(1)
      expect(result.stdout.match(/function cycleB/g)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('infers primitive, array, and object validator inputs without method pseudo-fields', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'openapi-validator-input-'))
    const fixture = resolve(root, 'controller.ts')
    const script = resolve(process.cwd(), 'scripts/generate-openapi.mjs')
    try {
      writeFileSync(fixture, `
type LocalMode = 'alpha' | 'beta'
interface LocalTarget { id: string; label?: string }
export function target(ctx: any) {
  const payload = ctx.request.body as { title?: unknown; count?: unknown; note?: unknown; tags?: unknown; options?: unknown; values: Record<string, any>; mode: LocalMode; targets: LocalTarget[] }
  requiredString(payload.title)
  requiredNumber(payload.count)
  optionalString(payload.note)
  stringArray(payload.tags)
  objectValue(payload.options)
  requiredString(payload.values)
}
function requiredString(value: unknown) { if (typeof value !== 'string' || !value.trim()) throw new Error(); return value }
function requiredNumber(value: unknown) { if (typeof value !== 'number') throw new Error(); return value }
function optionalString(value: unknown) { if (value == null) return; if (typeof value !== 'string') throw new Error(); return value.toLowerCase() }
function stringArray(value: unknown) { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(); return value }
function objectValue(value: unknown) { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(); const enabled = (value as any).enabled; if (typeof enabled !== 'boolean') throw new Error(); return value }
`)
      const result = spawnSync(process.execPath, [script, '--infer-controller-request', fixture, 'target'], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      const properties = JSON.parse(result.stdout).content['application/json'].schema.properties
      expect(properties.title).toEqual({ type: 'string' })
      expect(properties.count).toEqual({ type: 'number' })
      expect(properties.note).toEqual({ type: 'string' })
      expect(properties.tags).toEqual({ type: 'array', items: { type: 'string' } })
      expect(properties.options).toEqual(expect.objectContaining({ type: 'object' }))
      expect(properties.values).toEqual({ type: 'object', additionalProperties: true })
      expect(properties.mode).toEqual({ type: 'string', enum: ['alpha', 'beta'] })
      expect(properties.targets).toEqual(expect.objectContaining({ type: 'array', items: expect.objectContaining({ type: 'object' }) }))
      expect(JSON.stringify(properties)).not.toMatch(/"(?:trim|toLowerCase)"/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})
