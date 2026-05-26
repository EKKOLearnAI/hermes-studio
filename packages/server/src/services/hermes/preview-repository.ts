import { createHash } from 'crypto'
import { access, mkdir, readFile, rm } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join, resolve } from 'path'
import { spawn } from 'child_process'
import { getProfileDir } from './hermes-profile'
import { safeFileStore } from '../safe-file-store'

export type PreviewRepositoryDescriptor =
  | { type: 'local'; path: string }
  | { type: 'git-url'; url: string }
  | { type: 'github'; owner: string; repo: string }

export type PreviewRepositoryReason = 'repo_path_missing' | 'not_git_repo'

export interface PreviewRepositoryResolution {
  descriptor: PreviewRepositoryDescriptor | null
  configured: boolean
  available: boolean
  reason: PreviewRepositoryReason | null
  repoRoot: string | null
  cachePath: string | null
  remoteUrl: string | null
}

interface GitResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

const PREVIEW_REPOSITORY_CACHE_DIR = '.preview-repositories'

function profileDir(profile: string): string {
  return getProfileDir(profile)
}

function previewRepositoryConfigPath(profile: string): string {
  return join(profileDir(profile), 'config.yaml')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalize(value: unknown): string {
  return isNonEmptyString(value) ? value.trim() : ''
}

function normalizeRepositoryPath(pathValue: unknown): string {
  return normalize(pathValue)
}

function normalizePreviewRepository(raw: unknown): PreviewRepositoryDescriptor | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, any>
  const type = normalize(value.type)

  switch (type) {
    case 'local': {
      const path = normalizeRepositoryPath(value.path)
      return path ? { type: 'local', path } : null
    }
    case 'git-url': {
      const url = normalize(value.url)
      return url ? { type: 'git-url', url } : null
    }
    case 'github': {
      const owner = normalize(value.owner)
      const repo = normalize(value.repo)
      return owner && repo ? { type: 'github', owner, repo } : null
    }
    default:
      return null
  }
}

function repositoryRemoteUrl(descriptor: PreviewRepositoryDescriptor): string | null {
  switch (descriptor.type) {
    case 'local':
      return null
    case 'git-url':
      return descriptor.url
    case 'github':
      return `https://github.com/${descriptor.owner}/${descriptor.repo}.git`
  }
}

function repositoryCacheKey(descriptor: Exclude<PreviewRepositoryDescriptor, { type: 'local' }>): string {
  if (descriptor.type === 'github') {
    return `github-${descriptor.owner}-${descriptor.repo}`.replace(/[^A-Za-z0-9._-]+/g, '-')
  }
  return `git-url-${createHash('sha1').update(descriptor.url).digest('hex').slice(0, 16)}`
}

function repositoryCachePath(profile: string, descriptor: Exclude<PreviewRepositoryDescriptor, { type: 'local' }>): string {
  return join(profileDir(profile), PREVIEW_REPOSITORY_CACHE_DIR, repositoryCacheKey(descriptor))
}

