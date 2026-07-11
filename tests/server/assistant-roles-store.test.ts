import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('assistant role registry', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-assistant-roles-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('seeds five complete built-ins once in deterministic order', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')

    roles.ensureBuiltInAssistantRoles()
    roles.ensureBuiltInAssistantRoles()

    const seeded = roles.listAssistantRoles()
    expect(seeded.map(role => role.id)).toEqual([
      'chief-of-staff',
      'entertainment-assistant',
      'fitness-coach',
      'health-manager',
      'home-manager',
    ])
    expect(seeded.every(role => role.builtIn && role.enabled)).toBe(true)
    expect(seeded.every(role => role.capabilityScope.enforcement === 'action_fabric_v1')).toBe(true)
    expect(seeded.map(role => [role.id, role.dataScope.domains])).toEqual([
      ['chief-of-staff', [...roles.TWIN_DOMAINS]],
      ['entertainment-assistant', ['entertainment', 'life', 'commerce']],
      ['fitness-coach', ['body', 'fitness', 'nutrition', 'health']],
      ['health-manager', ['body', 'health', 'nutrition', 'fitness']],
      ['home-manager', ['home', 'digital']],
    ])

    expect(roles.withPersonalTwinDb(db => db.prepare(
      'SELECT role_id, COUNT(*) AS count FROM twin_context_recipes GROUP BY role_id ORDER BY role_id',
    ).all())).toEqual(seeded.map(role => ({ role_id: role.id, count: 1 })))
  })

  it('does not overwrite edits to a built-in when reseeded and forbids deleting it', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    roles.ensureBuiltInAssistantRoles()

    roles.updateAssistantRole('health-manager', { description: 'My health lead' })
    roles.ensureBuiltInAssistantRoles()

    expect(roles.getAssistantRole('health-manager')?.description).toBe('My health lead')
    expect(() => roles.deleteAssistantRole('health-manager')).toThrow(/built-in/i)
  })

  it('migrates Phase 2 capability scopes once without changing permissions or read paths', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    roles.ensureBuiltInAssistantRoles()
    roles.withPersonalTwinDb(db => db.prepare(`UPDATE twin_assistant_roles SET capability_scope_json=? WHERE id=?`).run(
      JSON.stringify({ allow: ['simulator.echo'], deny: ['action.execute'], enforcement: 'declarative_phase_2' }),
      'health-manager',
    ))

    expect(roles.getAssistantRole('health-manager')?.capabilityScope.enforcement).toBe('declarative_phase_2')
    expect(roles.migrateAssistantRoleCapabilityEnforcement()).toBe(1)
    expect(roles.migrateAssistantRoleCapabilityEnforcement()).toBe(0)
    expect(roles.getAssistantRole('health-manager')?.capabilityScope).toEqual({
      allow: ['simulator.echo'], deny: ['action.execute'], enforcement: 'action_fabric_v1',
    })
  })

  it('creates, updates, and deletes custom roles atomically with their recipes', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    const created = roles.createAssistantRole(validRole({ id: 'recovery-coach' }))

    expect(created).toMatchObject({ id: 'recovery-coach', builtIn: false, enabled: true })
    expect(roles.updateAssistantRole(created.id, {
      name: 'Recovery Lead',
      enabled: false,
      dataScope: { domains: ['body'], sections: ['goals'], includeProvenance: false },
    })).toMatchObject({ name: 'Recovery Lead', enabled: false })

    roles.withPersonalTwinDb(db => db.prepare(`
      INSERT INTO twin_context_recipes (
        id, role_id, name, description, built_in, enabled, domains_json,
        sections_json, query_template, limits_json, created_at, updated_at
      ) VALUES (?, ?, ?, '', 0, 1, ?, ?, '', ?, ?, ?)
    `).run(
      'recovery-coach-custom', created.id, 'Custom', '["body"]', '["goals"]',
      '{"perSection":5,"totalCharacters":4000}', created.createdAt, created.createdAt,
    ))

    roles.deleteAssistantRole(created.id)
    expect(roles.getAssistantRole(created.id)).toBeNull()
    expect(roles.withPersonalTwinDb(db => db.prepare(
      'SELECT COUNT(*) AS count FROM twin_context_recipes WHERE role_id = ?',
    ).get(created.id))).toEqual({ count: 0 })
  })

  it('clones a role and all of its recipes as custom records', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    roles.ensureBuiltInAssistantRoles()

    const clone = roles.cloneAssistantRole('health-manager', { id: 'recovery-coach', name: 'Recovery Coach' })

    expect(clone).toMatchObject({ id: 'recovery-coach', name: 'Recovery Coach', builtIn: false })
    const recipes = roles.withPersonalTwinDb(db => db.prepare(
      'SELECT id, role_id, name, built_in FROM twin_context_recipes WHERE role_id = ?',
    ).all(clone.id))
    expect(recipes).toEqual([
      expect.objectContaining({ role_id: clone.id, name: 'Health Manager Default', built_in: 0 }),
    ])
    expect((recipes[0] as { id: string }).id).not.toBe('health-manager-default')
  })

  it.each([
    ['role id', validRole({ id: 'Bad Role' }), /id/i],
    ['domain', validRole({ dataScope: { domains: ['secrets' as never], sections: ['subject'], includeProvenance: false } }), /domain/i],
    ['section', validRole({ dataScope: { domains: ['health'], sections: ['passwords' as never], includeProvenance: false } }), /section/i],
    ['duplicate domain', validRole({ dataScope: { domains: ['health', 'health'], sections: ['subject'], includeProvenance: false } }), /unique|duplicate/i],
    ['capability id', validRole({ capabilityScope: { allow: ['shell rm -rf'], deny: [], enforcement: 'action_fabric_v1' } }), /capability/i],
    ['persona length', validRole({ persona: 'x'.repeat(12_001) }), /persona/i],
    ['description length', validRole({ description: 'x'.repeat(501) }), /description/i],
    ['capability count', validRole({ capabilityScope: { allow: Array.from({ length: 65 }, (_, index) => `tool.${index}`), deny: [], enforcement: 'action_fabric_v1' } }), /capability/i],
    ['escalation count', validRole({ escalationRules: Array.from({ length: 33 }, (_, index) => ({ index })) }), /escalation/i],
    ['non-json-safe values', validRole({ decisionAuthority: { limit: Number.NaN } }), /json/i],
  ])('rejects invalid %s input', async (_label, input, message) => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    expect(() => roles.createAssistantRole(input)).toThrow(message)
  })

  it('rejects duplicate memory namespaces and update id changes', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    roles.createAssistantRole(validRole({ id: 'first-coach', memoryNamespace: 'assistant.shared' }))

    expect(() => roles.createAssistantRole(validRole({ id: 'second-coach', memoryNamespace: 'assistant.shared' })))
      .toThrow(/memory namespace/i)
    expect(() => roles.updateAssistantRole('first-coach', { id: 'renamed' } as never)).toThrow(/id/i)
  })

  it('rejects null role input with a controlled validation error', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')

    expect(() => roles.createAssistantRole(null as never)).toThrow(/input must be an object/i)
  })

  it.each([
    ['enabled', { enabled: null }, /enabled.*boolean/i],
    ['data scope', { dataScope: null }, /data scope.*object/i],
    ['persona', { persona: null }, /persona.*string/i],
  ])('does not treat an explicit null %s patch as omitted', async (_label, patch, message) => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    roles.createAssistantRole(validRole({ id: 'null-check-coach' }))

    expect(() => roles.updateAssistantRole('null-check-coach', patch as never)).toThrow(message)
  })

  it('does not attempt to reseed built-ins during repeated list and get reads', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    roles.ensureBuiltInAssistantRoles()
    roles.withPersonalTwinDb(db => db.exec(`
      CREATE TRIGGER fail_assistant_role_reseed
      BEFORE INSERT ON twin_assistant_roles
      BEGIN
        SELECT RAISE(ABORT, 'unexpected assistant role reseed');
      END;
    `))

    expect(() => roles.listAssistantRoles()).not.toThrow()
    expect(() => roles.getAssistantRole('health-manager')).not.toThrow()
  })

  it('rolls back a cloned role when cloning one of its recipes fails', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    roles.ensureBuiltInAssistantRoles()
    const collisionHost = roles.createAssistantRole(validRole({
      id: 'collision-host',
      memoryNamespace: 'assistant.collision-host',
    }))
    roles.withPersonalTwinDb(db => db.prepare(`
      INSERT INTO twin_context_recipes (
        id, role_id, name, description, built_in, enabled, domains_json,
        sections_json, query_template, limits_json, created_at, updated_at
      ) VALUES (?, ?, ?, '', 0, 1, ?, ?, '', ?, ?, ?)
    `).run(
      'recovery-coach-recipe-1', collisionHost.id, 'Collision', '["health"]',
      '["observations"]', '{"perSection":5,"totalCharacters":4000}',
      collisionHost.createdAt, collisionHost.createdAt,
    ))

    expect(() => roles.cloneAssistantRole('health-manager', {
      id: 'recovery-coach',
      name: 'Recovery Coach',
    })).toThrow(/unique|constraint/i)
    expect(roles.getAssistantRole('recovery-coach')).toBeNull()
  })
})

function validRole(overrides: Record<string, unknown> = {}) {
  return {
    id: 'custom-coach',
    name: 'Custom Coach',
    description: 'A bounded custom assistant.',
    persona: 'Be practical, safe, and concise.',
    enabled: true,
    dataScope: {
      domains: ['health'],
      sections: ['subject', 'observations'],
      includeProvenance: true,
    },
    capabilityScope: {
      allow: ['twin.read'],
      deny: ['action.execute'],
      enforcement: 'action_fabric_v1',
    },
    decisionAuthority: { maxRisk: 'none' },
    spendingLimits: { currency: 'CNY', perAction: 0, daily: 0 },
    memoryNamespace: 'assistant.custom-coach',
    escalationRules: [{ when: 'uncertain', action: 'ask' }],
    ...overrides,
  } as Parameters<typeof import('../../packages/server/src/services/hermes/personal-twin').createAssistantRole>[0]
}
