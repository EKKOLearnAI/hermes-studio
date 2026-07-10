// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/client', () => ({ request: mockRequest }))

import {
  fetchPersonalTwinContext,
  fetchPersonalTwinEntities,
  fetchPersonalTwinEvents,
  fetchPersonalTwinObservations,
  fetchPersonalTwinOverview,
  syncLegacyPersonalTwin,
} from '../../packages/client/src/api/hermes/personal-twin'

describe('Personal Twin API', () => {
  beforeEach(() => {
    mockRequest.mockReset()
    mockRequest.mockResolvedValue({ overview: {}, entities: [], observations: [], events: [], context: {}, result: {} })
  })

  it('encodes read filters and legacy sync without profile headers', async () => {
    await fetchPersonalTwinOverview()
    await fetchPersonalTwinEntities({ type: 'person', limit: 20 })
    await fetchPersonalTwinObservations({ entityId: 'person:self', metric: 'body.weight_kg', limit: 30 })
    await fetchPersonalTwinEvents({ eventType: 'fitness.workout.logged', limit: 10 })
    await fetchPersonalTwinContext({ domains: ['body', 'health'], query: 'weight', limit: 25 })
    await syncLegacyPersonalTwin(['default', 'coach'])

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/personal-twin/overview'],
      ['/api/hermes/personal-twin/entities?type=person&limit=20'],
      ['/api/hermes/personal-twin/observations?entityId=person%3Aself&metric=body.weight_kg&limit=30'],
      ['/api/hermes/personal-twin/events?eventType=fitness.workout.logged&limit=10'],
      ['/api/hermes/personal-twin/context?domains=body%2Chealth&query=weight&limit=25'],
      ['/api/hermes/personal-twin/imports/legacy', { method: 'POST', body: JSON.stringify({ profiles: ['default', 'coach'] }) }],
    ])
  })
})
