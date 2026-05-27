import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock safeReadFile so SKILL.md reads succeed
const mockSafeReadFile = vi.hoisted(() => vi.fn((path: string) => {
  if (path.endsWith('SKILL.md')) return Promise.resolve('# Skill Name\nA skill')
  if (path.endsWith('DESCRIPTION.md')) return Promise.resolve('# Tools\nTools category')
  return Promise.resolve('')
}))
const mockExtractDescription = vi.hoisted(() => vi.fn(() => 'A skill'))
const mockListFilesRecursive = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  safeReadFile: mockSafeReadFile,
  extractDescription: mockExtractDescription,
  listFilesRecursive: mockListFilesRecursive,
}))

describe('scanSkillsDir symlink handling', () => {
  let root: string

  it('includes real directories as flat skills', async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-symlink-test-'))
    const skillsDir = join(root, 'skills')
    const skillDir = join(skillsDir, 'my-real-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# My Real Skill\ndesc\n', 'utf-8')

    const { scanSkillsDir } = await import('../../packages/server/src/controllers/hermes/skills')
    const result = await scanSkillsDir(skillsDir, new Map(), new Set(), [], new Map())

    const flatSkill = result.flatMap(c => c.skills).find(s => s?.name === 'my-real-skill')
    expect(flatSkill).toBeDefined()
    expect(flatSkill?.name).toBe('my-real-skill')
  })

  it('skips hidden directories (starting with .)', async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-symlink-test-'))
    const skillsDir = join(root, 'skills')
    const hiddenDir = join(skillsDir, '.hidden-skill')
    await mkdir(hiddenDir, { recursive: true })
    await writeFile(join(hiddenDir, 'SKILL.md'), '# Hidden\nsecret\n', 'utf-8')

    const { scanSkillsDir } = await import('../../packages/server/src/controllers/hermes/skills')
    const result = await scanSkillsDir(skillsDir, new Map(), new Set(), [], new Map())

    const allSkillNames = result.flatMap(c => c.skills).map(s => s.name)
    expect(allSkillNames).not.toContain('.hidden-skill')
  })

  it('includes skills installed as valid symlinks', async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-symlink-test-'))
    const skillsDir = join(root, 'skills')
    const realSkillDir = join(root, 'real-skills', 'my-linked-skill')
    await mkdir(realSkillDir, { recursive: true })
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(realSkillDir, 'SKILL.md'), '# Linked Skill\ndesc\n', 'utf-8')
    await symlink(realSkillDir, join(skillsDir, 'my-linked-skill'))

    const { scanSkillsDir } = await import('../../packages/server/src/controllers/hermes/skills')
    const result = await scanSkillsDir(skillsDir, new Map(), new Set(), [], new Map())

    const flatSkill = result.flatMap(c => c.skills).find(s => s?.name === 'my-linked-skill')
    expect(flatSkill).toBeDefined()
    expect(flatSkill?.name).toBe('my-linked-skill')
  })

  it('skips broken symlinks', async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-symlink-test-'))
    const skillsDir = join(root, 'skills')
    const targetDir = join(root, 'vanished')
    await mkdir(targetDir, { recursive: true })
    await mkdir(skillsDir, { recursive: true })
    await symlink(targetDir, join(skillsDir, 'broken-link'))
    await rm(targetDir, { recursive: true })

    const { scanSkillsDir } = await import('../../packages/server/src/controllers/hermes/skills')
    const result = await scanSkillsDir(skillsDir, new Map(), new Set(), [], new Map())

    const allSkillNames = result.flatMap(c => c.skills).map(s => s.name)
    expect(allSkillNames).not.toContain('broken-link')
  })
})