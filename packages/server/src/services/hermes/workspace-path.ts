import { existsSync } from 'fs'
import { stat } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, resolve, win32 as pathWin32 } from 'path'
import { isPathWithin, isRealPathWithin } from './hermes-path'

export function workspaceBaseOverride(): string {
  return process.env.WORKSPACE_BASE?.trim() || ''
}

export function useWindowsDriveWorkspaceMode(): boolean {
  return process.platform === 'win32' && !workspaceBaseOverride()
}

function windowsDriveRoot(pathValue: string): string | null {
  const match = /^([a-zA-Z]:)[\\/]?$/.exec(pathValue.trim())
  return match ? `${match[1].toUpperCase()}\\` : null
}

export function normalizeWindowsWorkspacePath(inputPath: string): { base: string; fullPath: string } | null {
  const raw = String(inputPath || '').trim()
  if (!/^[a-zA-Z]:[\\/]/.test(raw)) return null
  const fullPath = pathWin32.resolve(raw)
  const root = windowsDriveRoot(pathWin32.parse(fullPath).root)
  if (!root) return null
  const rel = pathWin32.relative(root, fullPath)
  if (rel.startsWith('..') || pathWin32.isAbsolute(rel)) return null
  return { base: root, fullPath }
}

export async function isWorkspaceListPathAllowed(
  fullPath: string,
  basePath: string,
  statFn: typeof stat,
  options: { trustWindowsDriveRoot?: boolean; trustWindowsJunctions?: boolean; realPathWithinFn?: typeof isRealPathWithin } = {},
): Promise<boolean> {
  try {
    const info = await statFn(fullPath)
    if (!info.isDirectory()) return false
    if (process.platform === 'win32' && options.trustWindowsDriveRoot) return true
    return await (options.realPathWithinFn || isRealPathWithin)(fullPath, basePath)
  } catch {
    return false
  }
}

export async function resolveAllowedWorkspaceFolder(inputPath: string): Promise<{ base: string; fullPath: string } | null> {
  const raw = String(inputPath || '').trim()
  if (!raw) return null

  if (useWindowsDriveWorkspaceMode()) {
    const resolved = normalizeWindowsWorkspacePath(raw)
    if (!resolved) return null
    return await isWorkspaceListPathAllowed(resolved.fullPath, resolved.base, stat, { trustWindowsDriveRoot: true }) ? resolved : null
  }

  const base = workspaceBaseOverride() || homedir()
  const fullPath = isAbsolute(raw) ? resolve(raw) : resolve(join(base, raw))
  if (!isPathWithin(fullPath, base)) return null
  if (!existsSync(fullPath)) return null
  return await isWorkspaceListPathAllowed(fullPath, base, stat) ? { base, fullPath } : null
}

export async function assertAllowedWorkspaceFolder(inputPath: string): Promise<{ base: string; fullPath: string }> {
  const raw = String(inputPath || '').trim()
  const resolved = await resolveAllowedWorkspaceFolder(raw)
  if (resolved) return resolved
  const err = new Error(raw ? 'Workspace folder is not allowed' : 'workspace is required') as Error & { status?: number }
  err.status = raw ? 403 : 400
  throw err
}