async function gitCommand(args: string[], cwd: string): Promise<GitResult> {
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

async function gitRepoRoot(pathValue: string): Promise<string | null> {
  try {
    const result = await gitCommand(['rev-parse', '--show-toplevel'], resolve(pathValue))
    if (result.code !== 0) return null
    const root = result.stdout.trim()
    return root || null
  } catch {
    return null
  }
}

async function ensureRemoteCheckout(profile: string, descriptor: Exclude<PreviewRepositoryDescriptor, { type: 'local' }>): Promise<string> {
  const remoteUrl = repositoryRemoteUrl(descriptor)
  if (!remoteUrl) throw new Error('Remote repository URL is missing')

  const cachePath = repositoryCachePath(profile, descriptor)
  const cacheParent = join(profileDir(profile), PREVIEW_REPOSITORY_CACHE_DIR)
  await mkdir(cacheParent, { recursive: true })

  const repoRoot = await gitRepoRoot(cachePath)
  if (!repoRoot) {
    await rm(cachePath, { recursive: true, force: true }).catch(() => undefined)
    const clone = await gitCommand(['clone', '--no-checkout', remoteUrl, cachePath], profileDir(profile))
    if (clone.code !== 0) {
      throw new Error(clone.stderr.trim() || `Failed to clone preview repository from ${remoteUrl}`)
    }
  } else {
    const setUrl = await gitCommand(['remote', 'set-url', 'origin', remoteUrl], cachePath)
    if (setUrl.code !== 0) {
      throw new Error(setUrl.stderr.trim() || `Failed to update preview repository origin for ${remoteUrl}`)
    }
  }

  const fetch = await gitCommand(['fetch', '--prune', '--tags', 'origin'], cachePath)
  if (fetch.code !== 0) {
    throw new Error(fetch.stderr.trim() || `Failed to fetch preview repository from ${remoteUrl}`)
  }

  const updatedRoot = await gitRepoRoot(cachePath)
  if (!updatedRoot) {
    throw new Error(`Preview repository cache is not a git checkout: ${cachePath}`)
  }

  return updatedRoot
}

function determineReasonForMissingLocalRepo(pathValue: string): PreviewRepositoryReason {
  return pathValue ? 'not_git_repo' : 'repo_path_missing'
}

async function resolveLocalRepository(pathValue: string): Promise<PreviewRepositoryResolution> {
  const resolvedPath = resolve(pathValue)
  try {
    await access(resolvedPath, fsConstants.F_OK)
  } catch {
    return {
      descriptor: { type: 'local', path: pathValue },
      configured: false,
      available: false,
      reason: 'repo_path_missing',
      repoRoot: null,
      cachePath: null,
      remoteUrl: null,
    }
  }

  const repoRoot = await gitRepoRoot(resolvedPath)
  if (!repoRoot) {
    return {
      descriptor: { type: 'local', path: pathValue },
      configured: false,
      available: false,
      reason: 'not_git_repo',
      repoRoot: null,
      cachePath: null,
      remoteUrl: null,
    }
  }

  return {
    descriptor: { type: 'local', path: pathValue },
    configured: true,
    available: true,
    reason: null,
    repoRoot,
    cachePath: null,
    remoteUrl: null,
  }
}

async function resolveRemoteRepository(profile: string, descriptor: Exclude<PreviewRepositoryDescriptor, { type: 'local' }>, fetchRemote: boolean): Promise<PreviewRepositoryResolution> {
  const remoteUrl = repositoryRemoteUrl(descriptor)
  if (!remoteUrl) {
    return {
      descriptor,
      configured: false,
      available: false,
      reason: 'not_git_repo',
      repoRoot: null,
      cachePath: null,
      remoteUrl: null,
    }
  }

  const cachePath = repositoryCachePath(profile, descriptor)
  if (fetchRemote) {
    const repoRoot = await ensureRemoteCheckout(profile, descriptor)
    return {
      descriptor,
      configured: true,
      available: true,
      reason: null,
      repoRoot,
      cachePath,
      remoteUrl,
    }
  }

  const repoRoot = await gitRepoRoot(cachePath)
  return {
    descriptor,
    configured: true,
    available: true,
    reason: null,
    repoRoot,
    cachePath,
    remoteUrl,
  }
}

export async function resolvePreviewRepository(profile: string, options: { fetchRemote?: boolean } = {}): Promise<PreviewRepositoryResolution> {
  const config = await safeFileStore.readYaml(previewRepositoryConfigPath(profile))
  const descriptor = normalizePreviewRepository(config?.dev?.preview_repository)
  const fetchRemote = options.fetchRemote !== false

  if (!descriptor) {
    const repoRoot = await gitRepoRoot(process.cwd())
    if (!repoRoot) {
      return {
        descriptor: null,
        configured: false,
        available: false,
        reason: 'not_git_repo',
        repoRoot: null,
        cachePath: null,
        remoteUrl: null,
      }
    }

    return {
      descriptor: null,
      configured: true,
      available: true,
      reason: null,
      repoRoot,
      cachePath: null,
      remoteUrl: null,
    }
  }

  if (descriptor.type === 'local') {
    return resolveLocalRepository(descriptor.path)
  }

  return resolveRemoteRepository(profile, descriptor, fetchRemote)
}

export async function listPreviewRepositoryBranches(profile: string): Promise<string[]> {
  const resolution = await resolvePreviewRepository(profile, { fetchRemote: true })
  if (!resolution.repoRoot) {
    const message = resolution.reason === 'repo_path_missing'
      ? 'Preview repository path is missing'
      : 'Preview repository is not a git checkout'
    throw new Error(message)
  }

  const result = await gitCommand(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], resolution.repoRoot)
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Failed to list repository branches')
  }

  const branches = new Set<string>()
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.endsWith('/HEAD')) continue
    branches.add(line)
  }

  return [...branches].sort((left, right) => left.localeCompare(right))
}

export async function previewRepositoryRoot(profile: string): Promise<string | null> {
  const resolution = await resolvePreviewRepository(profile, { fetchRemote: true })
  return resolution.repoRoot
}

export async function __resetPreviewRepositoryCacheForTest(profile: string): Promise<void> {
  await rm(join(profileDir(profile), PREVIEW_REPOSITORY_CACHE_DIR), { recursive: true, force: true }).catch(() => undefined)
}
