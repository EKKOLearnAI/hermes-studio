import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('health consent reservations', () => {
  let home = ''
  const originalHome = process.env.HERMES_HOME
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'health-consent-reservation-')); process.env.HERMES_HOME = home })
  afterEach(() => { if (originalHome === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true }) })

  it('keeps reservation consumption and authorization minting out of the public health barrel', async () => {
    const healthLoop = await import('../../packages/server/src/services/hermes/health-loop')
    expect('CONSUME_HEALTH_RESERVATION' in healthLoop).toBe(false)
    expect('mintHealthReservationAuthorization' in healthLoop).toBe(false)
    expect('AUTHORIZED_AUXILIARY_ANALYZE' in healthLoop).toBe(false)
  })

  it('atomically exchanges a token for an exact durable reservation and consumes it once', async () => {
    const { createHealthConsentBroker } = await import('../../packages/server/src/services/hermes/health-loop/consent')
    const { createHealthConsentReservationConsumer, createAuthorizedAuxiliaryVisionExecutorAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/executors/analysis')
    const { createAuxiliaryVisionAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision')
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const broker = createHealthConsentBroker({ allowedProcessors: ['processor:test'], clock: () => new Date('2026-07-14T01:00:00.000Z') })
    const vault = createHealthArtifactVault({ accessController: {
      secureDirectory: async () => undefined, secureFile: async () => undefined,
    } })
    const artifact = await vault.store({ content: Buffer.from('%PDF-1.7\nreservation'), declaredMediaType: 'application/pdf',
      source: 'reservation-test', sourceId: 'artifact-1', metadata: {} })
    const artifactId = artifact.id
    const manifest = { artifactIds: [artifactId], processor: 'processor:test', purpose: 'skin' as const,
      selectedRegions: ['face'], requestedFields: ['appearances'], retention: 'no_retention' as const }
    const grant = await broker.issue(manifest)
    const binding = { artifactId, artifactManifestDigest: 'b'.repeat(64), processorId: 'processor:test' }
    const reservation = await (broker as any).reserve(grant.token, manifest, binding)
    expect(reservation).toMatchObject({ reservationId: expect.stringMatching(/^reservation-/), ...binding })
    expect(reservation).not.toHaveProperty('token')
    expect('consumeReservation' in broker).toBe(false)
    expect(Reflect.ownKeys(broker).some(key => String(key).includes('onsum') && String(key).includes('eservation'))).toBe(false)
    const consumer = createHealthConsentReservationConsumer(broker)
    const request = { consentId: reservation.reservationId, artifactId, manifestDigest: binding.artifactManifestDigest,
      processorId: binding.processorId }
    await expect(consumer.consume({ ...request, processorId: 'processor:other' }))
      .rejects.toThrow('HEALTH_CONSENT_INVALID')
    expect(await consumer.consume(request))
      .toMatchObject({ consentId: reservation.reservationId, authorization: expect.any(Object) })
    await expect(consumer.consume(request)).rejects.toThrow('HEALTH_CONSENT_REPLAYED')
    await expect((broker as any).reserve(grant.token, manifest, binding)).rejects.toThrow('HEALTH_CONSENT_REPLAYED')

    const nextGrant = await broker.issue(manifest)
    const next = await broker.reserve(nextGrant.token, manifest, binding)
    const concurrent = { ...request, consentId: next.reservationId }
    const results = await Promise.allSettled([consumer.consume(concurrent), consumer.consume(concurrent)])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])

    const authorizedGrant = await broker.issue(manifest)
    const authorizedReservation = await broker.reserve(authorizedGrant.token, manifest, binding)
    const authorizedConsumption = await consumer.consume({ ...request, consentId: authorizedReservation.reservationId })
    const duplicateConsume = vi.fn()
    const client = { analyze: vi.fn(async () => JSON.stringify({ schemaVersion: 'health-analyzer-output/v1',
      modelVersion: 'vision-1', parserVersion: 'vision-json-v1', overallConfidence: 0.9,
      captureQuality: { score: 0.9, reasons: [] }, fields: [{ field: 'appearances', value: [], confidence: 0.9,
        evidence: { artifactId, region: 'face' } }] })) }
    const auxiliary = createAuxiliaryVisionAnalyzer({ resolver: async () => ({ provider: 'processor:test', model: 'vision-1',
      locality: 'remote', timeoutMs: 1000 }), client, vault, consentBroker: { consume: duplicateConsume } })
    const authorized = createAuthorizedAuxiliaryVisionExecutorAnalyzer(auxiliary)
    await expect(authorized.analyze({ artifactId, manifestDigest: binding.artifactManifestDigest,
      processorId: binding.processorId, requestedAt: '2026-07-14T01:00:00.000Z', signal: new AbortController().signal,
      authorization: authorizedConsumption.authorization })).resolves.toMatchObject({ result: { status: 'completed' } })
    expect(duplicateConsume).not.toHaveBeenCalled()
    await expect(auxiliary.analyze({ schemaVersion: 'health-analysis-request/v1', profile: 'default', purpose: 'skin',
      sourceId: 'ordinary-call', observedAt: '2026-07-14T01:00:00.000Z', artifactIds: [artifactId],
      selectedRegions: ['face'], requestedFields: ['appearances'] })).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_REQUEST' })
  })

  it('rejects multi-artifact disclosure before the remote vault or processor can be reached', async () => {
    const { createHealthConsentBroker } = await import('../../packages/server/src/services/hermes/health-loop/consent')
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const { createAuxiliaryVisionAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision')
    const { createAuthorizedAuxiliaryVisionExecutorAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/executors/analysis')
    const vault = createHealthArtifactVault({ accessController: {
      secureDirectory: async () => undefined, secureFile: async () => undefined,
    } })
    const first = await vault.store({ content: Buffer.from('%PDF-1.7\nfirst-health-artifact'), declaredMediaType: 'application/pdf',
      source: 'reservation-test', sourceId: 'multi-1', metadata: {} })
    const second = await vault.store({ content: Buffer.from('%PDF-1.7\nsecond-health-artifact'), declaredMediaType: 'application/pdf',
      source: 'reservation-test', sourceId: 'multi-2', metadata: {} })
    const manifest = { artifactIds: [first.id, second.id], processor: 'processor:test', purpose: 'skin' as const,
      selectedRegions: ['face'], requestedFields: ['appearances'], retention: 'no_retention' as const }
    const broker = createHealthConsentBroker({ allowedProcessors: ['processor:test'] })
    const grant = await broker.issue(manifest)
    await expect(broker.reserve(grant.token, manifest, { artifactId: first.id,
      artifactManifestDigest: 'c'.repeat(64), processorId: 'processor:test' }))
      .rejects.toThrow('HEALTH_CONSENT_INVALID')

    const read = vi.fn()
    const client = { analyze: vi.fn() }
    const auxiliary = createAuxiliaryVisionAnalyzer({ resolver: async () => ({ provider: 'processor:test', model: 'vision-1',
      locality: 'remote', timeoutMs: 1000 }), client, vault: { read } })
    const authorized = createAuthorizedAuxiliaryVisionExecutorAnalyzer(auxiliary)
    await expect(authorized.analyze({ artifactId: first.id, manifestDigest: 'c'.repeat(64), processorId: 'processor:test',
      requestedAt: '2026-07-14T01:00:00.000Z', signal: new AbortController().signal }))
      .rejects.toThrow('HEALTH_ANALYSIS_CONSENT_DENIED')
    expect(read).not.toHaveBeenCalled()
    expect(client.analyze).not.toHaveBeenCalled()
  })

  it('fails closed when reservation or parent grant causality is tampered after reserve', async () => {
    const { createHealthConsentBroker } = await import('../../packages/server/src/services/hermes/health-loop/consent')
    const { createHealthConsentReservationConsumer } = await import('../../packages/server/src/services/hermes/health-loop/executors/analysis')
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const vault = createHealthArtifactVault({ accessController: {
      secureDirectory: async () => undefined, secureFile: async () => undefined,
    } })
    const artifact = await vault.store({ content: Buffer.from('%PDF-1.7\ntamper-artifact'), declaredMediaType: 'application/pdf',
      source: 'reservation-test', sourceId: 'tamper-1', metadata: {} })
    const manifest = { artifactIds: [artifact.id], processor: 'processor:test', purpose: 'skin' as const,
      selectedRegions: ['face'], requestedFields: ['appearances'], retention: 'no_retention' as const }
    const binding = { artifactId: artifact.id, artifactManifestDigest: 'd'.repeat(64), processorId: 'processor:test' }
    const broker = createHealthConsentBroker({ allowedProcessors: ['processor:test'],
      clock: () => new Date('2026-07-14T01:00:00.000Z') })
    const consumer = createHealthConsentReservationConsumer(broker)
    const mutations = [
      (consentId: string, _reservationId: string) => withPersonalTwinDb(db =>
        db.prepare("UPDATE twin_artifact_consents SET revoked_at='2026-07-14T01:00:01.000Z' WHERE consent_id=?").run(consentId)),
      (consentId: string, _reservationId: string) => withPersonalTwinDb(db =>
        db.prepare("UPDATE twin_artifact_consents SET consumed_at='2026-07-14T01:00:02.000Z' WHERE consent_id=?").run(consentId)),
      (_consentId: string, reservationId: string) => withPersonalTwinDb(db =>
        db.prepare("UPDATE twin_artifact_consent_reservations SET expires_at='2026-07-14T01:01:00.000Z' WHERE reservation_id=?").run(reservationId)),
      (consentId: string, _reservationId: string) => withPersonalTwinDb(db =>
        db.prepare("UPDATE twin_artifact_consents SET processor='processor:tampered' WHERE consent_id=?").run(consentId)),
    ]
    for (const [index, mutate] of mutations.entries()) {
      const caseManifest = { ...manifest, selectedRegions: [`face-${index}`] }
      const grant = await broker.issue(caseManifest)
      const reservation = await broker.reserve(grant.token, caseManifest, binding)
      mutate(reservation.consentId, reservation.reservationId)
      await expect(consumer.consume({ consentId: reservation.reservationId, artifactId: artifact.id,
        manifestDigest: binding.artifactManifestDigest, processorId: binding.processorId })).rejects.toThrow()
    }
  })
})
