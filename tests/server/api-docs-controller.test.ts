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

    const participantCollectionSchema = ctx.body.paths['/api/hermes/group-chat/rooms/{roomId}/agents']
      .post.requestBody.content['application/json'].schema
    expect(participantCollectionSchema.required).toEqual(['profile'])
    expect(participantCollectionSchema.properties).toMatchObject({
      runtime: { type: 'string', enum: ['hermes', 'coding_agent'] },
      codingAgentId: { type: 'string', enum: ['', 'claude-code', 'codex'] },
      mode: { type: 'string', enum: ['scoped'] },
      apiMode: { type: 'string', enum: ['', 'chat_completions', 'codex_responses', 'anthropic_messages'] },
    })
    const roomCreateSchema = ctx.body.paths['/api/hermes/group-chat/rooms']
      .post.requestBody.content['application/json'].schema
    expect(roomCreateSchema.properties.agents).toMatchObject({
      type: 'array',
      items: { type: 'object', required: ['profile'] },
    })
    expect(roomCreateSchema.properties.agents.items.properties.runtime.enum).toEqual(['hermes', 'coding_agent'])

    const participantPatchSchema = ctx.body.paths['/api/hermes/group-chat/rooms/{roomId}/agents/{agentId}']
      .patch.requestBody.content['application/json'].schema
    expect(participantPatchSchema.required).toBeUndefined()
    expect(participantPatchSchema.properties).not.toHaveProperty('profile')
    expect(participantPatchSchema.properties).not.toHaveProperty('runtime')
    expect(participantPatchSchema.properties.reasoningEffort.enum).toEqual([
      '', 'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
  })
})
