import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))

import * as api from '@/api/hermes/health-loop'

describe('health loop client API', () => {
  beforeEach(() => request.mockReset())

  it('reads every health-loop resource and encodes intervention filters', async () => {
    request.mockResolvedValueOnce({ settings: {}, connectors: [], summary: {} })
      .mockResolvedValueOnce({ connectors: [{ id: 'source-1' }] })
      .mockResolvedValueOnce({ interventions: [{ interventionId: 'i-1' }] })
      .mockResolvedValueOnce({ settings: { version: 1 } })
    await api.fetchHealthLoopOverview()
    await api.fetchHealthConnectors()
    await api.fetchHealthInterventions({ status: 'active', limit: 25 })
    await api.fetchHealthLoopSettings()
    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/health-loop/overview', '/api/hermes/health-loop/connectors',
      '/api/hermes/health-loop/interventions?status=active&limit=25', '/api/hermes/health-loop/settings',
    ])
  })

  it('uploads an artifact as FormData without leaking a token or raw path', async () => {
    const artifact = { id: `artifact-${'a'.repeat(64)}` }
    request.mockResolvedValue({ artifact })
    const file = new Blob(['health'], { type: 'application/pdf' })
    await expect(api.createHealthArtifact({ file, filename: 'report.pdf', sourceId: 'source / one',
      metadata: { healthAnalysis: { purpose: 'internal_health' } } })).resolves.toEqual(artifact)
    const [path, options] = request.mock.calls[0]
    expect(path).toBe('/api/hermes/health-loop/artifacts')
    expect(options.method).toBe('POST')
    expect(options.body).toBeInstanceOf(FormData)
    expect(options.body.get('sourceId')).toBe('source / one')
    expect(options.body.get('metadata')).toBe(JSON.stringify({ healthAnalysis: { purpose: 'internal_health' } }))
  })

  it('encodes every semantic id and sends exact mutation bodies', async () => {
    request.mockResolvedValue({ intent: {}, policyDecision: {}, workflow: {} })
    await api.syncHealthConnector('source / one', { cursor: 'c1' })
    await api.analyzeHealthArtifact('artifact / one', { mode: 'local', manifestDigest: 'a'.repeat(64) })
    request.mockResolvedValueOnce({ consent: { consentId: 'consent / one', token: 'b'.repeat(64) } })
    const grant = await api.createHealthConsent({ manifest: { artifactIds: [`artifact-${'a'.repeat(64)}`],
      processor: 'processor-1', purpose: 'skin', selectedRegions: [], requestedFields: ['finding'], retention: 'session' } })
    request.mockResolvedValueOnce({ consent: { consentId: 'consent / one', revokedAt: 'now' } })
    await api.revokeHealthConsent('consent / one')
    request.mockResolvedValueOnce({ feedback: { feedbackId: 'f1' } })
    await api.submitHealthInterventionFeedback('intervention / one', { feedbackId: 'f1', outcome: 'completed', occurredAt: '2026-07-14T00:00:00Z' })
    request.mockResolvedValueOnce({ settings: { version: 2 } })
    await api.updateHealthLoopSettings({ expectedVersion: 1, liveDeliveryEnabled: true, recipient: 'configured-self' })
    expect(grant.token).toBe('b'.repeat(64))
    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/health-loop/connectors/source%20%2F%20one/sync',
      '/api/hermes/health-loop/artifacts/artifact%20%2F%20one/analyze',
      '/api/hermes/health-loop/consents', '/api/hermes/health-loop/consents/consent%20%2F%20one/revoke',
      '/api/hermes/health-loop/interventions/intervention%20%2F%20one/feedback', '/api/hermes/health-loop/settings',
    ])
    expect(request.mock.calls[3][1]).toEqual({ method: 'POST', body: '{}' })
  })
})
