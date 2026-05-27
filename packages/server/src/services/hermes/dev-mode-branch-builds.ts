import { spawn } from 'child_process'
import { access, lstat, mkdir, readFile, rm, symlink } from 'fs/promises'
import { join, resolve } from 'path'
import { config } from '../../config'
import { getProfileDir } from './hermes-profile'
import { getLatestAvailableRelease, listAvailableReleases, prepareReleasePreviewPackage } from './webui-releases'
import { listPreviewRepositoryBranches, previewRepositoryRoot, resolvePreviewRepository, type PreviewRepositoryResolution } from './preview-repository'
import { PREVIEW_SLOT_ID, removePreviewInstance, startPreviewInstanceWithId, updatePreviewInstance } from './preview-registry'
import { safeFileStore } from '../safe-file-store'
import { logger } from '../logger'

export type PreviewInstanceStatus = 'idle' | 'running' | 'success' | 'failed' | 'stopped'

export type PreviewCapabilityReason =
  | 'disabled'
  | 'repo_path_missing'
  | 'not_git_repo'

export type PreviewTargetKind = 'installed-version' | 'release-artifact' | 'docker-image' | 'git-branch'
export type PreviewProviderKey = 'installed-version' | 'release-artifact' | 'docker-image' | 'git-branch-worktree'
export type PreviewSourceKind = 'release' | 'branch' | 'commit'

export interface PreviewSourceCapability {
  provider: PreviewSourceKind
  available: boolean
  configured: boolean
  devOnly: boolean
  canListTargets: boolean
  canBuild: boolean
  reason: PreviewCapabilityReason | null
}

export interface InstalledVersionPreviewTarget {
  type: 'installed-version'
  version: string
}

export interface ReleaseArtifactPreviewTarget {
  type: 'release-artifact'
  version: string
  source: 'github-release'
  artifactPath?: string | null
}

export interface DockerImagePreviewTarget {
  type: 'docker-image'
  image: string
}

export interface GitBranchPreviewTarget {
  type: 'git-branch'
  repo: string
  branch: string
  provider: 'git-branch-worktree'
  devOnly: true
  worktreePath?: string | null
}

export type PreviewTarget =
  | InstalledVersionPreviewTarget
  | ReleaseArtifactPreviewTarget
  | DockerImagePreviewTarget
  | GitBranchPreviewTarget

export interface PreviewInstance {
  id: string
  target: PreviewTarget
  status: PreviewInstanceStatus
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  signal: string | null
  error: string | null
  logTail: string[]
  updatedAt: number
}

export interface PreviewProviderCapability {
  provider: PreviewProviderKey
  available: boolean
  configured: boolean
  devOnly: boolean
  canListTargets: boolean
  canBuild: boolean
  reason: PreviewCapabilityReason | null
}

export interface PreviewProviderCapabilities {
  isSuperAdmin: boolean
  devModeAvailable: boolean
  providers: PreviewProviderCapability[]
}

export interface PreviewInstanceSummary extends PreviewInstance {
  enabled: boolean
  reviewBase: string
  previewBranch: string | null
  previewWorktreePath: string | null
  buildBranch: string | null
}

export type BranchBuildStatus = PreviewInstanceStatus

export interface BranchBuildState {
  profile: string
  reviewBase: string
  previewId: string | null
  previewBranch: string | null
  previewReleaseVersion: string | null
  previewWorktreePath: string | null
  buildBranch: string | null
  buildReleaseVersion: string | null
  status: BranchBuildStatus
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  signal: string | null
  error: string | null
  logTail: string[]
  updatedAt: number
}

export interface BuildResult {
  state: BranchBuildState
  worktreePath: string
}

export interface BranchBuildSummary {
  enabled: boolean
  status: BranchBuildStatus
  previewId: string | null
  previewUrl: string | null
  previewBranch: string | null
  previewReleaseVersion: string | null
  previewWorktreePath: string | null
  buildBranch: string | null
  buildReleaseVersion: string | null
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  signal: string | null
  error: string | null
  reviewBase: string
  logTail: string[]
}

export type BranchPreviewCapabilityReason = PreviewCapabilityReason

export interface BranchPreviewCapabilities {
  isSuperAdmin: boolean
  devModeAvailable: boolean
  branchPreviewAvailable: boolean
  branchPreviewConfigured: boolean
  canListBranches: boolean
  canBuild: boolean
  reason: BranchPreviewCapabilityReason | null
  providers?: PreviewSourceCapability[]
  repository?: PreviewRepositoryResolution
}

