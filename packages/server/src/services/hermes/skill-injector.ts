import { copyFile, mkdir, readdir, rm, stat } from 'fs/promises'
import { existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { detectHermesRootHome } from './hermes-path'
import { logger } from '../logger'

export interface SkillInjectionTargetResult {
  profile?: string
  targetDir: string
  injected: string[]
  updated: string[]
  skipped: string[]
}

export interface SkillInjectionResult extends SkillInjectionTargetResult {
  sourceDir: string
  targets: SkillInjectionTargetResult[]
}

export class HermesSkillInjector {
  private readonly targetDirs: string[]

  constructor(
    private readonly sourceDir = HermesSkillInjector.resolveSourceDir(),
    targetDirOrDirs: string | string[] = HermesSkillInjector.resolveTargetDirs(),
  ) {
    const targetDirs = Array.isArray(targetDirOrDirs) ? targetDirOrDirs : [targetDirOrDirs]
    this.targetDirs = [...new Set(targetDirs.map(targetDir => resolve(targetDir)))]
  }

  static resolveSourceDir(env: NodeJS.ProcessEnv = process.env, baseDir = __dirname): string {
    const override = env.HERMES_WEB_UI_SKILLS_DIR?.trim()
    if (override) return resolve(override)

    const candidates = [
      // Production bundle: dist/server/index.js with dist/skills copied by build.
      resolve(baseDir, '../skills'),
      // Development/test: packages/server/src/services/hermes -> packages/skills.
      resolve(baseDir, '../../../../skills'),
      // Running from repository root without bundling.
      resolve(process.cwd(), 'packages/skills'),
    ]

    return candidates.find(candidate => existsSync(candidate)) || candidates[0]
  }

  static resolveTargetDirs(rootDir = detectHermesRootHome()): string[] {
    const root = resolve(rootDir)
    const targetDirs = [join(root, 'skills')]
    const profilesDir = join(root, 'profiles')

    try {
      const entries = readdirSync(profilesDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.trim() && !entry.name.startsWith('.')) {
          targetDirs.push(join(profilesDir, entry.name, 'skills'))
        }
      }
    } catch { /* no named profiles */ }

    return [...new Set(targetDirs.map(targetDir => resolve(targetDir)))]
  }

  static resolveTargetDirForProfile(profile: string, rootDir = detectHermesRootHome()): string {
    const name = String(profile || '').trim()
    const root = resolve(rootDir)
    if (!name || name === 'default') return join(root, 'skills')
    return join(root, 'profiles', name, 'skills')
  }

  private static profileForTargetDir(targetDir: string, rootDir = detectHermesRootHome()): string {
    const root = resolve(rootDir)
    const target = resolve(targetDir)
    if (target === resolve(join(root, 'skills'))) return 'default'

    const profilesRoot = resolve(join(root, 'profiles'))
    const relativeToProfiles = target.startsWith(profilesRoot)
      ? target.slice(profilesRoot.length).replace(/^[/\\]+/, '')
      : ''
    const [profileName, skillsSegment] = relativeToProfiles.split(/[/\\]+/)
    return profileName && skillsSegment === 'skills' ? profileName : 'unknown'
  }

  async injectMissingSkills(): Promise<SkillInjectionResult> {
    const result: SkillInjectionResult = {
      sourceDir: this.sourceDir,
      targetDir: this.targetDirs[0] || '',
      injected: [],
      updated: [],
      skipped: [],
      targets: [],
    }

    if (!await this.isDirectory(this.sourceDir)) {
      logger.debug('[skill-injector] no bundled skills directory at %s', this.sourceDir)
      return result
    }

    const entries = await readdir(this.sourceDir, { withFileTypes: true })
    const bundledSkillNames = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)

    logger.info({
      sourceDir: this.sourceDir,
      targetDirs: this.targetDirs,
      targetCount: this.targetDirs.length,
      bundledSkillNames,
    }, '[skill-injector] syncing bundled skills across profiles')

    for (const targetDir of this.targetDirs) {
      const targetResult = await this.injectIntoTarget(targetDir, entries)
      result.targets.push(targetResult)
      result.injected.push(...targetResult.injected)
      result.updated.push(...targetResult.updated)
      result.skipped.push(...targetResult.skipped)
    }

    logger.info({
      sourceDir: this.sourceDir,
      targetCount: result.targets.length,
      injected: [...new Set(result.injected)],
      updated: [...new Set(result.updated)],
      skipped: [...new Set(result.skipped)],
      targets: result.targets,
    }, '[skill-injector] completed bundled skills sync')

    return result
  }

  private async injectIntoTarget(targetDir: string, entries: import('fs').Dirent[]): Promise<SkillInjectionTargetResult> {
    const profile = HermesSkillInjector.profileForTargetDir(targetDir)
    const result: SkillInjectionTargetResult = {
      profile,
      targetDir,
      injected: [],
      updated: [],
      skipped: [],
    }

    await mkdir(targetDir, { recursive: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const sourceSkillDir = join(this.sourceDir, entry.name)
      const targetSkillDir = join(targetDir, entry.name)
      const existed = existsSync(targetSkillDir)
      if (existsSync(targetSkillDir)) {
        await rm(targetSkillDir, { recursive: true, force: true })
      }
      await this.copyDir(sourceSkillDir, targetSkillDir)
      if (existed) result.updated.push(entry.name)
      else result.injected.push(entry.name)
    }

    if (result.injected.length > 0 || result.updated.length > 0) {
      logger.info({
        profile,
        injected: result.injected,
        updated: result.updated,
        targetDir,
      }, '[skill-injector] synced bundled skills')
    }
    return result
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  }

  private async copyDir(sourceDir: string, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true })
    const entries = await readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name)
      const targetPath = join(targetDir, entry.name)
      if (entry.isDirectory()) {
        await this.copyDir(sourcePath, targetPath)
      } else if (entry.isFile()) {
        await copyFile(sourcePath, targetPath)
      }
    }
  }
}
