// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuroraGovernanceStore } from '@/stores/hermes/aurora-governance'
import { useAuroraIntentAuditStore } from '@/stores/hermes/aurora-intent-audit'

describe('aurora governance store', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  it('queues confirmations in FIFO order without auto-rejecting the active request', async () => {
    const store = useAuroraGovernanceStore()
    const auditStore = useAuroraIntentAuditStore()
    const decisions: boolean[] = []

    const first = store.requestConfirmation({
      title: 'First approval',
      description: 'First request',
      source: 'first-source',
    }).then(decision => decisions.push(decision))
    const second = store.requestConfirmation({
      title: 'Second approval',
      description: 'Second request',
      source: 'second-source',
    }).then(decision => decisions.push(decision))

    expect(store.pendingCount).toBe(2)
    expect(store.activeConfirmation?.title).toBe('First approval')
    expect(decisions).toEqual([])
    expect(auditStore.records.filter(record => record.status === 'approval_queued')).toHaveLength(2)

    store.confirmActive()
    await first

    expect(decisions).toEqual([true])
    expect(store.pendingCount).toBe(1)
    expect(store.activeConfirmation?.title).toBe('Second approval')
    expect(store.lastDecision).toMatchObject({
      approved: true,
      source: 'first-source',
    })
    expect(auditStore.records.some(record =>
      record.status === 'approval_approved' && record.input === 'First approval',
    )).toBe(true)

    store.cancelActive()
    await second

    expect(decisions).toEqual([true, false])
    expect(store.pendingCount).toBe(0)
    expect(store.activeConfirmation).toBeNull()
    expect(store.lastDecision).toMatchObject({
      approved: false,
      source: 'second-source',
    })
    expect(auditStore.records.some(record =>
      record.status === 'approval_rejected' && record.input === 'Second approval',
    )).toBe(true)
  })

  it('cancels a stale queued confirmation by lifecycle context key', async () => {
    const store = useAuroraGovernanceStore()
    const auditStore = useAuroraIntentAuditStore()
    const decisions: boolean[] = []

    const first = store.requestConfirmation({
      title: 'First approval',
      description: 'First request',
      source: 'first-source',
      contextKey: 'first-context',
    }).then(decision => decisions.push(decision))
    const second = store.requestConfirmation({
      title: 'Second approval',
      description: 'Second request',
      source: 'second-source',
      contextKey: 'second-context',
    }).then(decision => decisions.push(decision))

    expect(store.pendingCount).toBe(2)
    expect(store.cancelConfirmation('second-context')).toBe(true)
    await second

    expect(decisions).toEqual([false])
    expect(store.pendingCount).toBe(1)
    expect(store.activeConfirmation?.title).toBe('First approval')
    expect(store.lastDecision).toMatchObject({
      approved: false,
      source: 'second-source',
    })
    expect(auditStore.records.some(record =>
      record.status === 'approval_expired' && record.input === 'Second approval',
    )).toBe(true)

    store.confirmActive()
    await first

    expect(decisions).toEqual([false, true])
    expect(store.pendingCount).toBe(0)
    expect(store.lastDecision).toMatchObject({
      approved: true,
      source: 'first-source',
    })
  })
})
