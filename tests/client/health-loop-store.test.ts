// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  fetchHealthLoopOverview: vi.fn(), fetchHealthConnectors: vi.fn(), fetchHealthInterventions: vi.fn(),
  fetchHealthLoopSettings: vi.fn(), syncHealthConnector: vi.fn(), createHealthArtifact: vi.fn(),
  analyzeHealthArtifact: vi.fn(), createHealthConsent: vi.fn(), revokeHealthConsent: vi.fn(),
  submitHealthInterventionFeedback: vi.fn(), updateHealthLoopSettings: vi.fn(),
}))
vi.mock('@/api/hermes/health-loop', () => api)
import { useHealthLoopStore } from '@/stores/hermes/health-loop'

function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (reason:unknown)=>void
  const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no}); return { promise, resolve, reject } }
const overview = { settings: { version: 1 }, connectors: [], summary: { interventionCount: 0 } }
const connectors = [{ id: 'source-1' }]
const intervention = { actionId: 'a1', interventionId: 'i1', status: 'active' }
const settings = { version: 1, liveDeliveryEnabled: false }

describe('health loop store', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks()
    api.fetchHealthLoopOverview.mockResolvedValue(overview); api.fetchHealthConnectors.mockResolvedValue(connectors)
    api.fetchHealthInterventions.mockResolvedValue([intervention]); api.fetchHealthLoopSettings.mockResolvedValue(settings)
  })

  it('keeps only the newest response and error for each read resource', async () => {
    const old = deferred<any>(); api.fetchHealthConnectors.mockImplementationOnce(()=>old.promise)
      .mockResolvedValueOnce([{ id: 'new' }])
    const store = useHealthLoopStore(); const stale = store.loadConnectors(); await store.loadConnectors()
    old.reject(new Error('stale failure')); await expect(stale).rejects.toThrow('stale failure')
    expect(store.connectors).toEqual([{ id: 'new' }]); expect(store.error).toBeNull()
  })

  it('keeps a newest resource failure visible while an unrelated resource completes later', async () => {
    const failedConnectors = deferred<any[]>(); const laterOverview = deferred<any>()
    api.fetchHealthConnectors.mockImplementationOnce(() => failedConnectors.promise)
    api.fetchHealthLoopOverview.mockImplementationOnce(() => laterOverview.promise)
    const store = useHealthLoopStore()
    const connectorLoad = store.loadConnectors()
    const overviewLoad = store.loadOverview()
    failedConnectors.reject(new Error('connectors unavailable'))
    await expect(connectorLoad).rejects.toThrow('connectors unavailable')
    laterOverview.resolve(overview)
    await overviewLoad
    expect(store.resourceErrors).toEqual({ overview: null, connectors: 'connectors unavailable',
      interventions: null, settings: null })
    expect(store.error).toBe('connectors unavailable')
  })

  it('discards an old failure after a newer request for the same resource succeeds', async () => {
    const staleSettings = deferred<any>()
    api.fetchHealthLoopSettings.mockImplementationOnce(() => staleSettings.promise)
      .mockResolvedValueOnce({ ...settings, version: 2 })
    const store = useHealthLoopStore()
    const staleLoad = store.loadSettings()
    await store.loadSettings()
    staleSettings.reject(new Error('stale settings failure'))
    await expect(staleLoad).rejects.toThrow('stale settings failure')
    expect(store.settings?.version).toBe(2)
    expect(store.resourceErrors.settings).toBeNull()
    expect(store.error).toBeNull()
  })

  it('does not let a stale list response overwrite a newer selection', async () => {
    const old = deferred<any[]>(); api.fetchHealthInterventions.mockImplementationOnce(()=>old.promise)
    const store = useHealthLoopStore(); const load = store.loadInterventions(); store.selectIntervention('i2')
    old.resolve([intervention]); await load
    expect(store.selectedInterventionId).toBe('i2'); expect(store.selectedIntervention).toBeNull()
  })

  it('serializes conflicting mutations, permits independent keys, and refreshes authoritative state', async () => {
    const first = deferred<any>(); api.syncHealthConnector.mockImplementationOnce(()=>first.promise).mockResolvedValueOnce({ workflow:{id:'w2'} })
    const store = useHealthLoopStore(); const a = store.syncConnector('source-1', {}); const b = store.syncConnector('source-1', {})
    await Promise.resolve(); expect(api.syncHealthConnector).toHaveBeenCalledTimes(1)
    const independent = store.syncConnector('source-2', {}); await Promise.resolve(); expect(api.syncHealthConnector).toHaveBeenCalledTimes(2)
    first.resolve({ workflow:{id:'w1'} }); await Promise.all([a,b,independent])
    expect(api.fetchHealthConnectors).toHaveBeenCalledTimes(3); expect(api.fetchHealthLoopOverview).toHaveBeenCalledTimes(3)
  })

  it('returns consent tokens only to the caller and never stores them', async () => {
    const grant = { consentId: 'c1', token: 'secret-token' }; api.createHealthConsent.mockResolvedValue(grant)
    const store = useHealthLoopStore(); await expect(store.createConsent({ manifest: {} } as never)).resolves.toEqual(grant)
    expect(JSON.stringify(store.$state)).not.toContain('secret-token')
    expect(api.fetchHealthLoopSettings).toHaveBeenCalled(); expect(api.fetchHealthLoopOverview).toHaveBeenCalled()
  })

  it('reloads authoritative views after feedback, revoke, and settings writes and returns own payload', async () => {
    api.submitHealthInterventionFeedback.mockResolvedValue({ feedbackId:'f1' })
    api.revokeHealthConsent.mockResolvedValue({ consentId:'c1' })
    api.updateHealthLoopSettings.mockResolvedValue({ version:2 })
    const store=useHealthLoopStore()
    await expect(store.submitFeedback('i1', {} as never)).resolves.toEqual({ feedbackId:'f1' })
    await expect(store.revokeConsent('c1')).resolves.toEqual({ consentId:'c1' })
    await expect(store.updateSettings({} as never)).resolves.toEqual({ version:2 })
    expect(api.fetchHealthInterventions).toHaveBeenCalled(); expect(api.fetchHealthLoopSettings).toHaveBeenCalledTimes(2)
    expect(api.fetchHealthConnectors).toHaveBeenCalled(); expect(api.fetchHealthLoopOverview).toHaveBeenCalledTimes(3)
  })

  it('invalidates in-flight state on reset without cancelling caller results', async () => {
    const pending=deferred<any>(); api.fetchHealthLoopOverview.mockImplementationOnce(()=>pending.promise)
    const store=useHealthLoopStore(); const load=store.loadOverview(); store.$reset(); pending.resolve(overview)
    await expect(load).resolves.toEqual(overview); expect(store.overview).toBeNull(); expect(store.loading).toBe(false)
  })
})
