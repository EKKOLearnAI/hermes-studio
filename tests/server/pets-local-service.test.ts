import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  adoptInstalledPet,
  deleteInstalledPet,
  getActivePet,
  getLocalPetAsset,
  importLocalPet,
  listInstalledPets,
} from '../../packages/server/src/services/hermes/pets'

const originalWebUiHome = process.env.HERMES_WEB_UI_HOME

let hermesHome = ''

function profilePetsDir(profile: string): string {
  const segment = Buffer.from(profile || 'default', 'utf-8').toString('base64url')
  return join(hermesHome, 'profile-metadata', segment, 'pets')
}

/** Write a fully-populated pet meta + sprite on disk, as if adopted from petdex. */
async function writePetdexPet(profile: string, slug: string): Promise<void> {
  const petDir = join(profilePetsDir(profile), slug)
  await mkdir(petDir, { recursive: true })
  await writeFile(join(petDir, 'spritesheet.webp'), Buffer.from([9, 9, 9]))
  await writeFile(join(petDir, 'pet.json'), `${JSON.stringify({
    slug,
    displayName: 'Desk Cat',
    kind: 'cat',
    submittedBy: 'petdex',
    source: 'petdex',
    spritesheetUrl: `https://assets.petdex.dev/pets/${slug}/spritesheet.webp`,
    petJsonUrl: '',
    zipUrl: '',
    spritesheetFile: 'spritesheet.webp',
    mime: 'image/webp',
    installedAt: 1,
    updatedAt: 1,
  }, null, 2)}\n`)
}

describe('pets local service', () => {
  beforeEach(async () => {
    hermesHome = await mkdtemp(join(tmpdir(), 'hermes-pets-local-'))
    process.env.HERMES_WEB_UI_HOME = hermesHome
  })

  afterEach(async () => {
    await rm(hermesHome, { recursive: true, force: true })
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
  })

  describe('importLocalPet', () => {
    it('persists spritesheet + pet.json and returns local metadata', async () => {
      const profile = 'default'
      const result = await importLocalPet(profile, {
        slug: 'My Pet',
        displayName: '椎年SaRo',
        kind: 'pet',
        submittedBy: 'thomas',
        spritesheet: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
        spritesheetFilename: 'sprite.png',
        petJson: JSON.stringify({ displayName: '椎年SaRo', kind: 'pet', submittedBy: 'thomas' }),
      })

      expect(result.slug).toBe('my-pet')
      expect(result.displayName).toBe('椎年SaRo')
      expect(result.source).toBe('local')
      expect(result.spritesheetFile).toBe('spritesheet.png')
      expect(result.petJsonFile).toBe('local-pet.json')
      expect(result.mime).toBe('image/png')

      const petDir = join(profilePetsDir(profile), 'my-pet')
      const files = await readdir(petDir)
      expect(files).toContain('spritesheet.png')
      expect(files).toContain('local-pet.json')
      const stored = JSON.parse(await readFile(join(petDir, 'pet.json'), 'utf-8'))
      expect(stored).toMatchObject({
        slug: 'my-pet',
        displayName: '椎年SaRo',
        source: 'local',
      })
    })

    it('throws when spritesheet is empty', async () => {
      await expect(importLocalPet('default', {
        slug: 'x',
        displayName: 'x',
        kind: 'pet',
        submittedBy: 'me',
        spritesheet: Buffer.alloc(0),
        spritesheetFilename: 'x.png',
      })).rejects.toThrow('Pet spritesheet is required')
    })

    it('re-importing the same slug clears stale files from a previous extension', async () => {
      const profile = 'default'
      const input = (filename: string, mime: Buffer) => ({
        slug: 'pet-a',
        displayName: 'Pet A',
        kind: 'pet',
        submittedBy: 'me',
        spritesheet: mime,
        spritesheetFilename: filename,
      })

      await importLocalPet(profile, input('first.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])))
      // Re-import with a different extension (webp, no png magic) — old .png must be gone.
      await importLocalPet(profile, input('second.webp', Buffer.from([1, 2, 3])))

      const petDir = join(profilePetsDir(profile), 'pet-a')
      const files = await readdir(petDir)
      expect(files).not.toContain('spritesheet.png')
      expect(files).toContain('spritesheet.webp')
    })
  })

  describe('listInstalledPets', () => {
    it('returns an empty list when no pets are installed', async () => {
      await expect(listInstalledPets('default')).resolves.toEqual([])
    })

    it('lists both local imports and petdex-source pets, newest first', async () => {
      const profile = 'default'
      await writePetdexPet(profile, 'desk-cat')
      await importLocalPet(profile, {
        slug: 'local-pet',
        displayName: 'Local Pet',
        kind: 'pet',
        submittedBy: 'me',
        spritesheet: Buffer.from([1, 2, 3]),
        spritesheetFilename: 's.webp',
      })

      const pets = await listInstalledPets(profile)
      // The local import happened after the petdex pet, so it sorts first.
      expect(pets[0].slug).toBe('local-pet')
      expect(pets[1].slug).toBe('desk-cat')
      expect(pets[1].source).toBe('petdex')
      expect(pets[1].mime).toBe('image/webp')
    })

    it('falls back to filename-derived mime when stored mime is missing', async () => {
      const profile = 'default'
      const petDir = join(profilePetsDir(profile), 'legacy')
      await mkdir(petDir, { recursive: true })
      await writeFile(join(petDir, 'spritesheet.png'), Buffer.from([1]))
      await writeFile(join(petDir, 'pet.json'), `${JSON.stringify({
        slug: 'legacy',
        displayName: 'Legacy',
        kind: 'pet',
        submittedBy: '',
        source: 'local',
        spritesheetUrl: '',
        petJsonUrl: '',
        zipUrl: '',
        spritesheetFile: 'spritesheet.png',
        // no mime field — simulate an old record
        installedAt: 5,
        updatedAt: 5,
      }, null, 2)}\n`)

      const pets = await listInstalledPets(profile)
      expect(pets[0].mime).toBe('image/png')
    })
  })

  describe('getLocalPetAsset', () => {
    it('returns the sprite buffer and mime', async () => {
      const profile = 'default'
      await importLocalPet(profile, {
        slug: 'asset-pet',
        displayName: 'Asset Pet',
        kind: 'pet',
        submittedBy: 'me',
        spritesheet: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8]),
        spritesheetFilename: 'sprite.png',
      })

      const asset = await getLocalPetAsset(profile, 'asset-pet')
      expect(asset).not.toBeNull()
      expect(asset!.mime).toBe('image/png')
      expect(asset!.buffer).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8]))
    })

    it('returns null for unknown pets', async () => {
      await expect(getLocalPetAsset('default', 'nope')).resolves.toBeNull()
    })
  })

  describe('deleteInstalledPet', () => {
    it('removes the pet directory and reports deleted', async () => {
      const profile = 'default'
      await importLocalPet(profile, {
        slug: 'gone-pet',
        displayName: 'Gone Pet',
        kind: 'pet',
        submittedBy: 'me',
        spritesheet: Buffer.from([1, 2, 3]),
        spritesheetFilename: 's.webp',
      })

      const result = await deleteInstalledPet(profile, 'gone-pet')
      expect(result).toEqual({ deleted: true, wasActive: false })
      await expect(getLocalPetAsset(profile, 'gone-pet')).resolves.toBeNull()
    })

    it('clears active config when deleting the active pet', async () => {
      const profile = 'default'
      await importLocalPet(profile, {
        slug: 'active-pet',
        displayName: 'Active Pet',
        kind: 'pet',
        submittedBy: 'me',
        spritesheet: Buffer.from([1, 2, 3]),
        spritesheetFilename: 's.webp',
      })
      await adoptInstalledPet(profile, 'active-pet')
      await expect(getActivePet(profile)).resolves.toMatchObject({ slug: 'active-pet' })

      const result = await deleteInstalledPet(profile, 'active-pet')
      expect(result).toEqual({ deleted: true, wasActive: true })
      await expect(getActivePet(profile)).resolves.toBeNull()
    })

    it('throws when the pet does not exist', async () => {
      await expect(deleteInstalledPet('default', 'missing')).rejects.toThrow('was not found')
    })
  })

  describe('adoptInstalledPet', () => {
    it('throws when the pet is not installed locally', async () => {
      await expect(adoptInstalledPet('default', 'unknown')).rejects.toThrow('was not found')
    })

    it('activates an installed pet and returns its active response', async () => {
      const profile = 'default'
      await importLocalPet(profile, {
        slug: 'adopt-me',
        displayName: 'Adopt Me',
        kind: 'pet',
        submittedBy: 'me',
        spritesheet: Buffer.from([5, 6, 7]),
        spritesheetFilename: 's.webp',
      })

      const response = await adoptInstalledPet(profile, 'adopt-me')
      expect(response).toMatchObject({
        enabled: true,
        slug: 'adopt-me',
        displayName: 'Adopt Me',
        kind: 'pet',
      })
      await expect(getActivePet(profile)).resolves.toMatchObject({ slug: 'adopt-me' })
    })
  })
})
