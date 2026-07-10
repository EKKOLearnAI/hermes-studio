import { describe, expect, it, vi } from 'vitest'
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
  })
})
