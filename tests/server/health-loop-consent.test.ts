import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('health remote-processing consent broker', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''
  let now = new Date('2026-07-13T12:00:00.000Z')

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-health-consent-'))
    process.env.HERMES_HOME = hermesHome
    now = new Date('2026-07-13T12:00:00.000Z')
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  async function fixture() {
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const { createHealthConsentBroker } = await import('../../packages/server/src/services/hermes/health-loop/consent')
    const artifact = await createHealthArtifactVault({
      accessController: { secureDirectory: async () => undefined, secureFile: async () => undefined },
    }).store({
      content: Buffer.from('%PDF-1.7\nsynthetic'), declaredMediaType: 'application/pdf',
      source: 'health-report', sourceId: 'report-1', metadata: {},
    })
    const broker = createHealthConsentBroker({ allowedProcessors: ['processor:test'], clock: () => new Date(now) })
    const manifest = {
      artifactIds: [artifact.id],
      processor: 'processor:test',
      purpose: 'internal_health' as const,
      selectedRegions: ['page:2/region:lab-table'],
      requestedFields: ['fasting_glucose', 'hba1c'],
      retention: 'no_retention' as const,
    }
    return { artifact, broker, manifest }
  }

  it('exports one retention contract and accepts every supported value through issue and consume', async () => {
    const { HEALTH_PROCESSING_RETENTIONS } = await import('../../packages/server/src/services/hermes/health-loop/consent')
    expect(HEALTH_PROCESSING_RETENTIONS).toEqual(['no_retention', 'session', '24_hours'])
    for (const retention of HEALTH_PROCESSING_RETENTIONS) {
      const { broker, manifest } = await fixture()
      const scoped = { ...manifest, retention }
      const grant = await broker.issue(scoped)
      await expect(broker.consume(grant.token, scoped)).resolves.toMatchObject({ consentId: grant.consentId })
    }
    const { broker, manifest } = await fixture()
    await expect(broker.issue({ ...manifest, retention: 'provider_zero_retention' as 'no_retention' }))
      .rejects.toMatchObject({ code: 'HEALTH_CONSENT_MANIFEST_INVALID' })
  })

  it('accepts approved camelCase requested fields while preserving exact semantic-name restrictions', async () => {
    const { broker, manifest } = await fixture()
    const camelCase = { ...manifest, requestedFields: ['waistCm', 'lightingProfile', 'mealTime', 'reportDate'] }
    const grant = await broker.issue(camelCase)
    expect(grant.manifest.requestedFields).toEqual(['lightingProfile', 'mealTime', 'reportDate', 'waistCm'])
    await expect(broker.consume(grant.token, { ...camelCase, requestedFields: ['waistcm', 'lightingProfile', 'mealTime', 'reportDate'] }))
      .rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    await expect(broker.consume(grant.token, camelCase)).resolves.toMatchObject({ consentId: grant.consentId })

    for (const field of ['has space', 'has/slash', 'UppercaseStart', '__proto__', 'constructor', 'prototype']) {
      await expect(broker.issue({ ...manifest, requestedFields: [field] }))
        .rejects.toMatchObject({ code: 'HEALTH_CONSENT_MANIFEST_INVALID' })
    }
  })

  it('canonicalizes set-like scope and returns a random 256-bit bearer only once', async () => {
    const { broker, manifest, artifact } = await fixture()
    const first = await broker.issue({
      ...manifest,
      artifactIds: [artifact.id, artifact.id],
      selectedRegions: [...manifest.selectedRegions, ...manifest.selectedRegions],
      requestedFields: ['hba1c', 'fasting_glucose', 'hba1c'],
    }, { ttlMs: 60_000 })

    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    expect(first).toMatchObject({ consentId: expect.stringMatching(/^consent-[0-9a-f-]{36}$/), issuedAt: now.toISOString() })
    expect(first.consentId).not.toBe(first.manifestDigest)
    expect(first.manifest).toEqual(manifest)
    expect(JSON.stringify(first)).not.toContain(hermesHome)

    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const row = withPersonalTwinDb(db => db.prepare('SELECT * FROM twin_artifact_consents').get()) as Record<string, unknown>
    expect(row.manifest_digest).toBe(first.manifestDigest)
    expect(row.scope_json).not.toContain(first.token)
    expect(row.scope_json).not.toContain(hermesHome)
    expect(row.scope_json).toContain('tokenDigest')

    await expect(broker.issue(manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_ACTIVE' })
  })

  it('binds token to the exact canonical manifest and consumes it at most once', async () => {
    const { broker, manifest } = await fixture()
    const grant = await broker.issue(manifest)
    const changed = { ...manifest, requestedFields: [...manifest.requestedFields, 'ldl'] }

    await expect(broker.consume(grant.token, changed)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    await expect(broker.consume('0'.repeat(64), manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    await expect(broker.consume(Symbol('hostile-token') as unknown as string, manifest))
      .rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    const consumed = await broker.consume(grant.token, manifest)
    expect(consumed).toMatchObject({ consentId: grant.consentId, manifestDigest: grant.manifestDigest, consumedAt: now.toISOString() })
    await expect(broker.consume(grant.token, manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_REPLAYED' })
  })

  it('idempotently reserves one consent for the exact actor, request key, and material without storing the token', async () => {
    const { broker, manifest, artifact } = await fixture()
    const grant = await broker.issue(manifest)
    const binding = { artifactId: artifact.id, artifactManifestDigest: 'd'.repeat(64), processorId: manifest.processor }
    const context = { actorUserId: '42', idempotencyKey: 'analyze-request-1' }
    const first = await broker.reserveIdempotent(grant.token, manifest, binding, context)
    const replay = await broker.reserveIdempotent(grant.token, manifest, binding, context)
    expect(replay).toEqual(first)
    expect(first.reservationId).toMatch(/^reservation-[0-9a-f-]{36}$/)

    for (const [changedBinding, changedContext] of [
      [binding, { ...context, actorUserId: '43' }],
      [binding, { ...context, idempotencyKey: 'analyze-request-2' }],
      [{ ...binding, artifactManifestDigest: 'e'.repeat(64) }, context],
    ] as const) {
      await expect(broker.reserveIdempotent(grant.token, manifest, changedBinding, changedContext))
        .rejects.toMatchObject({ code: expect.stringMatching(/^HEALTH_CONSENT_/) })
    }
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const rows = withPersonalTwinDb(db => db.prepare('SELECT * FROM twin_artifact_consent_reservations').all()) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(grant.token)
    const scope = withPersonalTwinDb(db => db.prepare('SELECT scope_json FROM twin_artifact_consents WHERE consent_id=?').get(grant.consentId))
    expect(JSON.stringify(scope)).not.toContain(grant.token)
  })

  it('rejects consume and revoke when the clock moves before issuance without changing grant state', async () => {
    const { broker, manifest } = await fixture()
    const grant = await broker.issue(manifest)
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const state = (consentId: string) => withPersonalTwinDb(db => db.prepare(
      'SELECT consumed_at,revoked_at FROM twin_artifact_consents WHERE consent_id=?',
    ).get(consentId))

    now = new Date('2026-07-13T11:59:00.000Z')
    await expect(broker.consume(grant.token, manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    await expect(broker.revoke(grant.consentId)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    expect(state(grant.consentId)).toEqual({ consumed_at: null, revoked_at: null })

    now = new Date('2026-07-13T12:00:00.000Z')
    await expect(broker.consume(grant.token, manifest)).resolves.toMatchObject({ consentId: grant.consentId })
    const reissued = await broker.issue(manifest)
    now = new Date('2026-07-13T11:59:00.000Z')
    await expect(broker.revoke(reissued.consentId)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    expect(state(reissued.consentId)).toEqual({ consumed_at: null, revoked_at: null })
    now = new Date('2026-07-13T12:00:00.000Z')
    await expect(broker.revoke(reissued.consentId)).resolves.toMatchObject({ consentId: reissued.consentId })
  })

  it('allows exactly one concurrent consume and does not consume after failed authentication', async () => {
    const { broker, manifest } = await fixture()
    const grant = await broker.issue(manifest)
    const failed = await Promise.allSettled([
      broker.consume('0'.repeat(64), manifest),
      broker.consume('1'.repeat(64), manifest),
    ])
    expect(failed.every(item => item.status === 'rejected')).toBe(true)

    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => broker.consume(grant.token, manifest)))
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(item => item.status === 'rejected')).toHaveLength(11)
  })

  it('rejects expiry and revocation without marking the grant consumed', async () => {
    const { broker, manifest } = await fixture()
    const expired = await broker.issue(manifest, { ttlMs: 1_000 })
    now = new Date('2026-07-13T12:00:01.001Z')
    await expect(broker.consume(expired.token, manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_EXPIRED' })

    const reissued = await broker.issue(manifest)
    await broker.revoke(reissued.consentId)
    await expect(broker.consume(reissued.token, manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_REVOKED' })

    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const row = withPersonalTwinDb(db => db.prepare('SELECT consumed_at, revoked_at FROM twin_artifact_consents WHERE consent_id=?')
      .get(reissued.consentId))
    expect(row).toEqual({ consumed_at: null, revoked_at: now.toISOString() })
  })

  it('reissues terminal grants but never overwrites an active grant, with one concurrent winner', async () => {
    const { broker, manifest } = await fixture()
    const consumed = await broker.issue(manifest)
    await broker.consume(consumed.token, manifest)
    const afterConsume = await broker.issue(manifest)
    expect(afterConsume.consentId).not.toBe(consumed.consentId)
    expect(afterConsume.token).not.toBe(consumed.token)
    await broker.revoke(afterConsume.consentId)
    const afterRevoke = await broker.issue(manifest, { ttlMs: 1_000 })
    expect(afterRevoke.consentId).not.toBe(afterConsume.consentId)
    now = new Date('2026-07-13T12:00:01.001Z')
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => broker.issue(manifest)))
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(item => item.status === 'rejected')).toHaveLength(7)
    const winner = attempts.find(item => item.status === 'fulfilled')
    expect(winner && winner.status === 'fulfilled' && winner.value.token).not.toBe(afterRevoke.token)
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const history = withPersonalTwinDb(db => db.prepare(`SELECT consent_id,consumed_at,revoked_at FROM twin_artifact_consents
      WHERE manifest_digest=? ORDER BY issued_at,consent_id`).all(consumed.manifestDigest)) as Array<Record<string, unknown>>
    expect(history).toHaveLength(4)
    expect(new Set(history.map(row => row.consent_id)).size).toBe(4)
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ consent_id: consumed.consentId, consumed_at: expect.any(String) }),
      expect.objectContaining({ consent_id: afterConsume.consentId, revoked_at: expect.any(String) }),
      expect.objectContaining({ consent_id: afterRevoke.consentId }),
    ]))
    await expect(broker.revoke(afterConsume.consentId)).resolves.toMatchObject({ consentId: afterConsume.consentId })
    const activeConsentId = winner && winner.status === 'fulfilled' ? winner.value.consentId : ''
    expect(withPersonalTwinDb(db => db.prepare('SELECT revoked_at FROM twin_artifact_consents WHERE consent_id=?').get(activeConsentId)))
      .toEqual({ revoked_at: null })
  })

  it('rejects unknown artifacts, non-health artifacts, excessive TTL, and broadened manifest keys', async () => {
    const { broker, manifest } = await fixture()
    await expect(broker.issue({ ...manifest, artifactIds: [`artifact-${'f'.repeat(64)}`] }))
      .rejects.toMatchObject({ code: 'HEALTH_CONSENT_ARTIFACT_INVALID' })
    await expect(broker.issue(manifest, { ttlMs: 60 * 60 * 1000 }))
      .rejects.toMatchObject({ code: 'HEALTH_CONSENT_TTL_INVALID' })
    await expect(broker.issue({ ...manifest, callbackUrl: 'https://attacker.test' } as typeof manifest))
      .rejects.toMatchObject({ code: 'HEALTH_CONSENT_MANIFEST_INVALID' })
    await expect(broker.issue({ ...manifest, processor: 'processor:other' }))
      .rejects.toMatchObject({ code: 'HEALTH_CONSENT_MANIFEST_INVALID' })

    const { upsertTwinArtifact } = await import('../../packages/server/src/services/hermes/personal-twin')
    upsertTwinArtifact({
      mediaType: 'application/json', contentHash: 'e'.repeat(64), relativePath: `ee/${'e'.repeat(64)}`,
      sizeBytes: 2, sensitivity: 'general', metadata: {}, source: 'general-import', sourceId: 'general-1',
    })
    await expect(broker.issue({ ...manifest, artifactIds: [`artifact-${'e'.repeat(64)}`] }))
      .rejects.toMatchObject({ code: 'HEALTH_CONSENT_ARTIFACT_INVALID' })
  })

  it('fails closed on poison keys, accessors, proxies, cycles, Unicode hazards, and structural abuse', async () => {
    const { broker, manifest } = await fixture()
    const poison = JSON.parse(JSON.stringify(manifest).replace('{', '{"__proto__":{"polluted":true},'))
    const accessor = { ...manifest }
    Object.defineProperty(accessor, 'processor', { enumerable: true, get: () => 'processor:test' })
    const proxy = new Proxy({ ...manifest }, { ownKeys: () => { throw new Error(`secret ${hermesHome}`) } })
    const cycle: Record<string, unknown> = { ...manifest }; cycle.requestedFields = cycle
    const badUnicode = { ...manifest, selectedRegions: ['safe\u202Etxt'] }
    const tooMany = { ...manifest, requestedFields: Array.from({ length: 300 }, (_, i) => `field_${i}`) }

    for (const candidate of [poison, accessor, proxy, cycle, badUnicode, tooMany]) {
      const error = await broker.issue(candidate as typeof manifest).catch(value => value)
      expect(error).toMatchObject({ code: 'HEALTH_CONSENT_MANIFEST_INVALID' })
      expect(error.message).not.toContain(hermesHome)
      expect(error).not.toHaveProperty('cause')
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('rejects non-enumerable manifest scope and corrupted stored scope before consumption', async () => {
    const { broker, manifest } = await fixture()
    const hidden = { ...manifest }
    Object.defineProperty(hidden, 'hiddenUploadTarget', { value: 'attacker', enumerable: false })
    await expect(broker.issue(hidden)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_MANIFEST_INVALID' })

    const grant = await broker.issue(manifest)
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    withPersonalTwinDb(db => {
      const row = db.prepare('SELECT scope_json FROM twin_artifact_consents WHERE consent_id=?').get(grant.consentId) as { scope_json: string }
      const scope = JSON.parse(row.scope_json)
      scope.manifest.requestedFields = ['broader_field']
      db.prepare('UPDATE twin_artifact_consents SET scope_json=? WHERE consent_id=?').run(JSON.stringify(scope), grant.consentId)
    })
    await expect(broker.consume(grant.token, manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    expect(withPersonalTwinDb(db => db.prepare('SELECT consumed_at FROM twin_artifact_consents WHERE consent_id=?').get(grant.consentId)))
      .toEqual({ consumed_at: null })
  })

  it('cryptographically binds processor and grant lifetime against database tampering', async () => {
    const { broker, manifest } = await fixture()
    const grant = await broker.issue(manifest, { ttlMs: 60_000 })
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const original = withPersonalTwinDb(db => db.prepare('SELECT * FROM twin_artifact_consents WHERE consent_id=?')
      .get(grant.consentId)) as Record<string, unknown>
    const restore = () => withPersonalTwinDb(db => db.prepare(`UPDATE twin_artifact_consents
      SET processor=?,scope_json=?,issued_at=?,expires_at=?,consumed_at=?,revoked_at=? WHERE consent_id=?`).run(
      original.processor, original.scope_json, original.issued_at, original.expires_at, original.consumed_at, original.revoked_at, grant.consentId,
    ))

    withPersonalTwinDb(db => db.prepare('UPDATE twin_artifact_consents SET expires_at=? WHERE consent_id=?')
      .run('2026-07-13T12:10:00.000Z', grant.consentId))
    await expect(broker.consume(grant.token, manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    restore()

    withPersonalTwinDb(db => {
      const scope = JSON.parse(String(original.scope_json))
      scope.expiresAt = '2026-07-13T12:10:00.000Z'
      scope.ttlMs = 600_000
      db.prepare('UPDATE twin_artifact_consents SET expires_at=?,scope_json=? WHERE consent_id=?')
        .run(scope.expiresAt, JSON.stringify(scope), grant.consentId)
    })
    await expect(broker.consume(grant.token, manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    restore()

    withPersonalTwinDb(db => db.prepare('UPDATE twin_artifact_consents SET processor=? WHERE consent_id=?')
      .run('processor:tampered', grant.consentId))
    await expect(broker.consume(grant.token, manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    restore()

    withPersonalTwinDb(db => {
      const scope = JSON.parse(String(original.scope_json))
      scope.issuedAt = '2026-07-13T11:59:00.000Z'
      scope.ttlMs = 120_000
      db.prepare('UPDATE twin_artifact_consents SET issued_at=?,scope_json=? WHERE consent_id=?')
        .run(scope.issuedAt, JSON.stringify(scope), grant.consentId)
    })
    await expect(broker.consume(grant.token, manifest)).rejects.toMatchObject({ code: 'HEALTH_CONSENT_INVALID' })
    restore()

    await expect(broker.consume(grant.token, manifest)).resolves.toMatchObject({ consentId: grant.consentId })
  })
})
