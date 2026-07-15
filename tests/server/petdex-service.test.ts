import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchPetdexAsset, fetchPetdexManifest } from '../../packages/server/src/services/hermes/petdex'

describe('petdex service', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds local preview proxy URLs to manifest pets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      generatedAt: '2026-06-30T00:00:00.000Z',
      pets: [{
        slug: 'desk-cat',
        displayName: 'Desk Cat',
        kind: 'cat',
        submittedBy: 'petdex',
        spritesheetUrl: 'https://assets.petdex.dev/pets/desk-cat/spritesheet.webp',
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    const manifest = await fetchPetdexManifest({ force: true })

    expect(manifest.pets[0].spritesheetUrl).toBe('https://assets.petdex.dev/pets/desk-cat/spritesheet.webp')
    expect(manifest.pets[0].previewUrl).toBe(
      '/api/hermes/petdex/asset?url=https%3A%2F%2Fassets.petdex.dev%2Fpets%2Fdesk-cat%2Fspritesheet.webp',
    )
  })

  it('only proxies petdex https assets', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchPetdexAsset('https://example.com/pet.webp')).rejects.toThrow('Unsupported petdex asset host')
    await expect(fetchPetdexAsset('http://assets.petdex.dev/pet.webp')).rejects.toThrow('Unsupported petdex asset host')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches allowed petdex image assets with a size limit', async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: {
        'content-type': 'image/webp',
        'content-length': String(body.byteLength),
      },
    })))

    const asset = await fetchPetdexAsset('https://assets.petdex.dev/pets/desk-cat/spritesheet.webp')

    expect(asset.mime).toBe('image/webp')
    expect([...asset.buffer]).toEqual([1, 2, 3, 4])
    expect(asset.maxAgeSeconds).toBe(3600)
  })
})
