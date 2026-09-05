import { describe, expect, it, vi } from 'vitest'
import { fetchAppAccessMode } from '../../packages/server/src/modules/studio/services/app-relay/access-mode'

describe('App access mode', () => {
  it.each(['internal', 'public_beta', 'paid'] as const)(
    'reads the %s mode from the existing App auth config endpoint',
    async (accessMode) => {
      const request = vi.fn(async () => new Response(JSON.stringify({ accessMode }), { status: 200 }))

      await expect(fetchAppAccessMode('https://api.example.com/', request)).resolves.toBe(accessMode)
      expect(request).toHaveBeenCalledWith(
        'https://api.example.com/api/app/auth/config',
        expect.objectContaining({ headers: { Accept: 'application/json' } }),
      )
    },
  )

  it('keeps paid access disabled when the config cannot be read', async () => {
    const invalidResponse = vi.fn(async () => new Response(JSON.stringify({ accessMode: 'other' }), { status: 200 }))
    const failedRequest = vi.fn(async () => { throw new Error('offline') })

    await expect(fetchAppAccessMode('https://api.example.com', invalidResponse)).resolves.toBeNull()
    await expect(fetchAppAccessMode('https://api.example.com', failedRequest)).resolves.toBeNull()
  })
})
