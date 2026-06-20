import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'

const mockGetSkillUsageStatsFromDb = vi.hoisted(() => vi.fn())
const mockGetActiveProfileName = vi.hoisted(() => vi.fn())
const mockGetProfileDir = vi.hoisted(() => vi.fn())
const mockUpdateConfigYamlForProfile = vi.hoisted(() => vi.fn())
const mockReadConfigYamlForProfile = vi.hoisted(() => vi.fn())
const mockSafeReadFile = vi.hoisted(() => vi.fn())
const mockExtractDescription = vi.hoisted(() => vi.fn())
const mockListFilesRecursive = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSkillUsageStatsFromDb: mockGetSkillUsageStatsFromDb,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: mockGetActiveProfileName,
  getProfileDir: mockGetProfileDir,
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: mockReadConfigYamlForProfile,
  updateConfigYamlForProfile: mockUpdateConfigYamlForProfile,
  safeReadFile: mockSafeReadFile,
  extractDescription: mockExtractDescription,
  listFilesRecursive: mockListFilesRecursive,
}))

async function loadController() {
  vi.resetModules()
  return import('../../packages/server/src/controllers/hermes/skills')
}

function multipartBody(boundary: string, parts: Array<{ name: string; value: string; filename?: string; filenameStar?: string; contentType?: string }>): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    const filename = part.filenameStar
      ? `; filename*=UTF-8''${part.filenameStar}`
      : part.filename
        ? `; filename="${part.filename}"`
        : ''
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${filename}\r\n`))
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`))
    chunks.push(Buffer.from('\r\n'))
    chunks.push(Buffer.from(part.value))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

