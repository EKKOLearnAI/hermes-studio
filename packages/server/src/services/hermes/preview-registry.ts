import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { getProfileDir } from './hermes-profile'
import { safeFileStore } from '../safe-file-store'
import type { PreviewInstance, PreviewTarget } from './dev-mode-branch-builds'

const PREVIEW_REGISTRY_FILE = '.preview-registry.json'
const MAX_LOG_LINES = 120
export const PREVIEW_SLOT_ID = 'preview-slot'

export interface PreviewRegistryRecord extends PreviewInstance {
  profile: string
  createdAt: number
  updatedAt: number
}

interface PreviewRegistryState {
  profile: string
  instances: PreviewRegistryRecord[]
  updatedAt: number
}

export class PreviewRegistryError extends Error {
  code: string
  status: number
  details: unknown

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message)
    this.name = 'PreviewRegistryError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function profileDir(profile: string): string {
  return getProfileDir(profile)
}

function registryPath(profile: string): string {
  return join(profileDir(profile), PREVIEW_REGISTRY_FILE)
}

function defaultRegistry(profile: string): PreviewRegistryState {
  return {
    profile,
    instances: [],
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

function toInstance(record: PreviewRegistryRecord): PreviewInstance {
  return {
    id: record.id,
    target: record.target,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    error: record.error,
    logTail: [...record.logTail],
    updatedAt: record.updatedAt,
  }
}

function describeTarget(target: PreviewTarget): string {
  switch (target.type) {
    case 'installed-version':
      return `installed version ${target.version}`
    case 'release-artifact':
      return `${target.source} release ${target.version}`
    case 'docker-image':
      return `docker image ${target.image}`
    case 'git-branch':
      return `branch ${target.repo}#${target.branch}`
    default:
      return 'unknown preview target'
  }
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePreviewTarget(raw: unknown): PreviewTarget {
  if (!raw || typeof raw !== 'object') {
    throw new PreviewRegistryError(400, 'preview_invalid_target', 'Preview target is required')
  }

  const target = raw as Record<string, any>
  const type = normalizeString(target.type)

  switch (type) {
    case 'installed-version': {
      const version = normalizeString(target.version)
      if (!version) {
        throw new PreviewRegistryError(400, 'preview_invalid_target', 'installed-version target requires version')
      }
      return { type: 'installed-version', version }
    }
    case 'release-artifact': {
      const version = normalizeString(target.version)
      const source = normalizeString(target.source)
      if (!version || source !== 'github-release') {
        throw new PreviewRegistryError(400, 'preview_invalid_target', 'release-artifact target requires version and source=github-release')
      }
      return { type: 'release-artifact', version, source: 'github-release' }
    }
    case 'docker-image': {
      const image = normalizeString(target.image)
      if (!image) {
        throw new PreviewRegistryError(400, 'preview_invalid_target', 'docker-image target requires image')
      }
      return { type: 'docker-image', image }
    }
    case 'git-branch': {
      const repo = normalizeString(target.repo)
      const branch = normalizeString(target.branch)
      if (!repo || !branch) {
        throw new PreviewRegistryError(400, 'preview_invalid_target', 'git-branch target requires repo and branch')
      }
      if (target.provider !== 'git-branch-worktree' || target.devOnly !== true) {
        throw new PreviewRegistryError(400, 'preview_invalid_target', 'git-branch target must declare provider="git-branch-worktree" and devOnly=true')
      }
      return {
        type: 'git-branch',
        repo,
        branch,
        provider: 'git-branch-worktree',
        devOnly: true,
        worktreePath: normalizeString(target.worktreePath) || null,
      }
    }
    default:
      throw new PreviewRegistryError(400, 'preview_invalid_target', `Unsupported preview target type: ${String(target.type || type || 'unknown')}`)
  }
}

async function readRegistry(profile: string): Promise<PreviewRegistryState> {
  try {
    const raw = await readFile(registryPath(profile), 'utf-8')
    const parsed = safeJsonParse(raw)
    if (!parsed) return defaultRegistry(profile)

    const instances = Array.isArray(parsed.instances)
      ? parsed.instances
        .filter((entry: unknown) => entry && typeof entry === 'object')
        .map((entry: Record<string, any>) => ({
          profile,
          id: normalizeString(entry.id) || randomUUID(),
          target: normalizePreviewTarget(entry.target),
          status: entry.status === 'idle' || entry.status === 'running' || entry.status === 'success' || entry.status === 'failed' || entry.status === 'stopped'
            ? entry.status
            : 'idle',
          startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : null,
          finishedAt: typeof entry.finishedAt === 'number' ? entry.finishedAt : null,
          exitCode: typeof entry.exitCode === 'number' ? entry.exitCode : null,
          signal: typeof entry.signal === 'string' ? entry.signal : null,
          error: typeof entry.error === 'string' ? entry.error : null,
          logTail: Array.isArray(entry.logTail)
            ? entry.logTail.filter((line: unknown) => typeof line === 'string').slice(-MAX_LOG_LINES)
            : [],
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
        }))
      : []

    return {
      profile,
      instances,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return defaultRegistry(profile)
    throw new PreviewRegistryError(500, 'preview_registry_read_failed', err instanceof Error ? err.message : 'Failed to read preview registry')
  }
}

async function writeRegistry(profile: string, state: PreviewRegistryState): Promise<void> {
  try {
    await safeFileStore.writeText(registryPath(profile), `${JSON.stringify(state, null, 2)}\n`)
  } catch (err: any) {
    throw new PreviewRegistryError(500, 'preview_registry_write_failed', err instanceof Error ? err.message : 'Failed to write preview registry')
  }
}

async function updateRegistry(
  profile: string,
  updater: (state: PreviewRegistryState) => PreviewRegistryState | Promise<PreviewRegistryState>,
): Promise<PreviewRegistryState> {
  const current = await readRegistry(profile)
  const next = await updater(current)
  next.updatedAt = Date.now()
  await writeRegistry(profile, next)
  return next
}

function resolveInstanceIndex(state: PreviewRegistryState, previewId: string): number {
  const index = state.instances.findIndex(entry => entry.id === previewId)
  if (index >= 0) return index
  if (state.instances.length === 1) return 0
  return -1
}

export async function listPreviewInstances(profile: string): Promise<PreviewInstance[]> {
  const state = await readRegistry(profile)
  return state.instances
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map(toInstance)
}

export async function getPreviewInstance(profile: string, previewId: string): Promise<PreviewInstance | null> {
  const state = await readRegistry(profile)
  const record = state.instances.find(entry => entry.id === previewId) ?? (state.instances.length === 1 ? state.instances[0] : null)
  return record ? toInstance(record) : null
}

export async function startPreviewInstance(profile: string, targetInput: unknown): Promise<PreviewInstance> {
  const target = normalizePreviewTarget(targetInput)
  return startPreviewInstanceWithId(profile, target)
}

export async function startPreviewInstanceWithId(profile: string, target: PreviewTarget, previewId?: string): Promise<PreviewInstance> {
  const now = Date.now()
  const record: PreviewRegistryRecord = {
    profile,
    id: previewId || PREVIEW_SLOT_ID,
    target,
    status: 'running',
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    logTail: [`Preview started: ${describeTarget(target)}`],
    createdAt: now,
    updatedAt: now,
  }

  let storedRecord = record

  await updateRegistry(profile, async (state) => {
    const index = resolveInstanceIndex(state, record.id)
    if (index < 0) {
      return {
        ...state,
        instances: [...state.instances, record],
      }
    }

    const instances = state.instances.slice()
    const nextRecord = {
      ...state.instances[index],
      ...record,
      createdAt: state.instances[index].createdAt,
    }
    instances[index] = nextRecord
    storedRecord = nextRecord
    return { ...state, instances }
  })

  return toInstance(storedRecord)
}

export async function updatePreviewInstance(profile: string, previewId: string, patch: Partial<Omit<PreviewRegistryRecord, 'profile' | 'id' | 'createdAt' | 'updatedAt'>>): Promise<PreviewInstance> {
  const now = Date.now()
  let updatedRecord: PreviewRegistryRecord | null = null

  await updateRegistry(profile, async (state) => {
    const index = resolveInstanceIndex(state, previewId)
    if (index < 0) {
      throw new PreviewRegistryError(404, 'preview_not_found', `Preview instance not found: ${previewId}`)
    }

    const current = state.instances[index]
    updatedRecord = {
      ...current,
      ...patch,
      id: current.id,
      profile,
      updatedAt: now,
      logTail: Array.isArray(patch.logTail)
        ? patch.logTail.filter((line): line is string => typeof line === 'string').slice(-MAX_LOG_LINES)
        : current.logTail,
    }

    const instances = state.instances.slice()
    instances[index] = updatedRecord
    return { ...state, instances }
  })

  if (!updatedRecord) {
    throw new PreviewRegistryError(500, 'preview_registry_write_failed', `Unable to update preview instance: ${previewId}`)
  }

  return toInstance(updatedRecord)
}

export async function removePreviewInstance(profile: string, previewId: string): Promise<void> {
  await updateRegistry(profile, async (state) => {
    const index = resolveInstanceIndex(state, previewId)
    if (index < 0) {
      throw new PreviewRegistryError(404, 'preview_not_found', `Preview instance not found: ${previewId}`)
    }
    return {
      ...state,
      instances: state.instances.filter((_, entryIndex) => entryIndex !== index),
    }
  })
}

export async function stopPreviewInstance(profile: string, previewId: string, reason = 'Preview stopped'): Promise<PreviewInstance> {
  const now = Date.now()
  let updatedRecord: PreviewRegistryRecord | null = null

  await updateRegistry(profile, async (state) => {
    const index = resolveInstanceIndex(state, previewId)
    if (index < 0) {
      throw new PreviewRegistryError(404, 'preview_not_found', `Preview instance not found: ${previewId}`)
    }

    const current = state.instances[index]
    if (current.status !== 'running') {
      updatedRecord = current
      return state
    }

    updatedRecord = {
      ...current,
      status: 'stopped',
      finishedAt: now,
      exitCode: 0,
      signal: null,
      error: null,
      logTail: [...current.logTail, reason.trim() ? `Preview stopped: ${reason.trim()}` : 'Preview stopped'].slice(-MAX_LOG_LINES),
      updatedAt: now,
    }

    const instances = state.instances.slice()
    instances[index] = updatedRecord
    return { ...state, instances }
  })

  if (!updatedRecord) {
    throw new PreviewRegistryError(500, 'preview_registry_write_failed', `Unable to stop preview instance: ${previewId}`)
  }

  return toInstance(updatedRecord)
}

export async function __resetPreviewRegistryForTest(profile: string): Promise<void> {
  try {
    await safeFileStore.writeText(registryPath(profile), `${JSON.stringify(defaultRegistry(profile), null, 2)}\n`)
  } catch {
    // ignore test cleanup errors
  }
}
