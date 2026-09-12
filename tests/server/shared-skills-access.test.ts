import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { assertCodingAgentSkillWritable } from '../../packages/server/src/modules/studio/public/shared-skills'

it('protects shared roots and aliases for new imports without blocking sibling or private directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-skill-access-'))
  vi.stubEnv('HERMES_CODING_AGENT_GLOBAL_HOME', root)
  try {
    const shared = join(root, '.agents/skills')
    await mkdir(shared, { recursive: true })
    await mkdir(join(root, '.dsh'), { recursive: true })
    await symlink(shared, join(root, '.dsh/skills'), 'dir')
    for (const path of [shared, join(shared, 'new/SKILL.md'), join(root, '.dsh/skills/new/SKILL.md')]) {
      await expect(assertCodingAgentSkillWritable(path)).rejects.toMatchObject({ status: 403 })
    }
    await expect(assertCodingAgentSkillWritable(join(root, '.agents/skills-private/new/SKILL.md'))).resolves.toBeUndefined()
    await expect(assertCodingAgentSkillWritable(join(root, '.claude/skills/new/SKILL.md'))).resolves.toBeUndefined()
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
