import { spawn } from 'child_process'
import { lstat, mkdir, readFile, rm, symlink } from 'fs/promises'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { config } from '../../config'
import { getProfileDir } from './hermes-profile'
import { safeFileStore } from '../safe-file-store'
import { logger } from '../logger'

export type BranchBuildStatus = 'idle' | 'running' | 'success' | 'failed'

export interface BranchBuildState {
  profile: string
  reviewBase: string
  previewBranch: string | null
  previewWorktreePath: string | null
  buildBranch: string | null
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
  previewBranch: string | null
  previewWorktreePath: string | null
  buildBranch: string | null
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  signal: string | null
  error: string | null
  reviewBase: string
  logTail: string[]
}

export type BranchPreviewCapabilityReason =
  | 'disabled'
  | 'repo_path_missing'
  | 'not_git_repo'

export interface BranchPreviewCapabilities {
  isSuperAdmin: boolean
  devModeAvailable: boolean
  branchPreviewAvailable: boolean
  branchPreviewConfigured: boolean
  canListBranches: boolean
  canBuild: boolean
  reason: BranchPreviewCapabilityReason | null
}

const DEFAULT_REVIEW_BASE = 'main'
const MAX_LOG_LINES = 800
const BUILD_STATE_FILE = '.dev-mode-branch-builds.json'
const BUILD_WORKTREE_DIR = '.dev-mode-branch-builds'
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

function normalizeReviewBase(value?: unknown): string {
  const branch = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_REVIEW_BASE
  return branch
}

function defaultState(profile: string, reviewBase = DEFAULT_REVIEW_BASE): BranchBuildState {
  return {
    profile,
    reviewBase,
    previewBranch: reviewBase,
    previewWorktreePath: null,
    buildBranch: null,
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
      previewBranch,
      previewWorktreePath: typeof parsed.previewWorktreePath === 'string' && parsed.previewWorktreePath.trim()
        ? parsed.previewWorktreePath.trim()
        : null,
      buildBranch: typeof parsed.buildBranch === 'string' && parsed.buildBranch.trim()
        ? parsed.buildBranch.trim()
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

function repoRoot(): string {
  return BUILD_ROOT
}

function gitCommand(args: string[], cwd = repoRoot()): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
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

async function resolveBranchRef(branch: string): Promise<string> {
  const candidate = branch.trim()
  if (!isSafeGitBranchName(candidate)) {
    throw new Error(`Invalid branch name: ${branch}`)
  }
  const exists = await gitCommand(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
  if (exists.code !== 0) {
    throw new Error(`Branch does not exist: ${candidate}`)
  }
  return candidate
}

export async function getBranchPreviewCapabilities(profile: string, isSuperAdmin: boolean): Promise<BranchPreviewCapabilities> {
  const enabled = await isDevModeEnabled(profile)
  if (!isSuperAdmin) {
    return {
      isSuperAdmin: false,
      devModeAvailable: false,
      branchPreviewAvailable: false,
      branchPreviewConfigured: false,
      canListBranches: false,
      canBuild: false,
      reason: 'disabled',
    }
  }

  const repoCheck = await gitCommand(['rev-parse', '--is-inside-work-tree'])
  const isGitRepo = repoCheck.code === 0 && repoCheck.stdout.trim() === 'true'

  return {
    isSuperAdmin: true,
    devModeAvailable: true,
    branchPreviewAvailable: isGitRepo,
    branchPreviewConfigured: isGitRepo,
    canListBranches: isGitRepo,
    canBuild: isGitRepo && enabled,
    reason: isGitRepo ? null : 'not_git_repo',
  }
}

export async function listRepositoryBranches(): Promise<string[]> {
  const repoCheck = await gitCommand(['rev-parse', '--is-inside-work-tree'])
  if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== 'true') {
    throw new Error('Branch preview repository is not configured as a git checkout')
  }

  const result = await gitCommand(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Failed to list repository branches')
  }
  const branches = new Set<string>()
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.endsWith('/HEAD')) continue
    branches.add(line)
  }
  return [...branches].sort((a, b) => a.localeCompare(b))
}

function buildRootPath(profile: string): string {
  return join(profileDir(profile), BUILD_WORKTREE_DIR)
}

function sanitizeBranchLabel(branch: string): string {
  const base = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return (base || 'branch').slice(0, 64)
}

function uniqueWorktreePath(profile: string, branch: string): string {
  return join(buildRootPath(profile), `${sanitizeBranchLabel(branch)}-${Date.now()}-${randomUUID().slice(0, 8)}`)
}

async function removeWorktree(worktreePath: string | null | undefined): Promise<void> {
  if (!worktreePath) return
  await gitCommand(['worktree', 'remove', '--force', worktreePath]).catch((err) => {
    logger.warn(err, '[dev-mode] failed to remove worktree path=%s', worktreePath)
  })
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
}

