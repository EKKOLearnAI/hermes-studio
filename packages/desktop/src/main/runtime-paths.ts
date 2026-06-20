import { arch, platform } from 'node:os'
import { join, resolve } from 'node:path'

export type DesktopRuntimeResource = 'python' | 'node' | 'git'

export function runtimePlatformKey(platformName = platform(), archName = arch()): string {
  const osLabel = platformName === 'win32' ? 'win' : platformName === 'darwin' ? 'mac' : platformName
  return `${osLabel}-${archName}`
}

export function resolveRuntimeResourceDir(
  name: DesktopRuntimeResource,
  packaged: boolean,
  appPath: string,
  runtimeRoot: string,
  platformKey = runtimePlatformKey(),
): string {
  if (packaged) return join(runtimeRoot, name)
  return resolve(appPath, 'resources', name, platformKey)
}