const DEFAULT_REVIEW_BASE = 'main'
const MAX_LOG_LINES = 800
const BUILD_STATE_FILE = '.dev-mode-branch-builds.json'
const BUILD_WORKTREE_DIR = '.dev-mode-branch-builds'
const PREVIEW_SLOT_DIR = '.preview-slot'
const PREVIEW_SLOT_WORKTREE_DIR = 'worktree'
const PREVIEW_SLOT_ARTIFACT_DIR = 'artifact'
const BUILD_ROOT = resolve(process.cwd())

function profileDir(profile: string): string {
  return getProfileDir(profile)
}

function statePath(profile: string): string {
  return join(profileDir(profile), BUILD_STATE_FILE)
}

function worktreeRoot(profile: string): string {
  return join(profileDir(profile), BUILD_WORKTREE_DIR)
}

function previewSlotRoot(profile: string): string {
  return join(profileDir(profile), PREVIEW_SLOT_DIR)
}

function previewSlotWorktreePath(profile: string): string {
  return join(previewSlotRoot(profile), PREVIEW_SLOT_WORKTREE_DIR)
}

function previewSlotArtifactPath(profile: string): string {
  return join(previewSlotRoot(profile), PREVIEW_SLOT_ARTIFACT_DIR)
}

function normalizeReviewBase(value?: unknown): string {
  const branch = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_REVIEW_BASE
  return branch
}

function defaultState(profile: string, reviewBase = DEFAULT_REVIEW_BASE): BranchBuildState {
  return {
    profile,
    reviewBase,
    previewId: null,
    previewBranch: reviewBase,
    previewReleaseVersion: null,
    previewWorktreePath: null,
    buildBranch: null,
    buildReleaseVersion: null,
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    logTail: [],
    updatedAt: Date.now(),
  }
}

function safeJsonParse(raw: string | null): Record<string, any> | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, any>
  } catch {
    return null
  }
}

async function readState(profile: string): Promise<BranchBuildState> {
  const configYaml = await safeFileStore.readYaml(join(profileDir(profile), 'config.yaml'))
  const reviewBase = normalizeReviewBase(configYaml.dev?.review_base)
  const state = defaultState(profile, reviewBase)

  try {
    const raw = await readFile(statePath(profile), 'utf-8')
    const parsed = safeJsonParse(raw)
    if (!parsed) return state

    const previewBranch = typeof parsed.previewBranch === 'string' && parsed.previewBranch.trim()
      ? parsed.previewBranch.trim()
      : state.previewBranch
    const reviewBaseBranch = normalizeReviewBase(parsed.reviewBase ?? reviewBase)

    return {
      ...state,
      reviewBase: reviewBaseBranch,
      previewId: typeof parsed.previewId === 'string' && parsed.previewId.trim()
        ? parsed.previewId.trim()
        : null,
      previewBranch,
      previewReleaseVersion: typeof parsed.previewReleaseVersion === 'string' && parsed.previewReleaseVersion.trim()
        ? parsed.previewReleaseVersion.trim()
        : null,
      previewWorktreePath: typeof parsed.previewWorktreePath === 'string' && parsed.previewWorktreePath.trim()
        ? parsed.previewWorktreePath.trim()
        : null,
      buildBranch: typeof parsed.buildBranch === 'string' && parsed.buildBranch.trim()
        ? parsed.buildBranch.trim()
        : null,
      buildReleaseVersion: typeof parsed.buildReleaseVersion === 'string' && parsed.buildReleaseVersion.trim()
        ? parsed.buildReleaseVersion.trim()
        : null,
      status: parsed.status === 'running' || parsed.status === 'success' || parsed.status === 'failed'
        ? parsed.status
        : state.status,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null,
      finishedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : null,
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
      signal: typeof parsed.signal === 'string' ? parsed.signal : null,
      error: typeof parsed.error === 'string' ? parsed.error : null,
      logTail: Array.isArray(parsed.logTail)
        ? parsed.logTail.filter((line: unknown) => typeof line === 'string').slice(-MAX_LOG_LINES)
        : state.logTail,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    }
  } catch {
    return state
  }
}

