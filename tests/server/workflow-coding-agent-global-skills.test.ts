import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfileDir: (profile: string) => `/tmp/hermes-${profile}`,
  readConfigYamlForProfile: async () => ({}),
  safeReadFile: async (path: string) => {
    try {
      return await readFile(path, 'utf-8')
    } catch {
      return null
    }
  },
}))

const originalGlobalHome = process.env.HERMES_CODING_AGENT_GLOBAL_HOME

afterEach(() => {
  if (originalGlobalHome == null) delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  else process.env.HERMES_CODING_AGENT_GLOBAL_HOME = originalGlobalHome
})

describe('workflow Coding Agent skill roots', () => {
  it('resolves OpenCode skills from the authoritative global home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-workflow-opencode-skills-'))
    const skillDir = join(root, '.config', 'opencode', 'skills', 'release-notes')
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Release notes\nOpenCode workflow skill.\n', 'utf-8')

    try {
      const { resolveWorkflowSkillContent } = await import(
        '../../packages/server/src/modules/studio/services/workflow/skill-resolver'
      )
      await expect(resolveWorkflowSkillContent({
        agent: 'opencode',
        profile: 'default',
        skillName: 'release-notes',
      })).resolves.toEqual({
        name: 'release-notes',
        target: 'opencode',
        path: join(skillDir, 'SKILL.md'),
        content: '# Release notes\nOpenCode workflow skill.\n',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves OpenCode skills from the shared agent skills directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-workflow-opencode-shared-skills-'))
    const skillDir = join(root, '.agents', 'skills', 'release-notes')
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Release notes\nShared OpenCode workflow skill.\n', 'utf-8')

    try {
      const { resolveWorkflowSkillContent } = await import(
        '../../packages/server/src/modules/studio/services/workflow/skill-resolver'
      )
      await expect(resolveWorkflowSkillContent({
        agent: 'opencode',
        profile: 'default',
        skillName: 'release-notes',
      })).resolves.toEqual({
        name: 'release-notes',
        target: 'opencode',
        path: join(skillDir, 'SKILL.md'),
        content: '# Release notes\nShared OpenCode workflow skill.\n',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
