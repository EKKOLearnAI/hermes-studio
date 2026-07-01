import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getActivePet, updateActivePetPreferences } from '../../packages/server/src/services/hermes/pets'

const originalWebUiHome = process.env.HERMES_WEB_UI_HOME

let hermesHome = ''

function profilePetsDir(profile: string): string {
  const segment = Buffer.from(profile || 'default', 'utf-8').toString('base64url')
  return join(hermesHome, 'profile-metadata', segment, 'pets')
}

async function writeInstalledPet(profile: string, slug: string): Promise<string> {
  const petsDir = profilePetsDir(profile)
  const petDir = join(petsDir, slug)
  await mkdir(petDir, { recursive: true })
  await writeFile(join(petDir, 'spritesheet.webp'), Buffer.from([1, 2, 3]))
  await writeFile(join(petDir, 'pet.json'), `${JSON.stringify({
    slug,
    displayName: 'Desk Cat',
    kind: 'cat',
    submittedBy: 'petdex',
    source: 'petdex',
    spritesheetUrl: 'https://assets.petdex.dev/pets/desk-cat/spritesheet.webp',
    petJsonUrl: '',
    zipUrl: '',
    spritesheetFile: 'spritesheet.webp',
    mime: 'image/webp',
    installedAt: 1,
    updatedAt: 1,
  }, null, 2)}\n`)
  await writeFile(join(petsDir, 'active.json'), `${JSON.stringify({
    enabled: true,
    slug,
    scale: 0.42,
    position: { x: 15, y: 30 },
    updatedAt: 2,
  }, null, 2)}\n`)
  return join(petsDir, 'active.json')
}

describe('pets service', () => {
  beforeEach(async () => {
    hermesHome = await mkdtemp(join(tmpdir(), 'hermes-pets-service-'))
    process.env.HERMES_WEB_UI_HOME = hermesHome
  })

  afterEach(async () => {
    await rm(hermesHome, { recursive: true, force: true })
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
  })

  it('persists disabled active pet state and stops returning it as active', async () => {
    const profile = 'default'
    const activePath = await writeInstalledPet(profile, 'desk-cat')

    await expect(getActivePet(profile)).resolves.toMatchObject({
      enabled: true,
      slug: 'desk-cat',
      scale: 0.42,
    })

    await expect(updateActivePetPreferences(profile, { enabled: false })).resolves.toBeNull()
    await expect(getActivePet(profile)).resolves.toBeNull()

    const active = JSON.parse(await readFile(activePath, 'utf-8'))
    expect(active).toMatchObject({
      enabled: false,
      slug: 'desk-cat',
      scale: 0.42,
    })
  })
})