async function linkDependencyTree(profile: string, worktreePath: string): Promise<void> {
  const sourceNodeModules = join(repoRoot(), 'node_modules')
  const targetNodeModules = join(worktreePath, 'node_modules')

  try {
    const sourceStats = await lstat(sourceNodeModules)
    if (!sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
      throw new Error(`${sourceNodeModules} is not a dependency directory`)
    }
  } catch (err: any) {
    throw new Error(`Branch preview dependencies are not installed in ${repoRoot()}: ${err instanceof Error ? err.message : String(err)}`)
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

async function preparePreviewWorktree(profile: string, branch: string): Promise<string> {
  const worktreePath = uniqueWorktreePath(profile, branch)
  await mkdir(buildRootPath(profile), { recursive: true })

  const addResult = await gitCommand(['worktree', 'add', '--detach', worktreePath, branch])
  if (addResult.code !== 0) {
    throw new Error(addResult.stderr.trim() || `Failed to create worktree for ${branch}`)
  }
  await linkDependencyTree(profile, worktreePath)
  return worktreePath
}

function commandSpecs(): Array<{ label: string; command: string; args: string[] }> {
  const viteBin = join(repoRoot(), 'node_modules', 'vite', 'bin', 'vite.js')
  const vueTscBin = join(repoRoot(), 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js')
  const tscBin = join(repoRoot(), 'node_modules', 'typescript', 'bin', 'tsc')
  const buildServerScript = join(repoRoot(), 'scripts', 'build-server.mjs')

  return [
    { label: 'vue-tsc', command: process.execPath, args: [vueTscBin, '-b'] },
    { label: 'vite build', command: process.execPath, args: [viteBin, 'build'] },
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

async function persistActivatedPreview(profile: string, branch: string, worktreePath: string, reviewBase: string, previousPreviewPath?: string | null): Promise<BranchBuildState> {
  if (previousPreviewPath && previousPreviewPath !== worktreePath) {
    await removeWorktree(previousPreviewPath)
  }
  return updateState(profile, async (state) => ({
    ...state,
    reviewBase,
    previewBranch: branch,
    previewWorktreePath: worktreePath,
    buildBranch: branch,
    status: 'success',
    startedAt: state.startedAt,
    finishedAt: Date.now(),
    exitCode: 0,
    signal: null,
    error: null,
  }))
}

async function markBuildFailure(profile: string, error: string, exitCode: number | null = null, signal: string | null = null): Promise<BranchBuildState> {
  return updateState(profile, async (state) => ({
    ...state,
    status: 'failed',
    finishedAt: Date.now(),
    exitCode,
    signal,
    error,
  }))
}

export async function getBranchBuildSummary(profile: string): Promise<BranchBuildSummary> {
  const [enabled, state] = await Promise.all([
    isDevModeEnabled(profile),
    readState(profile),
  ])
  return {
    enabled,
    status: state.status,
    previewBranch: state.previewBranch,
    previewWorktreePath: state.previewWorktreePath,
    buildBranch: state.buildBranch,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    exitCode: state.exitCode,
    signal: state.signal,
    error: state.error,
    reviewBase: state.reviewBase,
    logTail: state.logTail,
  }
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

  const resolvedBranch = await resolveBranchRef(branch)
  const commands = commandSpecs()
  const reviewBase = normalizeReviewBase(current.reviewBase)
  const worktreePath = await preparePreviewWorktree(profile, resolvedBranch)

  await updateState(profile, async (state) => ({
    ...state,
    reviewBase,
    buildBranch: resolvedBranch,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    logTail: [...state.logTail, `Building branch ${resolvedBranch} in ${worktreePath}`].slice(-MAX_LOG_LINES),
  }))

  try {
    for (const spec of commands) {
      const result = await runCommand(profile, worktreePath, spec.label, spec.command, spec.args)
      if (result.code !== 0) {
        throw new Error(`${spec.label} failed with exit code ${result.code ?? 'null'}`)
      }
    }

    const state = await persistActivatedPreview(profile, resolvedBranch, worktreePath, reviewBase, current.previewWorktreePath)
    return { state, worktreePath }
  } catch (err: any) {
    await removeWorktree(worktreePath)
    const message = err instanceof Error ? err.message : String(err)
    const state = await markBuildFailure(profile, message)
    return { state, worktreePath }
  }
}

export async function resetPreviewTarget(profile: string): Promise<BranchBuildSummary> {
  if (!await isDevModeEnabled(profile)) {
    throw new Error('Dev Mode is disabled')
  }

  const current = await readState(profile)
  const reviewBase = normalizeReviewBase(current.reviewBase)
  const branch = await resolveBranchRef(reviewBase)
  const worktreePath = await preparePreviewWorktree(profile, branch)
  const previousPreviewPath = current.previewWorktreePath
  if (previousPreviewPath && previousPreviewPath !== worktreePath) {
    await removeWorktree(previousPreviewPath)
  }

  const state = await updateState(profile, async () => ({
    profile,
    reviewBase,
    previewBranch: branch,
    previewWorktreePath: worktreePath,
    buildBranch: branch,
    status: 'success',
    startedAt: null,
    finishedAt: Date.now(),
    exitCode: 0,
    signal: null,
    error: null,
    logTail: [...current.logTail, `Preview target reset to ${branch} at ${worktreePath}`].slice(-MAX_LOG_LINES),
    updatedAt: Date.now(),
  }))

  return {
    enabled: true,
    status: state.status,
    previewBranch: state.previewBranch,
    previewWorktreePath: state.previewWorktreePath,
    buildBranch: state.buildBranch,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    exitCode: state.exitCode,
    signal: state.signal,
    error: state.error,
    reviewBase: state.reviewBase,
    logTail: state.logTail,
  }
}

export function isSafeBranchNameForTest(branch: string): boolean {
  return isSafeGitBranchName(branch)
}

export async function __resetDevModeStateForTest(profile: string): Promise<void> {
  await rm(statePath(profile), { force: true }).catch(() => undefined)
  await rm(worktreeRoot(profile), { recursive: true, force: true }).catch(() => undefined)
}