async function writeState(profile: string, state: BranchBuildState): Promise<void> {
  await safeFileStore.writeText(statePath(profile), `${JSON.stringify(state, null, 2)}\n`)
}

async function updateState(profile: string, updater: (state: BranchBuildState) => BranchBuildState | Promise<BranchBuildState>): Promise<BranchBuildState> {
  const current = await readState(profile)
  const next = await updater(current)
  next.updatedAt = Date.now()
  await writeState(profile, next)
  return next
}

async function appendLog(profile: string, line: string): Promise<void> {
  if (!line.trim()) return
  await updateState(profile, (state) => {
    const logTail = [...state.logTail, line].slice(-MAX_LOG_LINES)
    return { ...state, logTail }
  })
}

function serverRepoRoot(): string {
  return BUILD_ROOT
}

function gitCommand(args: string[], cwd = serverRepoRoot()): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_PAGER: 'cat',
      },
      shell: false,
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', rejectPromise)
    child.on('close', (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr })
    })
  })
}

function isSafeGitBranchName(branch: string): boolean {
  if (!branch || branch.length > 200) return false
  if (branch.startsWith('-') || branch.endsWith('/') || branch.endsWith('.lock')) return false
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) return false
  if (/[\s\x00-\x1f\x7f~^:\*?\[\\]/.test(branch)) return false
  if (branch.includes('->')) return false
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch)
}

async function resolveBranchRef(profile: string, branch: string, repoRootOverride?: string | null): Promise<string> {
  const candidate = branch.trim()
  if (!isSafeGitBranchName(candidate)) {
    throw new Error(`Invalid branch name: ${branch}`)
  }

  const repoRootPath = repoRootOverride || (await previewRepositoryRoot(profile)) || serverRepoRoot()
  const exists = await gitCommand(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], repoRootPath)
  if (exists.code !== 0) {
    throw new Error(`Branch does not exist: ${candidate}`)
  }
  return candidate
}

export async function getBranchPreviewCapabilities(profile: string, isSuperAdmin: boolean): Promise<BranchPreviewCapabilities> {
  const enabled = await isDevModeEnabled(profile)
  const repository = await resolvePreviewRepository(profile, { fetchRemote: false })

  const releases = await listAvailableReleases().catch((): string[] => [])
  const releaseProvider: PreviewSourceCapability = {
    provider: 'release',
    available: releases.length > 0,
    configured: releases.length > 0,
    devOnly: false,
    canListTargets: true,
    canBuild: releases.length > 0,
    reason: null,
  }

  const branchReason: BranchPreviewCapabilityReason | null = !isSuperAdmin || !enabled
    ? 'disabled'
    : repository.reason === 'repo_path_missing'
      ? 'repo_path_missing'
      : !repository.configured
        ? 'not_git_repo'
        : null

  const branchConfigured = Boolean(repository.configured)
  const branchAvailable = Boolean(isSuperAdmin && enabled && branchConfigured)
  const branchProvider: PreviewSourceCapability = {
    provider: 'branch',
    available: branchAvailable,
    configured: branchConfigured,
    devOnly: true,
    canListTargets: branchConfigured && enabled,
    canBuild: branchConfigured && enabled,
    reason: branchReason,
  }

  const commitProvider: PreviewSourceCapability = {
    provider: 'commit',
    available: branchAvailable,
    configured: branchConfigured,
    devOnly: true,
    canListTargets: branchConfigured && enabled,
    canBuild: branchConfigured && enabled,
    reason: branchReason,
  }

  return {
    isSuperAdmin: Boolean(isSuperAdmin),
    devModeAvailable: Boolean(isSuperAdmin),
    branchPreviewAvailable: branchProvider.available,
    branchPreviewConfigured: branchProvider.configured,
    canListBranches: branchProvider.canListTargets,
    canBuild: branchProvider.canBuild,
    reason: branchReason,
    providers: [releaseProvider, branchProvider, commitProvider],
    repository,
  }
}

export async function listRepositoryBranches(profile: string): Promise<string[]> {
  return listPreviewRepositoryBranches(profile)
}

export async function getAvailableReleases(): Promise<string[]> {
  return listAvailableReleases()
}

function buildRootPath(profile: string): string {
  return join(profileDir(profile), BUILD_WORKTREE_DIR)
}

function buildPreviewUrl(previewId: string | null): string | null {
  return previewId ? '/preview/' : null
}

