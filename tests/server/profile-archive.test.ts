import { existsSync, readFileSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  exportProfileWithoutHermes,
  importProfileWithoutHermes,
} from '../../packages/server/src/modules/hermes/services/profiles/archive'

describe('Studio-native profile archives', () => {
  const tempDirectories: string[] = []

  async function tempDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix))
    tempDirectories.push(directory)
    return directory
  }

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  })

  it('round-trips a profile without exporting credentials and fills the Hermes skeleton', async () => {
    const root = await tempDirectory('studio-profile-archive-root-')
    const outputDirectory = await tempDirectory('studio-profile-archive-output-')
    const profileDirectory = join(root, 'profiles', 'work')
    await mkdir(join(profileDirectory, 'skills', 'research'), { recursive: true })
    await mkdir(join(profileDirectory, 'workspace'), { recursive: true })
    await writeFile(join(profileDirectory, 'config.yaml'), 'model:\n  default: test\n', 'utf8')
    await writeFile(join(profileDirectory, '.env'), 'SECRET=do-not-export\n', 'utf8')
    await writeFile(join(profileDirectory, 'auth.json'), '{"access_token":"do-not-export"}\n', 'utf8')
    await writeFile(join(profileDirectory, 'skills', 'research', 'SKILL.md'), '# Research\n', 'utf8')
    await writeFile(join(profileDirectory, 'workspace', 'notes.md'), 'keep me\n', 'utf8')
    const archivePath = join(outputDirectory, 'work.tar.gz')

    await exportProfileWithoutHermes('work', archivePath, root)

    const archiveEntries: string[] = []
    await tar.list({ file: archivePath, onReadEntry: entry => archiveEntries.push(entry.path) })
    expect(archiveEntries.some(path => path.endsWith('/.env'))).toBe(false)
    expect(archiveEntries.some(path => path.endsWith('/auth.json'))).toBe(false)
    expect(archiveEntries).toContain('work/skills/research/SKILL.md')
    expect(archiveEntries).toContain('work/workspace/notes.md')

    await rm(profileDirectory, { recursive: true, force: true })
    const result = await importProfileWithoutHermes(archivePath, root)

    expect(result).toMatchObject({ name: 'work', message: "Profile 'work' imported by Studio" })
    expect(await readFile(join(profileDirectory, 'config.yaml'), 'utf8')).toContain('default: test')
    expect(await readFile(join(profileDirectory, 'skills', 'research', 'SKILL.md'), 'utf8')).toBe('# Research\n')
    expect(await readFile(join(profileDirectory, 'workspace', 'notes.md'), 'utf8')).toBe('keep me\n')
    expect(readFileSync(join(profileDirectory, '.env'), 'utf8')).not.toContain('do-not-export')
    expect(existsSync(join(profileDirectory, 'auth.json'))).toBe(false)
    expect(existsSync(join(profileDirectory, 'SOUL.md'))).toBe(true)
    expect(existsSync(join(profileDirectory, 'sessions'))).toBe(true)
  })

  it('imports a ZIP archive containing one profile directory', async () => {
    const root = await tempDirectory('studio-profile-zip-root-')
    const outputDirectory = await tempDirectory('studio-profile-zip-output-')
    const archivePath = join(outputDirectory, 'travel.zip')
    const zip = new AdmZip()
    zip.addFile('travel/config.yaml', Buffer.from('model:\n  default: zip-model\n'))
    zip.addFile('travel/memories/MEMORY.md', Buffer.from('remember this\n'))
    zip.writeZip(archivePath)

    const result = await importProfileWithoutHermes(archivePath, root)

    expect(result.name).toBe('travel')
    expect(await readFile(join(root, 'profiles', 'travel', 'config.yaml'), 'utf8')).toContain('zip-model')
    expect(await readFile(join(root, 'profiles', 'travel', 'memories', 'MEMORY.md'), 'utf8')).toBe('remember this\n')
  })

  it('rejects unsafe ZIP paths before writing outside the extraction directory', async () => {
    const root = await tempDirectory('studio-profile-unsafe-root-')
    const outputDirectory = await tempDirectory('studio-profile-unsafe-output-')
    const archivePath = join(outputDirectory, 'unsafe.zip')
    const zip = new AdmZip()
    const safeName = 'safe/outside/config.yaml'
    const unsafeName = '../x/outside/config.yaml'
    zip.addFile(safeName, Buffer.from('unsafe\n'))
    const archive = zip.toBuffer()
    let offset = archive.indexOf(Buffer.from(safeName))
    while (offset >= 0) {
      archive.write(unsafeName, offset, 'utf8')
      offset = archive.indexOf(Buffer.from(safeName), offset + unsafeName.length)
    }
    await writeFile(archivePath, archive)

    await expect(importProfileWithoutHermes(archivePath, root)).rejects.toMatchObject({
      code: 'profile_archive_invalid',
      status: 400,
    })
    expect(existsSync(join(root, 'profiles', 'outside'))).toBe(false)
  })

  it('rejects an imported profile that already exists', async () => {
    const root = await tempDirectory('studio-profile-collision-root-')
    const outputDirectory = await tempDirectory('studio-profile-collision-output-')
    await mkdir(join(root, 'profiles', 'work'), { recursive: true })
    const archivePath = join(outputDirectory, 'work.zip')
    const zip = new AdmZip()
    zip.addFile('work/config.yaml', Buffer.from('new config\n'))
    zip.writeZip(archivePath)

    await expect(importProfileWithoutHermes(archivePath, root)).rejects.toMatchObject({
      code: 'profile_exists',
      status: 409,
    })
  })
})
