import { describe, expect, it } from 'vitest'
import { buildInitialSessionTitle } from '../../packages/server/src/services/hermes/run-chat/handle-api-run'

describe('run chat initial title', () => {
  it('creates a first-message title even when AI session title generation is enabled', () => {
    expect(buildInitialSessionTitle('Plan a trip to Kyoto', { session_title_generation: { enabled: true } })).toBe('Plan a trip to Kyoto')
  })

  it('keeps the standard first-message title when AI session title generation is disabled', () => {
    expect(buildInitialSessionTitle('Plan a trip to Kyoto', { session_title_generation: { enabled: false } })).toBe('Plan a trip to Kyoto')
  })

  it('uses the shared standard fallback for long first messages', () => {
    expect(buildInitialSessionTitle('Как понять, стоит мне брать зарядное устройство на 100Вт или на 140Вт?')).toBe('Как понять, стоит мне брать зарядное уст...')
  })
})