describe('skills controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetActiveProfileName.mockReturnValue('default')
    mockGetProfileDir.mockImplementation((profile: string) => `/tmp/hermes-${profile}`)
    mockReadConfigYamlForProfile.mockResolvedValue({})
    mockSafeReadFile.mockImplementation(async (path: string) => {
      try {
        return await readFile(path, 'utf-8')
      } catch {
        return null
      }
    })
    mockExtractDescription.mockImplementation((content: string) => {
      return content.split('\n').find(line => line.trim() && !line.startsWith('#'))?.trim() || ''
    })
    mockListFilesRecursive.mockResolvedValue([])
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => updater({}))
    mockGetSkillUsageStatsFromDb.mockResolvedValue({
      period_days: 7,
      summary: {
        total_skill_loads: 0,
        total_skill_edits: 0,
        total_skill_actions: 0,
        distinct_skills_used: 0,
      },
      by_day: [],
      top_skills: [],
    })
  })

  it('loads skill usage from the request-scoped profile state database', async () => {
    const { usageStats } = await loadController()
    const ctx: any = { query: { days: '30' }, state: { profile: { name: 'research' } }, body: null }

    await usageStats(ctx)

    expect(mockGetSkillUsageStatsFromDb).toHaveBeenCalledWith(30, undefined, 'research')
    expect(ctx.body.period_days).toBe(7)
  })

  it('falls back to active profile when no request profile is set', async () => {
    mockGetActiveProfileName.mockReturnValue('travel')
    const { usageStats } = await loadController()
    const ctx: any = { query: {}, state: {}, body: null }

    await usageStats(ctx)

    expect(mockGetSkillUsageStatsFromDb).toHaveBeenCalledWith(7, undefined, 'travel')
  })

  it('toggles skills in the request-scoped profile config', async () => {
    let updatedConfig: Record<string, any> | undefined
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => {
      updatedConfig = await updater({ skills: { disabled: ['old-skill'] }, model: { default: 'glm-5.1' } })
      return undefined
    })
    const { toggle } = await loadController()
    const ctx: any = {
      request: { body: { name: 'new-skill', enabled: false } },
      state: { profile: { name: 'research' } },
      body: null,
    }

    await toggle(ctx)

    expect(mockUpdateConfigYamlForProfile).toHaveBeenCalledWith('research', expect.any(Function))
    expect(updatedConfig).toEqual({
      skills: { disabled: ['old-skill', 'new-skill'] },
      model: { default: 'glm-5.1' },
    })
    expect(ctx.body).toEqual({ success: true })
  })

  it('lists configured external skill directories with external source while keeping local skills first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-external-skills-'))
    const profileDir = join(root, 'profile')
    const localSkillDir = join(profileDir, 'skills', 'tools', 'dupe-skill')
    const externalDir = join(root, 'external-skills')
    const externalSkillDir = join(externalDir, 'tools', 'external-skill')
    const externalDupeDir = join(externalDir, 'tools', 'dupe-skill')

    await mkdir(localSkillDir, { recursive: true })
    await mkdir(externalSkillDir, { recursive: true })
    await mkdir(externalDupeDir, { recursive: true })
    await writeFile(join(localSkillDir, 'SKILL.md'), '# Local Dupe\nlocal copy\n', 'utf-8')
    await writeFile(join(externalSkillDir, 'SKILL.md'), '# External Skill\nexternal copy\n', 'utf-8')
    await writeFile(join(externalDupeDir, 'SKILL.md'), '# External Dupe\nexternal duplicate\n', 'utf-8')

    mockGetProfileDir.mockReturnValue(profileDir)
    mockReadConfigYamlForProfile.mockResolvedValue({
      skills: { external_dirs: [externalDir] },
    })

    try {
      const { list } = await loadController()
      const ctx: any = { state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      const tools = ctx.body.categories.find((category: any) => category.name === 'tools')
      expect(tools.skills).toEqual([
        expect.objectContaining({ name: 'dupe-skill', source: 'local', description: 'local copy' }),
        expect.objectContaining({ name: 'external-skill', source: 'external', description: 'external copy' }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists flat symlinked skills in the misc category', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-symlink-flat-skill-'))
    const profileDir = join(root, 'profile')
    const profileSkillsDir = join(profileDir, 'skills')
    const sharedSkillDir = join(root, 'shared-skills', 'linked-flat-skill')

    await mkdir(profileSkillsDir, { recursive: true })
    await mkdir(sharedSkillDir, { recursive: true })
    await writeFile(join(sharedSkillDir, 'SKILL.md'), '# Linked Flat Skill\nflat symlink copy\n', 'utf-8')
    await symlink(sharedSkillDir, join(profileSkillsDir, 'linked-flat-skill'))

    mockGetProfileDir.mockReturnValue(profileDir)

    try {
      const { list } = await loadController()
      const ctx: any = { state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      expect(ctx.body.categories).toContainEqual(expect.objectContaining({
        name: 'misc',
        skills: [
          expect.objectContaining({
            name: 'linked-flat-skill',
            source: 'local',
            description: 'flat symlink copy',
          }),
        ],
      }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('traverses symlinked category entries without following hidden or cyclic links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-symlink-category-skill-'))
    const profileDir = join(root, 'profile')
    const toolsDir = join(profileDir, 'skills', 'tools')
    const linkedSkillDir = join(root, 'shared-skills', 'linked-skill')
    const linkedCategoryDir = join(root, 'shared-skills', 'linked-category')

    await mkdir(toolsDir, { recursive: true })
    await mkdir(linkedSkillDir, { recursive: true })
    await mkdir(linkedCategoryDir, { recursive: true })
    await writeFile(join(toolsDir, 'DESCRIPTION.md'), '# Tools\n', 'utf-8')
    await writeFile(join(linkedSkillDir, 'SKILL.md'), '# Linked Skill\nlinked skill copy\n', 'utf-8')
    await writeFile(join(linkedCategoryDir, 'SKILL.md'), '# Linked Category Skill\nlinked category copy\n', 'utf-8')
    await symlink(linkedSkillDir, join(toolsDir, 'linked-skill'))
    await symlink(linkedCategoryDir, join(toolsDir, 'linked-group'))
    await symlink(toolsDir, join(toolsDir, 'loop'))
    await symlink(linkedSkillDir, join(toolsDir, '.hidden-skill'))

    mockGetProfileDir.mockReturnValue(profileDir)

    try {
      const { list } = await loadController()
      const ctx: any = { state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      const tools = ctx.body.categories.find((category: any) => category.name === 'tools')
      expect(tools.skills).toEqual([
        expect.objectContaining({ name: 'linked-group', description: 'linked category copy', source: 'local' }),
        expect.objectContaining({ name: 'linked-skill', description: 'linked skill copy', source: 'local' }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('updates external skill directories in the request-scoped profile config', async () => {
    let updatedConfig: Record<string, any> | undefined
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => {
      updatedConfig = await updater({ skills: { disabled: ['old-skill'] }, model: { default: 'glm-5.1' } })
      return undefined
    })
    const { updateExternalDirs } = await loadController()
    const ctx: any = {
      request: { body: { dirs: [' ~/research-skills ', '', '~/research-skills', '$HOME/shared-skills'] } },
      state: { profile: { name: 'research' } },
      body: null,
    }

    await updateExternalDirs(ctx)

    expect(mockUpdateConfigYamlForProfile).toHaveBeenCalledWith('research', expect.any(Function))
    expect(updatedConfig).toEqual({
      skills: { disabled: ['old-skill'], external_dirs: ['~/research-skills', '$HOME/shared-skills'] },
      model: { default: 'glm-5.1' },
    })
    expect(ctx.body).toEqual({ success: true, dirs: ['~/research-skills', '$HOME/shared-skills'] })
  })

  it('imports skills into the request-scoped profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-import-profile-'))
    const defaultProfileDir = join(root, 'default')
    const researchProfileDir = join(root, 'research')
    mockGetProfileDir.mockImplementation((profile: string) => profile === 'research' ? researchProfileDir : defaultProfileDir)

    const boundary = '----hermes-skill-import-test'
    const ctx: any = {
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, [
        { name: 'file', filename: 'demo-skill/SKILL.md', contentType: 'text/markdown', value: '# Demo Skill\nresearch copy\n' },
      ])]),
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { importSkill } = await loadController()

      await importSkill(ctx)

      await expect(readFile(join(researchProfileDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# Demo Skill\nresearch copy\n')
      await expect(readFile(join(defaultProfileDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf-8')).rejects.toThrow()
      expect(ctx.body).toEqual({ success: true, name: 'demo-skill' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns bad request for malformed encoded skill import filenames', async () => {
    const boundary = '----hermes-skill-import-bad-filename'
    const ctx: any = {
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, [
        { name: 'file', filenameStar: '%E0%A4%A', contentType: 'text/markdown', value: '# Demo Skill\n' },
      ])]),
      state: { profile: { name: 'research' } },
      body: null,
    }

    const { importSkill } = await loadController()

    await importSkill(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Invalid multipart filename encoding' })
  })

  it('imports skills with valid encoded multipart filenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-import-encoded-filename-'))
    const profileDir = join(root, 'research')
    mockGetProfileDir.mockReturnValue(profileDir)

    const boundary = '----hermes-skill-import-encoded-filename'
    const ctx: any = {
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, [
        { name: 'file', filenameStar: 'demo-skill%2FSKILL.md', contentType: 'text/markdown', value: '# Demo Skill\nencoded filename\n' },
      ])]),
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { importSkill } = await loadController()

      await importSkill(ctx)

      await expect(readFile(join(profileDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# Demo Skill\nencoded filename\n')
      expect(ctx.body).toEqual({ success: true, name: 'demo-skill' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deletes local skills only from the request-scoped profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-delete-profile-'))
    const defaultProfileDir = join(root, 'default')
    const researchProfileDir = join(root, 'research')
    const defaultSkillDir = join(defaultProfileDir, 'skills', 'tools', 'dupe-skill')
    const researchSkillDir = join(researchProfileDir, 'skills', 'tools', 'dupe-skill')
    await mkdir(defaultSkillDir, { recursive: true })
    await mkdir(researchSkillDir, { recursive: true })
    await writeFile(join(defaultSkillDir, 'SKILL.md'), '# Default Copy\n', 'utf-8')
    await writeFile(join(researchSkillDir, 'SKILL.md'), '# Research Copy\n', 'utf-8')
    mockGetProfileDir.mockImplementation((profile: string) => profile === 'research' ? researchProfileDir : defaultProfileDir)

    const ctx: any = {
      params: { category: 'tools', skill: 'dupe-skill' },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { deleteSkill } = await loadController()

      await deleteSkill(ctx)

      await expect(readFile(join(defaultSkillDir, 'SKILL.md'), 'utf-8')).resolves.toBe('# Default Copy\n')
      await expect(readFile(join(researchSkillDir, 'SKILL.md'), 'utf-8')).rejects.toThrow()
      expect(ctx.body).toEqual({ success: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
