import { execFileSync } from 'child_process'
import { resolve } from 'path'

function readGitValue(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function normalizeBranch(branch) {
  if (!branch || branch === 'HEAD') return ''
  return branch
}

export function getGitBuildMetadata(repoRoot, env = process.env) {
  const root = resolve(repoRoot)

  const sha = env.HERMES_WEB_UI_GIT_SHA?.trim()
    || env.GIT_SHA?.trim()
    || env.GITHUB_SHA?.trim()
    || env.CI_COMMIT_SHA?.trim()
    || readGitValue(root, ['rev-parse', '--short=12', 'HEAD'])
    || 'unknown'

  const branch = normalizeBranch(
    env.HERMES_WEB_UI_GIT_BRANCH?.trim()
      || env.GIT_BRANCH?.trim()
      || env.GITHUB_REF_NAME?.trim()
      || env.CI_COMMIT_REF_NAME?.trim()
      || readGitValue(root, ['branch', '--show-current'])
      || readGitValue(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
  )

  return { sha, branch }
}
