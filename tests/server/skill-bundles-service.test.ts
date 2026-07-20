import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import YAML from 'js-yaml'
import {
  createSkillBundle,
  deleteSkillBundle,
  listSkillBundles,
  SkillBundleConflictError,
  SkillBundleValidationError,
} from '../../packages/server/src/services/hermes/skill-bundles'

describe('skill bundle service', () => {
  let root = ''
  let previousHermesHome: string | undefined

  beforeEach(async () => {
    previousHermesHome = process.env.HERMES_HOME
    root = await mkdtemp(join(tmpdir(), 'hermes-studio-bundles-'))
    process.env.HERMES_HOME = root
    await mkdir(join(root, 'profiles', 'work'), { recursive: true })
  })

  afterEach(async () => {
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = previousHermesHome
    await rm(root, { recursive: true, force: true })
  })

  it('creates and lists bundles inside the requested profile', async () => {
    const bundle = await createSkillBundle('work', {
      name: 'PR Review Team',
      description: 'Review a pull request from several angles',
      skills: ['github-review', 'security-review', 'github-review'],
    })

    expect(bundle).toEqual({
      name: 'PR Review Team',
      commandName: 'pr-review-team',
      description: 'Review a pull request from several angles',
      skills: ['github-review', 'security-review'],
    })
    expect(await listSkillBundles('default')).toEqual([])
    expect(await listSkillBundles('work')).toEqual([bundle])

    const saved = YAML.load(await readFile(join(root, 'profiles', 'work', 'skill-bundles', 'pr-review-team.yaml'), 'utf-8'))
    expect(saved).toEqual({
      name: 'PR Review Team',
      description: 'Review a pull request from several angles',
      skills: ['github-review', 'security-review'],
    })
  })

  it('reads existing yaml bundles and skips malformed or duplicate commands', async () => {
    const dir = join(root, 'skill-bundles')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.yaml'), 'name: Release Team\ndescription: First\nskills:\n  - changelog\n', 'utf-8')
    await writeFile(join(dir, 'b.yml'), 'name: release_team\ndescription: Duplicate\nskills:\n  - publish\n', 'utf-8')
    await writeFile(join(dir, 'broken.yaml'), 'name: [not valid', 'utf-8')

    expect(await listSkillBundles('default')).toEqual([
      {
        name: 'Release Team',
        commandName: 'release-team',
        description: 'First',
        skills: ['changelog'],
      },
    ])
  })

  it('rejects reserved, empty, and duplicate bundle commands', async () => {
    await expect(createSkillBundle('default', { name: '代码审查', skills: ['one'] }))
      .rejects.toBeInstanceOf(SkillBundleValidationError)
    await expect(createSkillBundle('default', { name: 'Review 审查', skills: ['one'] }))
      .rejects.toBeInstanceOf(SkillBundleValidationError)
    await expect(createSkillBundle('default', { name: 'create', skills: ['one'] }))
      .rejects.toBeInstanceOf(SkillBundleValidationError)
    await expect(createSkillBundle('default', { name: 'Review', skills: [] }))
      .rejects.toBeInstanceOf(SkillBundleValidationError)

    await createSkillBundle('default', { name: 'Review Team', skills: ['one'] })
    await expect(createSkillBundle('default', { name: 'review_team', skills: ['two'] }))
      .rejects.toBeInstanceOf(SkillBundleConflictError)
  })

  it('deletes only the requested profile bundle', async () => {
    await createSkillBundle('default', { name: 'Review Team', skills: ['default-review'] })
    await createSkillBundle('work', { name: 'Review Team', skills: ['work-review'] })

    await deleteSkillBundle('work', 'review-team')

    expect(await listSkillBundles('work')).toEqual([])
    expect(await listSkillBundles('default')).toEqual([
      expect.objectContaining({ commandName: 'review-team', skills: ['default-review'] }),
    ])
  })
})
