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
        enforcement: { type: 'string', enum: ['declarative_phase_2'] },
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
  })

  it('advertises assistant role discovery without implying capability enforcement', () => {
    const source = readFileSync(resolve(process.cwd(), 'bin/hermes-web-ui-mcp.mjs'), 'utf8')
    expect(source).toContain("'Assistant Roles': {")
    expect(source).toContain('role list, profile mapping, context preview, and context recipe CRUD')
    expect(source).toContain('Capability permissions are declarative and are not enforced execution authorization in Phase 2.')
  })
})
