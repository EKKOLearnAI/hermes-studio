import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('assistant role context engine', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-assistant-role-context-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('intersects recipe scope with role scope and filters before its limit with literal LIKE queries', async () => {
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    seedSubject(twin)
    twin.updateAssistantRole('health-manager', {
      dataScope: {
        domains: ['body', 'health'],
        sections: ['subject', 'observations', 'events'],
        includeProvenance: true,
      },
    })
    twin.updateContextRecipe('health-manager', 'health-manager-default', {
      domains: ['body', 'health', 'digital'],
      sections: ['observations', 'events', 'goals'],
      limits: { perSection: 1, totalCharacters: 12_000 },
    })
    twin.recordTwinObservation(factObservation('body.deep_match', 'needle%_literal', 'old-match', '2020-01-01T00:00:00.000Z'))
    twin.recordTwinEvent(factEvent('health.deep_match', { value: 'needle%_literal' }, 'old-event-match', '2020-01-01T00:00:00.000Z'))
    for (let index = 0; index < 200; index += 1) {
      const timestamp = new Date(Date.UTC(2021, 0, 1, 0, 0, index)).toISOString()
      twin.recordTwinObservation(factObservation(`digital.noise_${index}`, 'needleXXliteral', `noise-${index}`, timestamp))
      twin.recordTwinEvent(factEvent(`digital.noise_${index}`, { value: 'needleXXliteral' }, `event-noise-${index}`, timestamp))
    }

    const bundle = twin.buildRoleContext('health-manager', {
      query: 'needle%_literal',
      recipeId: 'health-manager-default',
    })

    expect(bundle.appliedScope).toEqual({
      domains: ['body', 'health'],
      sections: ['observations', 'events'],
      includeProvenance: true,
    })
    expect(bundle.sections.observations).toEqual([
      expect.objectContaining({ metric: 'body.deep_match', value: 'needle%_literal' }),
    ])
    expect(bundle.sections.events).toEqual([
      expect.objectContaining({ eventType: 'health.deep_match', payload: { value: 'needle%_literal' } }),
    ])
    expect(bundle.sections.goals).toEqual([])
    expect(bundle.provenance.observations?.[0]).toMatchObject({ source: 'test', sourceId: 'old-match' })
  }, 30_000)

  it('queries goals, constraints, entities, and relations before limits with fixed domain and literal query filters', async () => {
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    seedSubject(twin)
    twin.upsertTwinEntity({ id: 'body:target', type: 'body', label: 'needle%_literal', source: 'test', sourceId: 'target' })
    twin.upsertTwinGoal({ subjectId: 'person:self', domain: 'health', title: 'needle%_literal', target: {}, status: 'active', priority: 1, source: 'test', sourceId: 'goal-match' })
    twin.upsertTwinConstraint({ subjectId: 'person:self', domain: 'health', key: 'needle%_literal', value: true, enforcement: 'hard', source: 'test', sourceId: 'constraint-match' })
    twin.upsertTwinRelation({ subjectId: 'person:self', predicate: 'health.needle%_literal', objectId: 'body:target', source: 'test', sourceId: 'relation-match' })
    for (let index = 0; index < 200; index += 1) {
      twin.upsertTwinEntity({ id: `digital:${index}`, type: 'digital', label: `needleXXliteral ${index}`, source: 'test', sourceId: `entity-${index}` })
      twin.upsertTwinGoal({ subjectId: 'person:self', domain: 'digital', title: `needleXXliteral ${index}`, target: {}, status: 'active', priority: 1, source: 'test', sourceId: `goal-${index}` })
      twin.upsertTwinConstraint({ subjectId: 'person:self', domain: 'digital', key: `needleXXliteral-${index}`, value: true, enforcement: 'hard', source: 'test', sourceId: `constraint-${index}` })
      twin.upsertTwinRelation({ subjectId: 'person:self', predicate: `digital.needleXXliteral-${index}`, objectId: `digital:${index}`, source: 'test', sourceId: `relation-${index}` })
    }
    twin.createAssistantRole(roleInput({
      dataScope: { domains: ['health', 'body'], sections: ['goals', 'constraints', 'entities', 'relations'], includeProvenance: true },
    }))
    twin.createContextRecipe('context-tester', {
      id: 'context-test-recipe', name: 'Context test', domains: ['health', 'body'],
      sections: ['goals', 'constraints', 'entities', 'relations'], queryTemplate: '{{query}}',
      limits: { perSection: 1, totalCharacters: 12_000 },
    })

    const bundle = twin.buildRoleContext('context-tester', { recipeId: 'context-test-recipe', query: 'needle%_literal' })
    expect(bundle.sections.goals).toEqual([expect.objectContaining({ title: 'needle%_literal' })])
    expect(bundle.sections.constraints).toEqual([expect.objectContaining({ value: true, domain: 'health' })])
    expect(bundle.sourceRecordIds.constraints).toHaveLength(1)
    expect(bundle.sections.entities).toEqual([expect.objectContaining({ label: 'needle%_literal' })])
    expect(bundle.sections.relations).toEqual([expect.objectContaining({ predicate: 'health.needle%_literal' })])
  }, 30_000)

  it('omits provenance when disallowed and removes credentials, database paths, and source fields from rendered data', async () => {
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    twin.upsertTwinEntity({
      id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self',
      attributes: { theme: 'dark', password: 'nope', credentials: { token: 'nope' }, databasePath: 'C:/secret/twin.db' },
    })
    twin.createAssistantRole(roleInput({
      dataScope: { domains: ['health'], sections: ['subject', 'goals'], includeProvenance: false },
    }))
    twin.createContextRecipe('context-tester', {
      id: 'privacy-recipe', name: 'Privacy', domains: ['health'], sections: ['subject', 'goals'],
      limits: { perSection: 5, totalCharacters: 12_000 },
    })
    twin.upsertTwinGoal({
      subjectId: 'person:self', domain: 'health', title: 'Sleep',
      target: { hours: 8, apiKey: 'nope', dbPath: '/private/twin.db' }, status: 'active', priority: 1,
      source: 'private-source', sourceId: 'private-id',
    })

    const bundle = twin.buildRoleContext('context-tester', { recipeId: 'privacy-recipe' })
    const serialized = JSON.stringify(bundle.sections)
    expect(bundle.provenance).toEqual({})
    expect(serialized).toContain('theme')
    expect(serialized).not.toMatch(/password|credentials|token|apiKey|databasePath|dbPath|private-source|private-id/i)
    expect(bundle.sourceRecordIds.goals).toHaveLength(1)
    expect(bundle.renderedInstructions).not.toContain(bundle.sourceRecordIds.goals![0])
  })

  it('recursively removes ambiguous credentials and filesystem aliases while retaining benign fields', async () => {
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    twin.upsertTwinEntity({
      id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self',
      attributes: {
        keyboard: 'mechanical',
        key: 'sk-live-secret',
        turnkey: 'benign-turnkey',
        monkey: 'benign-monkey',
        result: 'retained',
        nested: {
          configPath: 'C:/private/config.json',
          homeDirectory: 'C:/Users/private',
          sqliteFile: 'C:/private/twin.sqlite',
          clientSecret: 'secret-value',
          privateKey: 'private-key-value',
          authorization: 'Bearer private',
          passwordHash: 'hash-value',
          deeper: {
            refresh_token: 'token-value',
            credential_file: 'C:/private/creds.json',
            secretAccessKey: 'cloud-secret-1',
            awsSecretAccessKey: 'cloud-secret-2',
            accessKeyId: 'cloud-key-id',
            authHeader: 'Basic private',
            httpAuthorization: 'Bearer http-private',
            dsn: 'postgres://private',
            databaseUrl: 'sqlite:///private.db',
            sessionCookie: 'session-private',
            sshKey: 'ssh-private',
            encryptionKey: 'encryption-private',
            bearer: 'bearer-private',
            connectionUri: 'postgres://connection-private',
            jdbcUrl: 'jdbc:private',
            signingKey: 'signing-private',
            masterKey: 'master-private',
            clientKey: 'client-private',
            mnemonic: 'mnemonic private words',
            recoveryPhrase: 'recovery private words',
            seedPhrase: 'seed private words',
            recovery_seed: 'recovery-seed-private',
          },
        },
      },
    })
    twin.createAssistantRole(roleInput({
      dataScope: { domains: ['health'], sections: ['subject'], includeProvenance: false },
    }))
    twin.createContextRecipe('context-tester', {
      id: 'nested-privacy', name: 'Nested privacy', domains: ['health'], sections: ['subject'],
      limits: { perSection: 5, totalCharacters: 12_000 },
    })

    const bundle = twin.buildRoleContext('context-tester', { recipeId: 'nested-privacy' })
    const serialized = JSON.stringify(bundle.sections.subject)
    expect(serialized).toContain('mechanical')
    expect(serialized).toContain('retained')
    expect(serialized).toContain('benign-turnkey')
    expect(serialized).toContain('benign-monkey')
    expect(serialized).not.toContain('sk-live-secret')
    expect(serialized).not.toMatch(/configPath|homeDirectory|sqliteFile|clientSecret|privateKey|authorization|passwordHash|refresh_token|credential_file|secretAccessKey|awsSecretAccessKey|accessKeyId|authHeader|httpAuthorization|dsn|databaseUrl|sessionCookie|sshKey|encryptionKey|bearer|connectionUri|jdbcUrl|signingKey|masterKey|clientKey|mnemonic|recoveryPhrase|seedPhrase|recovery_seed/i)
    expect(serialized).not.toMatch(/C:\/private|Bearer private|hash-value|token-value|cloud-secret|cloud-key-id|Basic private|http-private|postgres:\/\/private|sqlite:\/\/\/private|session-private|ssh-private|encryption-private|bearer-private|connection-private|jdbc:private|signing-private|master-private|client-private|private words|recovery-seed-private/)
  })

  it('caps zero-record rendered instructions by deterministically truncating long persona text', async () => {
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    seedSubject(twin)
    twin.createAssistantRole(roleInput({
      persona: 'P'.repeat(12_000),
      dataScope: { domains: ['health'], sections: ['goals'], includeProvenance: false },
    }))
    twin.createContextRecipe('context-tester', {
      id: 'fixed-budget', name: 'Fixed budget', domains: ['health'], sections: ['goals'],
      limits: { perSection: 5, totalCharacters: 1000 },
    })
    twin.setAssistantRoleProfileMapping('context-tester', 'default')

    const bundle = twin.buildRoleContext('context-tester', { recipeId: 'fixed-budget' })
    expect(bundle.sections.goals).toEqual([])
    expect(bundle.renderedInstructions.length).toBeLessThanOrEqual(1000)
    expect(bundle.renderedInstructions).toContain('[persona truncated]')
    expect(bundle.truncated.total).toBe(true)
    const runtime = twin.buildSafeRoleContextInstructionsForProfile('default', { recipeId: 'fixed-budget' })
    expect(runtime.length).toBeLessThanOrEqual(1000)
    expect(runtime).toBe(bundle.renderedInstructions)
  })

  it('renders deterministically in stable section order and truncates only at record boundaries', async () => {
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    seedSubject(twin)
    twin.createAssistantRole(roleInput({
      persona: 'Concise.',
      dataScope: { domains: ['health'], sections: ['goals', 'constraints'], includeProvenance: false },
    }))
    twin.createContextRecipe('context-tester', {
      id: 'budget-recipe', name: 'Budget', domains: ['health'], sections: ['constraints', 'goals'],
      limits: { perSection: 10, totalCharacters: 1000 },
    })
    for (let index = 0; index < 10; index += 1) {
      twin.upsertTwinGoal({ subjectId: 'person:self', domain: 'health', title: `Goal ${index} ${'x'.repeat(180)}`, target: {}, status: 'active', priority: index, source: 'test', sourceId: `goal-${index}` })
      twin.upsertTwinConstraint({ subjectId: 'person:self', domain: 'health', key: `constraint-${index}`, value: 'y'.repeat(180), enforcement: 'advisory', source: 'test', sourceId: `constraint-${index}` })
    }

    const first = twin.buildRoleContext('context-tester', { recipeId: 'budget-recipe' })
    const second = twin.buildRoleContext('context-tester', { recipeId: 'budget-recipe' })
    expect(first.renderedInstructions).toBe(twin.renderRoleContext(first))
    expect(second.renderedInstructions).toBe(first.renderedInstructions)
    expect(first.renderedInstructions.length).toBeLessThanOrEqual(1000)
    expect(first.renderedInstructions.indexOf('## Goals')).toBeLessThan(first.renderedInstructions.indexOf('## Constraints'))
    expect(first.truncated.total).toBe(true)
    expect(Object.values(first.truncated.sections)).toContain(true)
    for (const record of [...first.sections.goals, ...first.sections.constraints]) {
      expect(first.renderedInstructions).toContain(JSON.stringify(record))
    }
  })

  it('falls back to Chief of Staff for missing and stale Profile mappings', async () => {
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    seedSubject(twin)
    twin.setAssistantRoleProfileMapping('health-manager', 'Coach')

    expect(twin.buildRoleContextForProfile('Missing')?.role.id).toBe('chief-of-staff')
    const stale = twin.buildRoleContextForProfile('Coach')!
    expect(stale.role.id).toBe('chief-of-staff')
    expect(stale.profileMapping).toEqual({ profileName: 'Coach', stale: true })

    mkdirSync(join(hermesHome, 'profiles', 'Coach'), { recursive: true })
    expect(twin.buildRoleContextForProfile('Coach')?.role.id).toBe('health-manager')
  })

  it('uses a sanitized safe runtime fallback while strict preview surfaces failures', async () => {
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(() => twin.buildRoleContext('missing-role')).toThrow(/not found/i)
    expect(twin.buildSafeRoleContextInstructionsForProfile('Unsafe/Profile')).toBe('')
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0].join(' ')).not.toContain('Unsafe/Profile')
    expect(warning.mock.calls[0][1]).toMatchObject({ profile: '[invalid]', error: 'Error' })
  })
})

function seedSubject(twin: typeof import('../../packages/server/src/services/hermes/personal-twin')) {
  twin.upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
}

function factObservation(metric: string, value: unknown, sourceId: string, observedAt: string) {
  return { entityId: 'person:self', metric, value, observedAt, source: 'test', sourceId, actor: 'test', confidence: 1, confirmationState: 'observed' as const }
}

function factEvent(eventType: string, payload: Record<string, unknown>, sourceId: string, occurredAt: string) {
  return { eventType, subjectId: 'person:self', payload, occurredAt, source: 'test', sourceId, actor: 'test', confidence: 1, confirmationState: 'observed' as const }
}

function roleInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'context-tester', name: 'Context Tester', persona: 'Use bounded context.',
    dataScope: { domains: ['health'], sections: ['subject', 'goals', 'constraints', 'entities', 'relations'], includeProvenance: true },
    capabilityScope: { allow: ['twin.read'], deny: [], enforcement: 'declarative_phase_2' as const },
    memoryNamespace: 'assistant.context-tester', ...overrides,
  } as Parameters<typeof import('../../packages/server/src/services/hermes/personal-twin').createAssistantRole>[0]
}
