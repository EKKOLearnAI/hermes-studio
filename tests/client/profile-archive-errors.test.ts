// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/api/client', () => ({
  request: vi.fn(),
  getBaseUrlValue: () => 'http://studio.local',
  getApiKey: () => 'token',
}))

import { exportProfile, importProfile } from '@/api/hermes/profiles'

function jsonResponse(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(['archive']),
  } as any
}

describe('profile archive errors reach the caller', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('passes the export timeout code through instead of a bare false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(504, {
      error: "Export of profile 'mohamed' timed out after 10 minutes — the archive is too large",
      code: 'archive_timeout',
    })))

    const res = await exportProfile('mohamed')

    expect(res.success).toBe(false)
    expect(res.code).toBe('archive_timeout')
    expect(res.error).toContain('timed out')
  })

  it('passes a plain export failure reason through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: "profile 'ghost' not found" })))

    const res = await exportProfile('ghost')

    expect(res.success).toBe(false)
    expect(res.code).toBeUndefined()
    expect(res.error).toContain('not found')
  })

  it('passes the import timeout code through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(504, {
      error: 'Import of profile timed out after 10 minutes — the archive is too large',
      code: 'archive_timeout',
    })))

    const res = await importProfile(new File(['x'], 'profile.tar.gz'))

    expect(res.success).toBe(false)
    expect(res.code).toBe('archive_timeout')
  })

  it('reports success when the server accepts the import', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { success: true })))

    expect(await importProfile(new File(['x'], 'profile.tar.gz'))).toEqual({ success: true })
  })
})
