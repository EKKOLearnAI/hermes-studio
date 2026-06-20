import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []
const originalHermesHome = process.env.HERMES_HOME
const originalSkillsDir = process.env.HERMES_WEB_UI_SKILLS_DIR

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function readManifest(skillsDir: string) {
  return JSON.parse(await readFile(join(skillsDir, '.webui-managed-skills.json'), 'utf-8'))
}

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  if (originalSkillsDir === undefined) delete process.env.HERMES_WEB_UI_SKILLS_DIR
  else process.env.HERMES_WEB_UI_SKILLS_DIR = originalSkillsDir
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('HermesSkillInjector', () => {
  it('resolves source directories for override, production bundle, and development layouts', async () => {
    const root = await tempDir('hermes-skill-injector-paths-')
    const override = join(root, 'override-skills')
    const distSkills = join(root, 'dist', 'skills')
    const devSkills = join(root, 'packages', 'skills')
    await mkdir(override, { recursive: true })
    await mkdir(distSkills, { recursive: true })
    await mkdir(devSkills, { recursive: true })

    const { HermesSkillInjector } = await import('../../packages/server/src/services/hermes/skill-injector')

    expect(HermesSkillInjector.resolveSourceDir({ HERMES_WEB_UI_SKILLS_DIR: override } as any, join(root, 'dist', 'server'))).toBe(override)
    expect(HermesSkillInjector.resolveSourceDir({} as any, join(root, 'dist', 'server'))).toBe(distSkills)
    expect(HermesSkillInjector.resolveSourceDir({} as any, join(root, 'packages', 'server', 'src', 'services', 'hermes'))).toBe(devSkills)
  })

  it('injects missing skills but skips existing user-owned skills with the same name', async () => {
    const source = await tempDir('hermes-skill-source-')
    const hermesHome = await tempDir('hermes-skill-home-')
    process.env.HERMES_HOME = hermesHome

    await mkdir(join(source, 'new-skill'), { recursive: true })
    await writeFile(join(source, 'new-skill', 'SKILL.md'), '# New Skill\n', 'utf-8')
    await mkdir(join(source, 'existing-skill'), { recursive: true })
    await writeFile(join(source, 'existing-skill', 'SKILL.md'), '# Bundled Existing\n', 'utf-8')

    await mkdir(join(hermesHome, 'skills', 'existing-skill'), { recursive: true })
    await writeFile(join(hermesHome, 'skills', 'existing-skill', 'SKILL.md'), '# User Existing\n', 'utf-8')

    const { HermesSkillInjector } = await import('../../packages/server/src/services/hermes/skill-injector')
    const result = await new HermesSkillInjector(source).injectMissingSkills()

    expect(result.injected).toEqual(['new-skill'])
    expect(result.updated).toEqual([])
    expect(result.skipped).toEqual(['existing-skill'])
    await expect(readFile(join(hermesHome, 'skills', 'new-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# New Skill\n')
    await expect(readFile(join(hermesHome, 'skills', 'existing-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# User Existing\n')
    await expect(readManifest(join(hermesHome, 'skills'))).resolves.toMatchObject({ 'new-skill': { owner: 'hermes-web-ui' } })
    expect(existsSync(join(hermesHome, 'skills', 'new-skill', '.wui-managed.json'))).toBe(false)
    expect(existsSync(join(hermesHome, 'skills', 'existing-skill', '.wui-managed.json'))).toBe(false)
  })

  it('updates existing Web UI-managed bundled copies', async () => {
    const sourceV1 = await tempDir('hermes-skill-source-v1-')
    const sourceV2 = await tempDir('hermes-skill-source-v2-')
    const hermesHome = await tempDir('hermes-skill-home-')
    process.env.HERMES_HOME = hermesHome

    await mkdir(join(sourceV1, 'webui-skill'), { recursive: true })
    await writeFile(join(sourceV1, 'webui-skill', 'SKILL.md'), '# WebUI Skill v1\n', 'utf-8')
    await mkdir(join(sourceV2, 'webui-skill'), { recursive: true })
    await writeFile(join(sourceV2, 'webui-skill', 'SKILL.md'), '# WebUI Skill v2\n', 'utf-8')

    const { HermesSkillInjector } = await import('../../packages/server/src/services/hermes/skill-injector')
    await new HermesSkillInjector(sourceV1).injectMissingSkills()
    const result = await new HermesSkillInjector(sourceV2).injectMissingSkills()

    expect(result.injected).toEqual([])
    expect(result.updated).toEqual(['webui-skill'])
    expect(result.skipped).toEqual([])
    await expect(readFile(join(hermesHome, 'skills', 'webui-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# WebUI Skill v2\n')
    await expect(readManifest(join(hermesHome, 'skills'))).resolves.toMatchObject({ 'webui-skill': { owner: 'hermes-web-ui' } })
  })

  it('ignores common OS metadata files when deciding whether a managed copy can update', async () => {
    const sourceV1 = await tempDir('hermes-skill-source-v1-')
    const sourceV2 = await tempDir('hermes-skill-source-v2-')
    const hermesHome = await tempDir('hermes-skill-home-')
    process.env.HERMES_HOME = hermesHome

    await mkdir(join(sourceV1, 'webui-skill'), { recursive: true })
    await writeFile(join(sourceV1, 'webui-skill', 'SKILL.md'), '# WebUI Skill v1\n', 'utf-8')
    await mkdir(join(sourceV2, 'webui-skill'), { recursive: true })
    await writeFile(join(sourceV2, 'webui-skill', 'SKILL.md'), '# WebUI Skill v2\n', 'utf-8')

    const { HermesSkillInjector } = await import('../../packages/server/src/services/hermes/skill-injector')
    await new HermesSkillInjector(sourceV1).injectMissingSkills()
    await writeFile(join(hermesHome, 'skills', 'webui-skill', '.DS_Store'), 'finder metadata', 'utf-8')
    const result = await new HermesSkillInjector(sourceV2).injectMissingSkills()

    expect(result.updated).toEqual(['webui-skill'])
    expect(result.skipped).toEqual([])
    await expect(readFile(join(hermesHome, 'skills', 'webui-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# WebUI Skill v2\n')
  })

  it('adopts identical existing bundled copies without overwriting local files', async () => {
    const source = await tempDir('hermes-skill-source-')
    const hermesHome = await tempDir('hermes-skill-home-')
    process.env.HERMES_HOME = hermesHome

    await mkdir(join(source, 'webui-skill'), { recursive: true })
    await writeFile(join(source, 'webui-skill', 'SKILL.md'), '# WebUI Skill\n', 'utf-8')
    await mkdir(join(hermesHome, 'skills', 'webui-skill'), { recursive: true })
    await writeFile(join(hermesHome, 'skills', 'webui-skill', 'SKILL.md'), '# WebUI Skill\n', 'utf-8')

    const { HermesSkillInjector } = await import('../../packages/server/src/services/hermes/skill-injector')
    const result = await new HermesSkillInjector(source).injectMissingSkills()

    expect(result.injected).toEqual([])
    expect(result.updated).toEqual(['webui-skill'])
    expect(result.skipped).toEqual([])
    await expect(readFile(join(hermesHome, 'skills', 'webui-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# WebUI Skill\n')
    await expect(readManifest(join(hermesHome, 'skills'))).resolves.toMatchObject({ 'webui-skill': { owner: 'hermes-web-ui' } })
  })

  it('syncs bundled skills into default and named profiles without overwriting user-owned conflicts', async () => {
    const source = await tempDir('hermes-skill-source-')
    const hermesHome = await tempDir('hermes-skill-home-')
    process.env.HERMES_HOME = hermesHome

    await mkdir(join(source, 'webui-skill'), { recursive: true })
    await writeFile(join(source, 'webui-skill', 'SKILL.md'), '# WebUI Skill\n', 'utf-8')

    await mkdir(join(hermesHome, 'skills', 'webui-skill'), { recursive: true })
    await writeFile(join(hermesHome, 'skills', 'webui-skill', 'SKILL.md'), '# User WebUI Skill\n', 'utf-8')
    await mkdir(join(hermesHome, 'skills', 'local-skill'), { recursive: true })
    await writeFile(join(hermesHome, 'skills', 'local-skill', 'SKILL.md'), '# Local Skill\n', 'utf-8')

    await mkdir(join(hermesHome, 'profiles', 'alpha', 'skills'), { recursive: true })
    await mkdir(join(hermesHome, 'profiles', 'beta', 'skills', 'webui-skill'), { recursive: true })
    await writeFile(join(hermesHome, 'profiles', 'beta', 'skills', 'webui-skill', 'SKILL.md'), '# Old Profile Skill\n', 'utf-8')
    await mkdir(join(hermesHome, 'profiles', 'beta', 'skills', 'profile-local'), { recursive: true })
    await writeFile(join(hermesHome, 'profiles', 'beta', 'skills', 'profile-local', 'SKILL.md'), '# Profile Local\n', 'utf-8')

    const { HermesSkillInjector } = await import('../../packages/server/src/services/hermes/skill-injector')
    const result = await new HermesSkillInjector(source).injectMissingSkills()

    expect(result.targets.map(target => target.targetDir)).toEqual([
      join(hermesHome, 'skills'),
      join(hermesHome, 'profiles', 'alpha', 'skills'),
      join(hermesHome, 'profiles', 'beta', 'skills'),
    ])
    expect(result.injected).toEqual(['webui-skill'])
    expect(result.updated).toEqual([])
    expect(result.skipped).toEqual(['webui-skill', 'webui-skill'])

    await expect(readFile(join(hermesHome, 'skills', 'webui-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# User WebUI Skill\n')
    await expect(readFile(join(hermesHome, 'profiles', 'alpha', 'skills', 'webui-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# WebUI Skill\n')
    await expect(readFile(join(hermesHome, 'profiles', 'beta', 'skills', 'webui-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# Old Profile Skill\n')
    await expect(readFile(join(hermesHome, 'skills', 'local-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# Local Skill\n')
    await expect(readFile(join(hermesHome, 'profiles', 'beta', 'skills', 'profile-local', 'SKILL.md'), 'utf-8')).resolves.toBe('# Profile Local\n')
  })
})
