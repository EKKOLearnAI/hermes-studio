import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

async function loadController() {
  const { scanSkillsDir } = await import('../../packages/server/src/controllers/hermes/skills')
  return { scanSkillsDir }
}

describe('scanSkillsDir symlink handling', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-symlink-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('includes real directories in skills list', async () => {
    const skillsDir = join(root, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await mkdir(join(skillsDir, 'real-skill'), { recursive: true })
    await writeFile(join(skillsDir, 'real-skill', 'SKILL.md'), '# Real Skill\ncontent', 'utf-8')

    const { scanSkillsDir } = await loadController()
    const result = await scanSkillsDir(skillsDir, new Map(), new Set(), [], new Map())

    const flatSkill = result.flatMap(c => c.skills).find(s => s?.name === 'real-skill')
    expect(flatSkill).toBeDefined()
  })

  it('includes valid symlinks pointing to directories in skills list', async () => {
    const skillsDir = join(root, 'skills')
    const targetDir = join(root, 'target-skill')
    await mkdir(skillsDir, { recursive: true })
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'SKILL.md'), '# Symlink Skill\ncontent', 'utf-8')
    await symlink(targetDir, join(skillsDir, 'symlink-skill'), 'junction')

    const { scanSkillsDir } = await loadController()
    const result = await scanSkillsDir(skillsDir, new Map(), new Set(), [], new Map())

    const flatSkill = result.flatMap(c => c.skills).find(s => s?.name === 'symlink-skill')
    expect(flatSkill).toBeDefined()
  })

  it('skips broken symlinks (target does not exist)', async () => {
    const skillsDir = join(root, 'skills')
    const brokenTarget = join(root, 'non-existent-target')
    await mkdir(skillsDir, { recursive: true })
    // Don't create the target — this makes it a broken symlink
    await symlink(brokenTarget, join(skillsDir, 'broken-symlink'), 'junction')

    const { scanSkillsDir } = await loadController()
    const result = await scanSkillsDir(skillsDir, new Map(), new Set(), [], new Map())

    const allSkillNames = result.flatMap(c => c.skills).map(s => s?.name)
    expect(allSkillNames).not.toContain('broken-symlink')
  })

  it('skips hidden directories (starting with .)', async () => {
    const skillsDir = join(root, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await mkdir(join(skillsDir, '.hidden-skill'), { recursive: true })
    await writeFile(join(skillsDir, '.hidden-skill', 'SKILL.md'), '# Hidden\ncontent', 'utf-8')

    const { scanSkillsDir } = await loadController()
    const result = await scanSkillsDir(skillsDir, new Map(), new Set(), [], new Map())

    const allSkillNames = result.flatMap(c => c.skills).map(s => s?.name)
    expect(allSkillNames).not.toContain('.hidden-skill')
  })
})