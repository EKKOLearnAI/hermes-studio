import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('assistant role profile mappings and context recipes', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-assistant-role-mappings-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('atomically replaces another primary role mapped to the same Profile', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')

    roles.setAssistantRoleProfileMapping('health-manager', 'Work')
    expect(roles.setAssistantRoleProfileMapping('fitness-coach', 'Work')).toMatchObject({
      roleId: 'fitness-coach',
      profileName: 'Work',
      isPrimary: true,
    })

    expect(roles.listAssistantRolesWithMappings()
      .filter(role => role.primaryProfileName === 'Work')
      .map(role => role.id)).toEqual(['fitness-coach'])
    expect(roles.withPersonalTwinDb(db => db.prepare(
      'SELECT role_id, profile_name, is_primary FROM twin_role_profile_mappings ORDER BY role_id',
    ).all())).toEqual([{ role_id: 'fitness-coach', profile_name: 'Work', is_primary: 1 }])
  })

  it('resolves an enabled mapped role and otherwise falls back to Chief of Staff', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    mkdirSync(join(hermesHome, 'profiles', 'Work'), { recursive: true })
    roles.setAssistantRoleProfileMapping('health-manager', 'Work')

    expect(roles.resolveAssistantRoleForProfile(' Work ')?.id).toBe('health-manager')
    roles.updateAssistantRole('health-manager', { enabled: false })
    expect(roles.resolveAssistantRoleForProfile('Work')?.id).toBe('chief-of-staff')
    expect(roles.resolveAssistantRoleForProfile('Unmapped')?.id).toBe('chief-of-staff')
  })

  it('preserves case-sensitive Profile names and reports missing on-disk mappings as stale', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    mkdirSync(join(hermesHome, 'profiles', 'CaseSensitive'), { recursive: true })

    roles.setAssistantRoleProfileMapping('home-manager', ' CaseSensitive ')
    expect(roles.listAssistantRolesWithMappings().find(role => role.id === 'home-manager'))
      .toMatchObject({ primaryProfileName: 'CaseSensitive', mappingStale: false })

    rmSync(join(hermesHome, 'profiles', 'CaseSensitive'), { recursive: true, force: true })
    expect(roles.listAssistantRolesWithMappings().find(role => role.id === 'home-manager'))
      .toMatchObject({ primaryProfileName: 'CaseSensitive', mappingStale: true })
  })

  it('renames and removes Profile mappings without deleting roles', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    roles.setAssistantRoleProfileMapping('entertainment-assistant', 'Leisure')

    roles.renameAssistantRoleProfileMappings('Leisure', 'FunTime')
    expect(roles.getAssistantRole('entertainment-assistant')).not.toBeNull()
    expect(roles.listAssistantRolesWithMappings().find(role => role.id === 'entertainment-assistant')?.primaryProfileName)
      .toBe('FunTime')

    roles.removeAssistantRoleProfileMappings('FunTime')
    expect(roles.getAssistantRole('entertainment-assistant')).not.toBeNull()
    expect(roles.listAssistantRolesWithMappings().find(role => role.id === 'entertainment-assistant')?.profileMappings)
      .toEqual([])
  })

  it('creates, updates, lists, and deletes validated custom recipes', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    const role = roles.createAssistantRole(validRole())

    const created = roles.createContextRecipe(role.id, {
      id: 'recovery-daily',
      name: 'Daily recovery',
      domains: ['health', 'fitness'],
      sections: ['observations', 'goals'],
      limits: { perSection: 8, totalCharacters: 8000 },
    })
    expect(created).toMatchObject({ id: 'recovery-daily', roleId: role.id, builtIn: false, enabled: true })
    expect(roles.updateContextRecipe(role.id, created.id, {
      sections: ['constraints'],
      limits: { perSection: 4, totalCharacters: 6000 },
    })).toMatchObject({ sections: ['constraints'], limits: { perSection: 4, totalCharacters: 6000 } })
    expect(roles.listContextRecipes(role.id).map(recipe => recipe.id)).toEqual(['recovery-daily'])

    roles.deleteContextRecipe(role.id, created.id)
    expect(roles.listContextRecipes(role.id)).toEqual([])
  })

  it.each([
    ['unsupported domain', { domains: ['secrets' as never] }, /domain/i],
    ['duplicate domain', { domains: ['health', 'health'] }, /unique|duplicate/i],
    ['unsupported section', { sections: ['passwords' as never] }, /section/i],
    ['duplicate section', { sections: ['goals', 'goals'] }, /unique|duplicate/i],
  ])('rejects invalid recipe %s', async (_label, patch, message) => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    const role = roles.createAssistantRole(validRole())
    expect(() => roles.createContextRecipe(role.id, {
      id: 'bad-recipe',
      name: 'Bad recipe',
      domains: ['health'],
      sections: ['goals'],
      limits: { perSection: 5, totalCharacters: 8000 },
      ...patch,
    })).toThrow(message)
  })

  it('clamps recipe limits on create and patch update before persisting them', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    const role = roles.createAssistantRole(validRole())

    const created = roles.createContextRecipe(role.id, {
      id: 'bounded-recipe',
      name: 'Bounded',
      domains: ['health'],
      sections: ['goals'],
      limits: { perSection: 0, totalCharacters: 999 },
    })
    expect(created.limits).toEqual({ perSection: 1, totalCharacters: 1000 })
    expect(roles.listContextRecipes(role.id)[0].limits).toEqual({ perSection: 1, totalCharacters: 1000 })

    const updated = roles.updateContextRecipe(role.id, created.id, {
      limits: { perSection: 51, totalCharacters: 40_001 },
    })
    expect(updated.limits).toEqual({ perSection: 50, totalCharacters: 40_000 })
    expect(roles.listContextRecipes(role.id)[0].limits).toEqual({ perSection: 50, totalCharacters: 40_000 })
  })

  it('prevents cross-role recipe operations and protects built-in recipes from deletion', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    const first = roles.createAssistantRole(validRole())
    const second = roles.createAssistantRole(validRole({
      id: 'second-coach',
      memoryNamespace: 'assistant.second-coach',
    }))
    const recipe = roles.createContextRecipe(first.id, {
      id: 'first-recipe',
      name: 'First',
      domains: ['health'],
      sections: ['goals'],
      limits: { perSection: 5, totalCharacters: 8000 },
    })

    expect(() => roles.updateContextRecipe(second.id, recipe.id, { name: 'Stolen' })).toThrow(/not found/i)
    expect(() => roles.deleteContextRecipe(second.id, recipe.id)).toThrow(/not found/i)
    expect(() => roles.deleteContextRecipe('chief-of-staff', 'chief-of-staff-default')).toThrow(/built-in/i)
  })

  it('rejects unsafe or empty Profile mapping names', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    expect(() => roles.setAssistantRoleProfileMapping('health-manager', '../escape')).toThrow(/profile name/i)
    expect(() => roles.setAssistantRoleProfileMapping('health-manager', '   ')).toThrow(/profile name/i)
    expect(() => roles.setAssistantRoleProfileMapping('health-manager', 'line\nbreak')).toThrow(/profile name/i)
  })

  it('returns null when a role Profile mapping is cleared', async () => {
    const roles = await import('../../packages/server/src/services/hermes/personal-twin')
    roles.setAssistantRoleProfileMapping('health-manager', 'Work')

    expect(roles.setAssistantRoleProfileMapping('health-manager', null)).toBeNull()
    expect(roles.listAssistantRolesWithMappings().find(role => role.id === 'health-manager')?.profileMappings)
      .toEqual([])
  })
})

function validRole(overrides: Record<string, unknown> = {}) {
  return {
    id: 'recovery-coach',
    name: 'Recovery Coach',
    persona: 'Guide recovery safely.',
    dataScope: {
      domains: ['health', 'fitness'],
      sections: ['observations', 'goals'],
      includeProvenance: true,
    },
    capabilityScope: {
      allow: ['twin.read'],
      deny: [],
      enforcement: 'action_fabric_v1',
    },
    memoryNamespace: 'assistant.recovery-coach',
    ...overrides,
  } as Parameters<typeof import('../../packages/server/src/services/hermes/personal-twin').createAssistantRole>[0]
}
