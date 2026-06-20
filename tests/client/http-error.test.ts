import { describe, expect, it } from 'vitest'
import { responseErrorMessage } from '@/utils/http-error'

describe('responseErrorMessage', () => {
  it('uses JSON error fields when available', async () => {
    const response = new Response(JSON.stringify({ error: 'Profile access denied' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })

    await expect(responseErrorMessage(response, 'Upload failed')).resolves.toBe('Upload failed: 403 - Profile access denied')
  })

  it('falls back to text response bodies', async () => {
    const response = new Response('Forbidden by policy', { status: 403 })

    await expect(responseErrorMessage(response, 'Upload failed')).resolves.toBe('Upload failed: 403 - Forbidden by policy')
  })

  it('keeps the original status-only fallback when no body exists', async () => {
    const response = new Response('', { status: 500 })

    await expect(responseErrorMessage(response, 'Upload failed')).resolves.toBe('Upload failed: 500')
  })
})
