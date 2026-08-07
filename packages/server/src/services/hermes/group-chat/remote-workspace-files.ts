import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isSensitivePath } from '../file-provider'
import {
  groupWorkspaceRelativePath,
  resolveGroupWorkspacePath,
} from './workspace-files'

const MAX_REMOTE_WORKSPACE_FILE_BYTES = 1024 * 1024
const MAX_REMOTE_WORKSPACE_LIST_ENTRIES = 500
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const pathLocks = new Map<string, Promise<void>>()

type RemoteWorkspaceAction =
  | { action: 'list'; path?: unknown }
  | { action: 'read'; path?: unknown }
  | { action: 'write'; path?: unknown; content?: unknown; expectedSha256?: unknown }
  | { action: 'mkdir'; path?: unknown }
  | { action: 'delete'; path?: unknown; expectedSha256?: unknown }

function workspaceError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code })
}

function assertShareablePath(relativePath: string): void {
  const sensitive = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some(segment => isSensitivePath(segment))
  if (sensitive) {
    throw workspaceError('Sensitive files are not available to remote Agents', 403, 'permission_denied')
  }
}

function hash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

async function withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) || Promise.resolve()
  let release = () => {}
  const current = new Promise<void>(resolveLock => {
    release = resolveLock
  })
  pathLocks.set(path, current)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (pathLocks.get(path) === current) pathLocks.delete(path)
  }
}

async function readRegularFile(fullPath: string): Promise<Buffer> {
  const file = await open(fullPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
  try {
    const info = await file.stat()
    if (!info.isFile()) throw workspaceError('Not a file', 400, 'not_a_file')
    if (info.size > MAX_REMOTE_WORKSPACE_FILE_BYTES) {
      throw workspaceError('File is too large for remote workspace access', 413, 'file_too_large')
    }
    const data = await file.readFile()
    if (data.length > MAX_REMOTE_WORKSPACE_FILE_BYTES) {
      throw workspaceError('File is too large for remote workspace access', 413, 'file_too_large')
    }
    return data
  } finally {
    await file.close()
  }
}

async function currentFileHash(fullPath: string): Promise<string | null> {
  try {
    return hash(await readRegularFile(fullPath))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function expectedHash(value: unknown): string {
  const expected = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!SHA256_PATTERN.test(expected)) {
    throw workspaceError('expectedSha256 is required for an existing file', 409, 'workspace_conflict')
  }
  return expected
}

export async function performRemoteWorkspaceAction(
  workspace: string,
  input: RemoteWorkspaceAction,
): Promise<Record<string, unknown>> {
  switch (input.action) {
    case 'list': {
      const target = await resolveGroupWorkspacePath(workspace, input.path, { allowEmpty: true })
      if (target.relativePath) assertShareablePath(target.relativePath)
      const info = await lstat(target.fullPath)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw workspaceError('Not a directory', 400, 'not_a_directory')
      }
      const entries = await readdir(target.fullPath, { withFileTypes: true })
      if (entries.length > MAX_REMOTE_WORKSPACE_LIST_ENTRIES) {
        throw workspaceError('Directory has too many entries', 413, 'too_many_entries')
      }
      const safeEntries: Array<Record<string, unknown>> = []
      for (const entry of entries) {
        const relativePath = groupWorkspaceRelativePath(workspace, resolve(target.fullPath, entry.name))
        try {
          assertShareablePath(relativePath)
        } catch {
          continue
        }
        if (entry.isSymbolicLink()) continue
        const entryInfo = await lstat(resolve(target.fullPath, entry.name))
        if (!entryInfo.isFile() && !entryInfo.isDirectory()) continue
        safeEntries.push({
          name: entry.name,
          path: relativePath,
          type: entryInfo.isDirectory() ? 'directory' : 'file',
          size: entryInfo.size,
          modifiedAt: entryInfo.mtime.toISOString(),
        })
      }
      safeEntries.sort((left, right) => String(left.name).localeCompare(String(right.name)))
      return { ok: true, path: target.relativePath, entries: safeEntries }
    }
    case 'read': {
      const target = await resolveGroupWorkspacePath(workspace, input.path)
      assertShareablePath(target.relativePath)
      const data = await readRegularFile(target.fullPath)
      return {
        ok: true,
        path: target.relativePath,
        content: data.toString('utf8'),
        size: data.length,
        sha256: hash(data),
      }
    }
    case 'write': {
      const target = await resolveGroupWorkspacePath(workspace, input.path)
      assertShareablePath(target.relativePath)
      if (typeof input.content !== 'string') {
        throw workspaceError('content must be a string', 400, 'invalid_content')
      }
      const data = Buffer.from(input.content, 'utf8')
      if (data.length > MAX_REMOTE_WORKSPACE_FILE_BYTES) {
        throw workspaceError('Content is too large for remote workspace access', 413, 'file_too_large')
      }
      return withPathLock(target.fullPath, async () => {
        const currentHash = await currentFileHash(target.fullPath)
        if (currentHash && expectedHash(input.expectedSha256) !== currentHash) {
          throw workspaceError('File changed since it was read', 409, 'workspace_conflict')
        }
        await mkdir(dirname(target.fullPath), { recursive: true, mode: 0o700 })
        const checked = await resolveGroupWorkspacePath(workspace, target.relativePath)
        const tempPath = resolve(dirname(checked.fullPath), `.${randomUUID()}.group-chat-write`)
        const tempFile = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
        try {
          await tempFile.writeFile(data)
          await tempFile.sync()
        } finally {
          await tempFile.close()
        }
        try {
          const latestHash = await currentFileHash(checked.fullPath)
          if (latestHash !== currentHash) {
            throw workspaceError('File changed while it was being written', 409, 'workspace_conflict')
          }
          await rename(tempPath, checked.fullPath)
        } catch (error) {
          await rm(tempPath, { force: true }).catch(() => undefined)
          throw error
        }
        return { ok: true, path: checked.relativePath, size: data.length, sha256: hash(data) }
      })
    }
    case 'mkdir': {
      const target = await resolveGroupWorkspacePath(workspace, input.path)
      assertShareablePath(target.relativePath)
      await mkdir(target.fullPath, { recursive: true, mode: 0o700 })
      await resolveGroupWorkspacePath(workspace, target.relativePath)
      return { ok: true, path: target.relativePath }
    }
    case 'delete': {
      const target = await resolveGroupWorkspacePath(workspace, input.path)
      assertShareablePath(target.relativePath)
      return withPathLock(target.fullPath, async () => {
        const info = await lstat(target.fullPath)
        if (info.isSymbolicLink()) throw workspaceError('Symbolic links are not supported', 400, 'invalid_path')
        if (info.isFile()) {
          const currentHash = await currentFileHash(target.fullPath)
          if (!currentHash || expectedHash(input.expectedSha256) !== currentHash) {
            throw workspaceError('File changed since it was read', 409, 'workspace_conflict')
          }
        } else if (!info.isDirectory()) {
          throw workspaceError('Unsupported file type', 400, 'invalid_path')
        }
        if (info.isDirectory()) await rmdir(target.fullPath)
        else await rm(target.fullPath)
        return { ok: true, path: target.relativePath }
      })
    }
    default:
      throw workspaceError('Unsupported remote workspace action', 400, 'invalid_action')
  }
}
