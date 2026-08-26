import { realpath } from 'fs/promises'
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  win32 as pathWin32,
} from 'path'

function comparablePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function looksLikeWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path)
}

function useWindowsPathOps(...paths: string[]): boolean {
  return process.platform === 'win32' || paths.some(looksLikeWindowsPath)
}

function resolveComparablePath(path: string, useWindows: boolean): string {
  return useWindows ? pathWin32.resolve(path) : resolve(path)
}

function relativeComparablePath(from: string, to: string, useWindows: boolean): string {
  return useWindows ? pathWin32.relative(from, to) : relative(from, to)
}

function isComparableAbsolute(path: string, useWindows: boolean): boolean {
  return useWindows ? pathWin32.isAbsolute(path) : isAbsolute(path)
}

function startsWithParentSegment(relativePath: string): boolean {
  const [first] = relativePath.split(/[\\/]/)
  return first === '..'
}

function dirnameComparablePath(path: string, useWindows: boolean): string {
  return useWindows ? pathWin32.dirname(path) : dirname(path)
}

export function isPathWithin(targetPath: string, basePath: string): boolean {
  const useWindows = useWindowsPathOps(targetPath, basePath)
  const base = resolveComparablePath(basePath, useWindows)
  const target = resolveComparablePath(targetPath, useWindows)
  const rel = relativeComparablePath(comparablePath(base), comparablePath(target), useWindows)
  return rel === '' || (!!rel && !startsWithParentSegment(rel) && !isComparableAbsolute(rel, useWindows))
}

export function relativePathFromBase(targetPath: string, basePath: string): string | null {
  if (!isPathWithin(targetPath, basePath)) return null
  const useWindows = useWindowsPathOps(targetPath, basePath)
  const rel = relativeComparablePath(
    resolveComparablePath(basePath, useWindows),
    resolveComparablePath(targetPath, useWindows),
    useWindows,
  )
  return rel.replace(/\\/g, '/')
}

export async function realPathOrResolved(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath)
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err
    return resolveComparablePath(targetPath, useWindowsPathOps(targetPath))
  }
}

export async function nearestExistingRealPath(targetPath: string): Promise<string | null> {
  const useWindows = useWindowsPathOps(targetPath)
  let current = resolveComparablePath(targetPath, useWindows)
  while (true) {
    try {
      return await realpath(current)
    } catch (err: any) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err
    }

    const parent = dirnameComparablePath(current, useWindows)
    if (parent === current) return null
    current = parent
  }
}

export async function isRealPathWithin(targetPath: string, basePath: string): Promise<boolean> {
  const [realTargetPath, realBasePath] = await Promise.all([
    realPathOrResolved(targetPath),
    realPathOrResolved(basePath),
  ])
  return isPathWithin(realTargetPath, realBasePath)
}

export async function isNearestExistingRealPathWithin(targetPath: string, basePath: string): Promise<boolean> {
  const [realAncestorPath, realBasePath] = await Promise.all([
    nearestExistingRealPath(targetPath),
    realPathOrResolved(basePath),
  ])
  return !!realAncestorPath && isPathWithin(realAncestorPath, realBasePath)
}
