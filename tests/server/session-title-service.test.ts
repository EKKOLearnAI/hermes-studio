import { describe, expect, it } from 'vitest'

import { generateHeuristicSessionTitle } from '../../packages/server/src/services/hermes/session-title'

describe('session title service', () => {
  it('uses the first useful user message and skips trivial greetings', () => {
    const title = generateHeuristicSessionTitle([
      { role: 'user', content: 'hi' },
      { role: 'user', content: '/status' },
      { role: 'assistant', content: 'How can I help?' },
      { role: 'user', content: 'Debug the Vite build failing on macOS after upgrading TypeScript' },
    ])

    expect(title).toBe('Debug the Vite build failing on macOS after upgrading TypeScript')
  })

  it('falls back to the first assistant message when no useful user message exists', () => {
    const title = generateHeuristicSessionTitle([
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'Reviewed the deployment logs and found a missing DATABASE_URL env var.' },
    ])

    expect(title).toBe('Reviewed the deployment logs and found a missing DATABASE_URL env var')
  })

  it('falls back to the existing title when no usable message content exists', () => {
    const title = generateHeuristicSessionTitle([
      { role: 'tool', content: '' },
      { role: 'assistant', content: '```ts\nconst value = 1\n```' },
    ], 'Existing title')

    expect(title).toBe('Existing title')
  })
})
