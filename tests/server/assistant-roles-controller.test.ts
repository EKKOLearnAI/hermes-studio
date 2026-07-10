import { beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({
  TWIN_DOMAINS: ['body', 'health', 'fitness', 'nutrition', 'home', 'life', 'work', 'entertainment', 'commerce', 'digital'],
  TWIN_CONTEXT_SECTIONS: ['subject', 'observations', 'events', 'goals', 'constraints', 'entities', 'relations'],
  listAssistantRolesWithMappings: vi.fn(),
  getAssistantRole: vi.fn(),
  listContextRecipes: vi.fn(),
  createAssistantRole: vi.fn(),
  updateAssistantRole: vi.fn(),
  deleteAssistantRole: vi.fn(),
  cloneAssistantRole: vi.fn(),
  setAssistantRoleProfileMapping: vi.fn(),
  buildRoleContext: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/personal-twin', () => service)

const baseRole = {
  id: 'health-manager',
  name: 'Health Manager',
  description: 'Health lead',
  persona: 'Keep health context bounded.',
  builtIn: true,
  enabled: true,
  dataScope: { domains: ['health'], sections: ['observations'], includeProvenance: true },
  capabilityScope: { allow: ['health.read'], deny: [], enforcement: 'declarative_phase_2' },
  decisionAuthority: {},
  spendingLimits: {},
  memoryNamespace: 'assistant.health-manager',
  escalationRules: [],
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
}

function context(body: unknown = {}, id = 'health-manager'): any {
  return { params: { id }, request: { body }, state: { user: { role: 'super_admin' } }, body: null }
}

describe('assistant roles controller', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(service).forEach(mock => typeof mock === 'function' && mock.mockReset())
    service.listAssistantRolesWithMappings.mockReturnValue([{ ...baseRole, profileMappings: [], primaryProfileName: null, mappingStale: false, recipeCount: 1 }])
    service.getAssistantRole.mockReturnValue(baseRole)
    service.listContextRecipes.mockReturnValue([{ id: 'health-default', roleId: baseRole.id, name: 'Default' }])
    service.createAssistantRole.mockImplementation(input => ({ ...baseRole, ...input, builtIn: false }))
    service.updateAssistantRole.mockImplementation((_id, patch) => ({ ...baseRole, ...patch }))
    service.cloneAssistantRole.mockImplementation((_id, input) => ({ ...baseRole, ...input, builtIn: false }))
    service.setAssistantRoleProfileMapping.mockReturnValue({ roleId: baseRole.id, profileName: 'Coach', isPrimary: true })
    service.buildRoleContext.mockReturnValue({ role: baseRole, renderedInstructions: 'strict bundle', sections: {} })
  })

  it('returns role summaries and detail with recipes', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/assistant-roles')
    const listCtx = context()
    await ctrl.list(listCtx)
    expect(listCtx.body).toEqual({ roles: [expect.objectContaining({ id: 'health-manager', recipeCount: 1 })] })

    const detailCtx = context()
    await ctrl.detail(detailCtx)
    expect(detailCtx.body).toEqual({
      role: expect.objectContaining({ id: 'health-manager', recipeCount: 1 }),
      recipes: [expect.objectContaining({ id: 'health-default' })],
    })
  })

  it('creates a role from explicitly parsed fields', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/assistant-roles')
    const body = {
      id: 'recovery-coach',
      name: 'Recovery Coach',
      description: ' Recovery lead ',
      persona: 'Support recovery.',
      enabled: false,
      dataScope: { domains: ['health', 'fitness'], sections: ['observations', 'goals'], includeProvenance: true },
      capabilityScope: { allow: ['health.read'], deny: ['commerce.buy'], enforcement: 'declarative_phase_2' },
      decisionAuthority: { medication: 'escalate' },
      spendingLimits: { currency: 'CNY', daily: 100 },
      memoryNamespace: 'assistant.recovery-coach',
      escalationRules: [{ when: 'urgent', action: 'notify' }],
    }
    const ctx = context(body)
    await ctrl.create(ctx)
    expect(service.createAssistantRole).toHaveBeenCalledWith(body)
    expect(ctx.status).toBe(201)
    expect(ctx.body).toEqual({ role: expect.objectContaining({ id: 'recovery-coach' }) })
  })

  it('updates only explicitly supplied valid fields', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/assistant-roles')
    const ctx = context({ enabled: false, dataScope: { domains: ['body'], sections: ['subject'], includeProvenance: false } })
    await ctrl.update(ctx)
    expect(service.updateAssistantRole).toHaveBeenCalledWith('health-manager', {
      enabled: false,
      dataScope: { domains: ['body'], sections: ['subject'], includeProvenance: false },
    })
    expect(ctx.body).toEqual({ role: expect.objectContaining({ enabled: false }) })
  })

  it('deletes and clones roles', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/assistant-roles')
    const removeCtx = context()
    await ctrl.remove(removeCtx)
    expect(service.deleteAssistantRole).toHaveBeenCalledWith('health-manager')
    expect(removeCtx.body).toEqual({ success: true })

    const cloneCtx = context({ id: 'recovery-coach', name: 'Recovery Coach' })
    await ctrl.clone(cloneCtx)
    expect(service.cloneAssistantRole).toHaveBeenCalledWith('health-manager', { id: 'recovery-coach', name: 'Recovery Coach' })
    expect(cloneCtx.status).toBe(201)
    expect(cloneCtx.body).toEqual({ role: expect.objectContaining({ id: 'recovery-coach' }) })
  })

  it('updates or clears the primary profile mapping', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/assistant-roles')
    const mapped = context({ profileName: ' Coach ' })
    await ctrl.updateProfileMapping(mapped)
    expect(service.setAssistantRoleProfileMapping).toHaveBeenCalledWith('health-manager', 'Coach')
    expect(mapped.body).toEqual({ mapping: expect.objectContaining({ profileName: 'Coach' }) })

    service.setAssistantRoleProfileMapping.mockReturnValueOnce(null)
    const cleared = context({ profileName: null })
    await ctrl.updateProfileMapping(cleared)
    expect(service.setAssistantRoleProfileMapping).toHaveBeenLastCalledWith('health-manager', null)
    expect(cleared.body).toEqual({ mapping: null })
  })

  it('returns the strict context bundle without widening scope parameters', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/assistant-roles')
    const ctx = context({ query: ' recent sleep ', recipeId: 'health-default' })
    await ctrl.previewContext(ctx)
    expect(service.buildRoleContext).toHaveBeenCalledWith('health-manager', { query: 'recent sleep', recipeId: 'health-default' })
    expect(ctx.body).toEqual({ context: { role: baseRole, renderedInstructions: 'strict bundle', sections: {} } })
  })

  it.each([
    ['create', null],
    ['create', { name: '', persona: 'x', dataScope: {}, capabilityScope: {}, memoryNamespace: 'x' }],
    ['create', { name: 'x', persona: 'x', dataScope: { domains: ['secret'], sections: [], includeProvenance: true }, capabilityScope: { allow: [], deny: [], enforcement: 'declarative_phase_2' }, memoryNamespace: 'x' }],
    ['update', { enabled: 'yes' }],
    ['update', { escalationRules: [{} as object, 'bad'] }],
    ['clone', { name: 12 }],
    ['updateProfileMapping', {}],
    ['previewContext', { query: [], limit: 999 }],
  ])('returns 400 for malformed %s bodies', async (handler, body) => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/assistant-roles')
    const ctx = context(body)
    await (ctrl as any)[handler](ctx)
    expect(ctx.status).toBe(400)
    expect(ctx.body.error).toEqual(expect.any(String))
  })

  it('maps missing, built-in deletion, validation, and internal errors without leaking paths', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/assistant-roles')

    service.listAssistantRolesWithMappings.mockReturnValueOnce([])
    const missing = context()
    await ctrl.detail(missing)
    expect(missing.status).toBe(404)

    service.deleteAssistantRole.mockImplementationOnce(() => { throw new Error('Cannot delete built-in assistant role: health-manager') })
    const builtIn = context()
    await ctrl.remove(builtIn)
    expect(builtIn.status).toBe(409)

    service.createAssistantRole.mockImplementationOnce(() => { throw new Error('Assistant role name is invalid') })
    const invalid = context({
      name: 'x', persona: 'x', memoryNamespace: 'assistant.x',
      dataScope: { domains: [], sections: [], includeProvenance: false },
      capabilityScope: { allow: [], deny: [], enforcement: 'declarative_phase_2' },
    })
    await ctrl.create(invalid)
    expect(invalid.status).toBe(400)

    service.listAssistantRolesWithMappings.mockImplementationOnce(() => { throw new Error('SQLITE failure at C:\\Users\\alice\\personal\\twin.db') })
    const internal = context()
    await ctrl.list(internal)
    expect(internal.status).toBe(500)
    expect(internal.body).toEqual({ error: 'Internal server error' })
    expect(JSON.stringify(internal.body)).not.toContain('twin.db')
  })

  it('maps a duplicate role id to a stable conflict without leaking SQLite schema details', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/assistant-roles')
    service.createAssistantRole.mockImplementationOnce(() => {
      throw new Error('UNIQUE constraint failed: twin_assistant_roles.id at C:\\Users\\alice\\personal\\twin.db')
    })
    const ctx = context({
      id: 'health-manager', name: 'Duplicate', persona: 'Duplicate.', memoryNamespace: 'assistant.duplicate',
      dataScope: { domains: [], sections: [], includeProvenance: false },
      capabilityScope: { allow: [], deny: [], enforcement: 'declarative_phase_2' },
    })
    await ctrl.create(ctx)
    expect(ctx.status).toBe(409)
    expect(ctx.body).toEqual({ error: 'Assistant role already exists' })
    expect(JSON.stringify(ctx.body)).not.toMatch(/twin_assistant_roles|twin\.db|alice/i)
  })

  it('distinguishes missing and disabled context recipes using stable public errors', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/assistant-roles')
    service.buildRoleContext.mockImplementationOnce(() => {
      throw new Error('Context recipe not found: private-recipe at /home/alice/personal/twin.db')
    })
    const missing = context({ recipeId: 'private-recipe' })
    await ctrl.previewContext(missing)
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: 'Context recipe not found' })
    expect(JSON.stringify(missing.body)).not.toMatch(/private-recipe|twin\.db|alice/i)

    service.buildRoleContext.mockImplementationOnce(() => {
      throw new Error('Context recipe is disabled: private-recipe')
    })
    const disabled = context({ recipeId: 'private-recipe' })
    await ctrl.previewContext(disabled)
    expect(disabled.status).toBe(400)
    expect(disabled.body).toEqual({ error: 'Context recipe is disabled' })
    expect(JSON.stringify(disabled.body)).not.toContain('private-recipe')
  })
})
