import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillListTool, SkillViewTool } from '../../packages/ekko-agent/src'

let root = ''
let skillDirectory = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ekko-agent-skills-'))
  skillDirectory = join(root, 'profile-skills')
  await mkdir(join(skillDirectory, 'writing', 'release-notes'), { recursive: true })
  await mkdir(join(skillDirectory, 'local-only'), { recursive: true })
  await writeFile(
    join(skillDirectory, 'writing', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: "Write polished release summaries."\n---\n# Release Notes\nLocal instructions.\n',
  )
  await writeFile(
    join(skillDirectory, 'local-only', 'SKILL.md'),
    '# Local Only\nUse local guidance.\n',
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ekko-agent skill tools', () => {
  it('returns empty successful results when the agent has no configured skill directory', async () => {
    const listResult = await new SkillListTool().execute({})
    expect(listResult.ok).toBe(true)
    expect(JSON.parse(listResult.content)).toMatchObject({
      count: 0,
      total: 0,
      skills: [],
    })

    await expect(new SkillViewTool().execute({ name: 'anything' })).resolves.toEqual({
      ok: true,
      content: '',
    })
  })

  it('lists skills only from the directory bound at tool construction', async () => {
    const otherSkills = join(root, 'other-skills')
    await mkdir(join(otherSkills, 'not-visible'), { recursive: true })
    await writeFile(join(otherSkills, 'not-visible', 'SKILL.md'), '# Hidden\nOutside the configured directory.\n')

    const result = await new SkillListTool(skillDirectory).execute({})
    const payload = JSON.parse(result.content)

    expect(payload.skills).toEqual([
      { name: 'local-only', description: 'Use local guidance.' },
      { name: 'release-notes', description: 'Write polished release summaries.' },
    ])
    expect(payload.total).toBe(2)
  })

  it('searches skill names and descriptions and applies the result limit', async () => {
    const result = await new SkillListTool(skillDirectory).execute({ query: 'write', limit: 1 })
    const payload = JSON.parse(result.content)

    expect(payload.query).toBe('write')
    expect(payload.count).toBe(1)
    expect(payload.skills).toEqual([
      { name: 'release-notes', description: 'Write polished release summaries.' },
    ])
  })

  it('loads an exact skill with the usage-compatible skill_view prefix', async () => {
    const result = await new SkillViewTool(skillDirectory).execute({ name: 'release-notes' })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('[skill_view] name=release-notes')
    expect(result.content).toContain('Local instructions.')
  })

  it('does not resolve path-like skill names outside the configured directory', async () => {
    const tool = new SkillViewTool(skillDirectory)

    await expect(tool.execute({ name: '../release-notes' })).resolves.toMatchObject({ ok: false })
  })

  it('does not follow cyclic directory symlinks forever', async () => {
    const category = join(skillDirectory, 'cyclic')
    await mkdir(category, { recursive: true })
    await symlink(category, join(category, 'loop'))

    const result = await new SkillListTool(skillDirectory).execute({})

    expect(result.ok).toBe(true)
  })
})