async function removeWorktree(worktreePath: string | null | undefined, repoRootPath: string = serverRepoRoot()): Promise<void> {
  if (!worktreePath) return
  await gitCommand(['worktree', 'remove', '--force', worktreePath], repoRootPath).catch((err) => {
    logger.warn(err, '[dev-mode] failed to remove worktree path=%s', worktreePath)
  })
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
}

async function linkDependencyTree(profile: string, worktreePath: string): Promise<void> {
  const sourceNodeModules = join(serverRepoRoot(), 'node_modules')
  const targetNodeModules = join(worktreePath, 'node_modules')

  try {
    const sourceStats = await lstat(sourceNodeModules)
    if (!sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
      throw new Error(`${sourceNodeModules} is not a dependency directory`)
    }
  } catch (err: any) {
    throw new Error(`Branch preview dependencies are not installed in ${serverRepoRoot()}: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    await lstat(targetNodeModules)
    return
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }

  await symlink(sourceNodeModules, targetNodeModules, 'dir')
  await appendLog(profile, `Linked dependencies from ${sourceNodeModules}`)
}

async function preparePreviewWorktree(profile: string, branch: string, repoRootPath: string, previousWorktreePath?: string | null): Promise<string> {
  const worktreePath = previewSlotWorktreePath(profile)
  await mkdir(buildRootPath(profile), { recursive: true })
  await mkdir(previewSlotRoot(profile), { recursive: true })
  if (previousWorktreePath && previousWorktreePath !== worktreePath) {
    await removeWorktree(previousWorktreePath, repoRootPath)
  }
  await removeWorktree(worktreePath, repoRootPath)
  await rm(previewSlotArtifactPath(profile), { recursive: true, force: true }).catch(() => undefined)

  const addResult = await gitCommand(['worktree', 'add', '--detach', worktreePath, branch], repoRootPath)
  if (addResult.code !== 0) {
    throw new Error(addResult.stderr.trim() || `Failed to create worktree for ${branch}`)
  }
  await linkDependencyTree(profile, worktreePath)
  return worktreePath
}

export function commandSpecs(): Array<{ label: string; command: string; args: string[] }> {
  const viteBin = join(serverRepoRoot(), 'node_modules', 'vite', 'bin', 'vite.js')
  const vueTscBin = join(serverRepoRoot(), 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js')
  const tscBin = join(serverRepoRoot(), 'node_modules', 'typescript', 'bin', 'tsc')
  const buildServerScript = join(serverRepoRoot(), 'scripts', 'build-server.mjs')

  return [
    { label: 'vue-tsc', command: process.execPath, args: [vueTscBin, '-b'] },
    { label: 'vite build', command: process.execPath, args: [viteBin, 'build', '--base=./'] },
    { label: 'server tsc', command: process.execPath, args: [tscBin, '--noEmit', '-p', 'packages/server/tsconfig.json'] },
    { label: 'server bundle', command: process.execPath, args: [buildServerScript] },
  ]
}

async function runCommand(profile: string, worktreePath: string, label: string, command: string, args: string[]): Promise<{ code: number | null; signal: string | null }> {
  await appendLog(profile, `> ${label}: ${[command, ...args].join(' ')}`)

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: worktreePath,
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
      shell: false,
    })

    const pushChunk = (chunk: unknown) => {
      const text = String(chunk)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) void appendLog(profile, `[${label}] ${line}`)
      }
    }

    child.stdout?.on('data', pushChunk)
    child.stderr?.on('data', pushChunk)
    child.on('error', (err) => {
      void appendLog(profile, `[${label}] error: ${err instanceof Error ? err.message : String(err)}`)
      rejectPromise(err)
    })
    child.on('close', (code, signal) => {
      void appendLog(profile, `[${label}] exit ${code ?? 'null'}${signal ? ` signal=${signal}` : ''}`)
      resolvePromise({ code, signal })
    })
  })
}

async function persistActivatedPreview(profile: string, previewId: string, branch: string, worktreePath: string, reviewBase: string, repoRootPath: string, previousPreviewPath?: string | null): Promise<BranchBuildState> {
  if (previousPreviewPath && previousPreviewPath !== worktreePath) {
    await removeWorktree(previousPreviewPath, repoRootPath)
  }
  const finishedAt = Date.now()
  const state = await updateState(profile, async (current) => ({
    ...current,
    reviewBase,
    previewId,
    previewBranch: branch,
    previewReleaseVersion: null,
    previewWorktreePath: worktreePath,
    buildBranch: branch,
    buildReleaseVersion: null,
    status: 'success',
    startedAt: current.startedAt,
    finishedAt,
    exitCode: 0,
    signal: null,
    error: null,
  }))
  await updatePreviewInstance(profile, previewId, {
    target: {
      type: 'git-branch',
      repo: repoRootPath,
      branch,
      provider: 'git-branch-worktree',
      devOnly: true,
      worktreePath,
    },
    status: 'success',
    startedAt: state.startedAt,
    finishedAt,
    exitCode: 0,
    signal: null,
    error: null,
    logTail: [...state.logTail, `Preview built for ${branch}`].slice(-MAX_LOG_LINES),
  })
  return state
}

async function markBuildFailure(profile: string, previewId: string, error: string, exitCode: number | null = null, signal: string | null = null): Promise<BranchBuildState> {
  const finishedAt = Date.now()
  const state = await updateState(profile, async (current) => ({
    ...current,
    previewId,
    previewReleaseVersion: current.previewReleaseVersion,
    buildReleaseVersion: current.buildReleaseVersion,
    status: 'failed',
    finishedAt,
    exitCode,
    signal,
    error,
  }))
  await updatePreviewInstance(profile, previewId, {
    status: 'failed',
    finishedAt,
    exitCode,
    signal,
    error,
    logTail: [...state.logTail, `Preview build failed: ${error}`].slice(-MAX_LOG_LINES),
  })
  return state
}

function summarizeBranchBuildState(enabled: boolean, state: BranchBuildState): BranchBuildSummary {
  return {
    enabled,
    status: state.status,
    previewId: state.previewId,
    previewUrl: buildPreviewUrl(state.previewId),
    previewBranch: state.previewBranch,
    previewReleaseVersion: state.previewReleaseVersion,
    previewWorktreePath: state.previewWorktreePath,
    buildBranch: state.buildBranch,
    buildReleaseVersion: state.buildReleaseVersion,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    exitCode: state.exitCode,
    signal: state.signal,
    error: state.error,
    reviewBase: state.reviewBase,
    logTail: state.logTail,
  }
}

export async function getBranchBuildSummary(profile: string): Promise<BranchBuildSummary> {
  const [enabled, state] = await Promise.all([
    isDevModeEnabled(profile),
    readState(profile),
  ])
  return summarizeBranchBuildState(enabled, state)
}

export async function isDevModeEnabled(profile: string): Promise<boolean> {
  const configYaml = await safeFileStore.readYaml(join(profileDir(profile), 'config.yaml'))
  return !!configYaml.dev?.enabled
}

export async function startBranchBuild(profile: string, branch: string): Promise<BuildResult> {
  if (!await isDevModeEnabled(profile)) {
    throw new Error('Dev Mode is disabled')
  }

  const current = await readState(profile)
  if (current.status === 'running') {
    throw new Error('A branch build is already running')
  }

  const repoRootPath: string = (await previewRepositoryRoot(profile)) ?? serverRepoRoot()
  const resolvedBranch = await resolveBranchRef(profile, branch, repoRootPath)
  const commands = commandSpecs()
  const reviewBase = normalizeReviewBase(current.reviewBase)
  const previewId = current.previewId || PREVIEW_SLOT_ID
  const worktreePath = await preparePreviewWorktree(profile, resolvedBranch, repoRootPath, current.previewWorktreePath)
  const previewTarget = {
    type: 'git-branch' as const,
    repo: repoRootPath,
    branch: resolvedBranch,
    provider: 'git-branch-worktree' as const,
    devOnly: true as const,
    worktreePath,
  }

  await updateState(profile, async (state) => ({
    ...state,
    reviewBase,
    previewId,
    buildBranch: resolvedBranch,
    buildReleaseVersion: null,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    logTail: [...state.logTail, `Building branch ${resolvedBranch} in ${worktreePath}`].slice(-MAX_LOG_LINES),
  }))

  await startPreviewInstanceWithId(profile, previewTarget, previewId)

  try {
    for (const spec of commands) {
      const result = await runCommand(profile, worktreePath, spec.label, spec.command, spec.args)
      if (result.code !== 0) {
        throw new Error(`${spec.label} failed with exit code ${result.code ?? 'null'}`)
      }
    }

    const state = await persistActivatedPreview(profile, previewId, resolvedBranch, worktreePath, reviewBase, repoRootPath, current.previewWorktreePath)
    return { state, worktreePath }
  } catch (err: any) {
    await removeWorktree(worktreePath, repoRootPath)
    const message = err instanceof Error ? err.message : String(err)
    const state = await markBuildFailure(profile, previewId, message)
    return { state, worktreePath }
  }
}

export async function resetPreviewTarget(profile: string): Promise<BranchBuildSummary> {
  if (!await isDevModeEnabled(profile)) {
    throw new Error('Dev Mode is disabled')
  }

  const current = await readState(profile)
  const reviewBase = normalizeReviewBase(current.reviewBase)
  const repoRootPath: string = (await previewRepositoryRoot(profile)) ?? serverRepoRoot()
  const branch = await resolveBranchRef(profile, reviewBase, repoRootPath)
  const previewId = current.previewId || PREVIEW_SLOT_ID
  const worktreePath = await preparePreviewWorktree(profile, branch, repoRootPath, current.previewWorktreePath)
  const previousPreviewPath = null
  if (previousPreviewPath && previousPreviewPath !== worktreePath) {
    await removeWorktree(previousPreviewPath, repoRootPath)
  }

  const previewTarget = {
    type: 'git-branch' as const,
    repo: repoRootPath,
    branch,
    provider: 'git-branch-worktree' as const,
    devOnly: true as const,
    worktreePath,
  }
  await startPreviewInstanceWithId(profile, previewTarget, previewId)

  const finishedAt = Date.now()
  const state = await updateState(profile, async () => ({
    profile,
    reviewBase,
    previewId,
    previewBranch: branch,
    previewReleaseVersion: null,
    previewWorktreePath: worktreePath,
    buildBranch: branch,
    buildReleaseVersion: null,
    status: 'success',
    startedAt: null,
    finishedAt,
    exitCode: 0,
    signal: null,
    error: null,
    logTail: [...current.logTail, `Preview target reset to ${branch} at ${worktreePath}`].slice(-MAX_LOG_LINES),
    updatedAt: Date.now(),
  }))

  await updatePreviewInstance(profile, previewId, {
    target: previewTarget,
    status: 'success',
    startedAt: null,
    finishedAt,
    exitCode: 0,
    signal: null,
    error: null,
    logTail: [...state.logTail, `Preview target reset to ${branch}`].slice(-MAX_LOG_LINES),
  })

  return summarizeBranchBuildState(true, state)
}

export async function removePreviewTarget(profile: string): Promise<BranchBuildSummary> {
  if (!await isDevModeEnabled(profile)) {
    throw new Error('Dev Mode is disabled')
  }

  const current = await readState(profile)
  if (current.previewId) {
    await removePreviewInstance(profile, current.previewId)
  }

  const repoRootPath: string = (await previewRepositoryRoot(profile)) ?? serverRepoRoot()
  if (current.previewWorktreePath) {
    await removeWorktree(current.previewWorktreePath, repoRootPath)
  }
  await rm(previewSlotRoot(profile), { recursive: true, force: true }).catch(() => undefined)

  const state = await updateState(profile, async (next) => ({
    ...next,
    previewId: null,
    previewBranch: null,
    previewReleaseVersion: null,
    previewWorktreePath: null,
    buildBranch: null,
    buildReleaseVersion: null,
    status: 'idle',
    startedAt: null,
    finishedAt: Date.now(),
    exitCode: null,
    signal: null,
    error: null,
    logTail: [...next.logTail, 'Preview removed'].slice(-MAX_LOG_LINES),
  }))

  return summarizeBranchBuildState(true, state)
}

export async function promotePreviewTarget(profile: string): Promise<BranchBuildSummary> {
  if (!await isDevModeEnabled(profile)) {
    throw new Error('Dev Mode is disabled')
  }

  const current = await readState(profile)
  if (!current.previewBranch || current.status !== 'success') {
    throw new Error('No successful preview is available to promote')
  }

  if (current.previewId) {
    await removePreviewInstance(profile, current.previewId)
  }

  const repoRootPath: string = (await previewRepositoryRoot(profile)) ?? serverRepoRoot()
  if (current.previewWorktreePath) {
    await removeWorktree(current.previewWorktreePath, repoRootPath)
  }
  await rm(previewSlotRoot(profile), { recursive: true, force: true }).catch(() => undefined)

  const state = await updateState(profile, async (next) => ({
    ...next,
    reviewBase: current.previewBranch ?? next.reviewBase,
    previewId: null,
    previewBranch: null,
    previewReleaseVersion: null,
    previewWorktreePath: null,
    buildBranch: null,
    buildReleaseVersion: null,
    status: 'idle',
    startedAt: null,
    finishedAt: Date.now(),
    exitCode: null,
    signal: null,
    error: null,
    logTail: [...next.logTail, `Promoted preview branch ${current.previewBranch} to review base`].slice(-MAX_LOG_LINES),
  }))

  return summarizeBranchBuildState(true, state)
}

export async function restoreLatestUpstreamRelease(profile: string, version?: string): Promise<BranchBuildSummary> {
  const current = await readState(profile)
  if (current.previewId) {
    await removePreviewInstance(profile, current.previewId)
  }

  const releaseVersion = version?.trim() || await getLatestAvailableRelease() || null
  if (!releaseVersion) {
    throw new Error('No release version is available to preview')
  }

  const releases = await listAvailableReleases().catch((): string[] => [])
  if (releases.length > 0 && !releases.includes(releaseVersion)) {
    throw new Error(`Release does not exist: ${releaseVersion}`)
  }

  const startedAt = Date.now()
  const previewId = current.previewId || PREVIEW_SLOT_ID
  const repoRootPath: string = (await previewRepositoryRoot(profile)) ?? serverRepoRoot()
  if (current.previewWorktreePath) {
    await removeWorktree(current.previewWorktreePath, repoRootPath)
  }
  const artifactSlotPath = previewSlotArtifactPath(profile)
  await rm(artifactSlotPath, { recursive: true, force: true }).catch(() => undefined)
  await updateState(profile, async (next) => ({
    ...next,
    reviewBase: DEFAULT_REVIEW_BASE,
    previewId,
    previewBranch: null,
    previewReleaseVersion: releaseVersion,
    previewWorktreePath: null,
    buildBranch: null,
    buildReleaseVersion: releaseVersion,
    status: 'running',
    startedAt,
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    logTail: [...next.logTail, `Building release preview ${releaseVersion}`].slice(-MAX_LOG_LINES),
  }))

  const previewTarget = {
    type: 'release-artifact' as const,
    version: releaseVersion,
    source: 'github-release' as const,
    artifactPath: null,
  }
  await startPreviewInstanceWithId(profile, previewTarget, previewId)

  try {
    const artifactPath = await prepareReleasePreviewPackage(profile, releaseVersion, artifactSlotPath)
    await access(join(artifactPath, 'dist', 'client', 'index.html'))
    const finishedAt = Date.now()
    const state = await updateState(profile, async (next) => ({
      ...next,
      reviewBase: DEFAULT_REVIEW_BASE,
      previewId,
      previewBranch: null,
      previewReleaseVersion: releaseVersion,
      previewWorktreePath: artifactPath,
      buildBranch: null,
      buildReleaseVersion: releaseVersion,
      status: 'success',
      startedAt,
      finishedAt,
      exitCode: 0,
      signal: null,
      error: null,
      logTail: [...next.logTail, `Release preview ${releaseVersion} is ready`].slice(-MAX_LOG_LINES),
    }))
    await updatePreviewInstance(profile, previewId, {
      target: { ...previewTarget, artifactPath },
      status: 'success',
      startedAt,
      finishedAt,
      exitCode: 0,
      signal: null,
      error: null,
      logTail: [...state.logTail, `Preview built for release ${releaseVersion}`].slice(-MAX_LOG_LINES),
    })
    return summarizeBranchBuildState(await isDevModeEnabled(profile), state)
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err)
    const state = await markBuildFailure(profile, previewId, message)
    return summarizeBranchBuildState(await isDevModeEnabled(profile), state)
  }
}

export function isSafeBranchNameForTest(branch: string): boolean {
  return isSafeGitBranchName(branch)
}

export async function __resetDevModeStateForTest(profile: string): Promise<void> {
  await rm(statePath(profile), { force: true }).catch(() => undefined)
  await rm(worktreeRoot(profile), { recursive: true, force: true }).catch(() => undefined)
}
