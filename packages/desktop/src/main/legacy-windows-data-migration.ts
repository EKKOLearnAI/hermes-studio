import { copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { hermesHome as resolveHermesHome } from './paths'

export const LEGACY_WINDOWS_DATA_MIGRATION_MARKER = '.studio-windows-appdata-migration.json'
export const LEGACY_WINDOWS_DATA_MIGRATION_STAGING = '.hermes.studio-windows-appdata-migration-staging'
export const LEGACY_WINDOWS_DATA_MIGRATION_BACKUP = '.hermes.studio-windows-appdata-migration-backup'
const GATEWAY_RUNTIME_FILES = new Set(['gateway.pid', 'gateway.lock', 'gateway_state.json'])

type MigrationAction = 'migrate' | 'decline'
type MigrationState = 'completed' | 'failed' | 'pending'

export interface LegacyWindowsDataMigrationDecision {
  schema: 1
  action: MigrationAction
  state: MigrationState
  sourceDirectory: string
  targetDirectory: string
  decidedAt: string
  completedAt?: string
  failedAt?: string
  error?: string
}

export interface PendingLegacyWindowsDataMigrationResult {
  supported: boolean
  attempted: boolean
  completed: boolean
  retryPending: boolean
  error?: string
}

interface MigrationFileSystem {
  isProcessAlive: (pid: number) => boolean
  renamePath: (source: string, target: string) => Promise<void>
}

export interface PendingLegacyWindowsDataMigrationOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  userHome?: string
  hermesHome?: string
  now?: () => Date
  isProcessAlive?: (pid: number) => boolean
  renamePath?: (source: string, target: string) => Promise<void>
}

interface MigrationEnvironment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  userHome: string
  hermesHome: string
  now: () => Date
  fs: MigrationFileSystem
}

interface MigrationPaths {
  target: string
  marker: string
  staging: string
  backup: string
}

function environment(options: PendingLegacyWindowsDataMigrationOptions): MigrationEnvironment {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const userHome = resolve(options.userHome || (platform === 'win32' ? env.USERPROFILE?.trim() || homedir() : homedir()))
  return {
    platform,
    env,
    userHome,
    hermesHome: resolve(options.hermesHome || resolveHermesHome()),
    now: options.now || (() => new Date()),
    fs: {
      isProcessAlive: options.isProcessAlive || defaultIsProcessAlive,
      renamePath: options.renamePath || rename,
    },
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function migrationPaths(userHome: string): MigrationPaths {
  const target = resolve(userHome, '.hermes')
  return {
    target,
    marker: join(target, LEGACY_WINDOWS_DATA_MIGRATION_MARKER),
    staging: resolve(userHome, LEGACY_WINDOWS_DATA_MIGRATION_STAGING),
    backup: resolve(userHome, LEGACY_WINDOWS_DATA_MIGRATION_BACKUP),
  }
}

function sameWindowsPath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US')
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

function isMigrationDecision(value: unknown): value is LegacyWindowsDataMigrationDecision {
  if (!value || typeof value !== 'object') return false
  const decision = value as Partial<LegacyWindowsDataMigrationDecision>
  return decision.schema === 1
    && (decision.action === 'migrate' || decision.action === 'decline')
    && (decision.state === 'completed' || decision.state === 'failed' || decision.state === 'pending')
    && typeof decision.sourceDirectory === 'string'
    && typeof decision.targetDirectory === 'string'
    && typeof decision.decidedAt === 'string'
}

async function readMarker(markerPath: string): Promise<LegacyWindowsDataMigrationDecision | null> {
  try {
    const value = JSON.parse(await readFile(markerPath, 'utf8')) as unknown
    return isMigrationDecision(value) ? value : null
  } catch {
    return null
  }
}

async function writeMarker(markerPath: string, marker: LegacyWindowsDataMigrationDecision): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true })
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

function allowedLegacySources(env: NodeJS.ProcessEnv): string[] {
  return [env.LOCALAPPDATA, env.APPDATA]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map(value => resolve(value, 'hermes'))
}

function validateAcceptedMarker(
  marker: LegacyWindowsDataMigrationDecision,
  env: MigrationEnvironment,
  paths: MigrationPaths,
): void {
  if (marker.action !== 'migrate' || (marker.state !== 'pending' && marker.state !== 'failed')) {
    throw new Error('Legacy Windows data migration is not pending')
  }
  if (!sameWindowsPath(marker.targetDirectory, paths.target)) {
    throw new Error('Legacy Windows data migration target no longer matches the active Hermes directory')
  }
  if (!allowedLegacySources(env.env).some(candidate => sameWindowsPath(candidate, marker.sourceDirectory))) {
    throw new Error('Legacy Windows data migration source is not an AppData Hermes directory')
  }
}

async function copyEntry(source: string, target: string): Promise<void> {
  const sourceStat = await lstat(source)
  if (sourceStat.isDirectory()) {
    try {
      const targetStat = await lstat(target)
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        await rm(target, { recursive: true, force: true })
      }
    } catch { }
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(source)) {
      if (GATEWAY_RUNTIME_FILES.has(entry)) continue
      await copyEntry(join(source, entry), join(target, entry))
    }
    return
  }

  await mkdir(dirname(target), { recursive: true })
  await rm(target, { recursive: true, force: true })
  if (sourceStat.isSymbolicLink()) {
    await symlink(await readlink(source), target)
    return
  }
  await copyFile(source, target)
}

async function copyDirectoryContents(source: string, target: string, skipMarker = false): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source)) {
    if (GATEWAY_RUNTIME_FILES.has(entry)) continue
    if (skipMarker && entry === LEGACY_WINDOWS_DATA_MIGRATION_MARKER) continue
    await copyEntry(join(source, entry), join(target, entry))
  }
}

async function gatewayRuntimeDirectories(root: string): Promise<string[]> {
  const directories = [root]
  try {
    for (const entry of await readdir(join(root, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(root, 'profiles', entry.name))
    }
  } catch { }
  return directories
}

async function readRuntimePid(path: string, fileName: string): Promise<number | null> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; gateway_state?: unknown }
    if (fileName === 'gateway_state.json') {
      const state = String(data.gateway_state || '').toLowerCase()
      if (state && state !== 'running' && state !== 'starting') return null
    }
    const pid = typeof data.pid === 'number' ? data.pid : Number.parseInt(String(data.pid || ''), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function activeGatewayPids(root: string, isProcessAlive: (pid: number) => boolean): Promise<number[]> {
  const pids = new Set<number>()
  for (const directory of await gatewayRuntimeDirectories(root)) {
    for (const fileName of GATEWAY_RUNTIME_FILES) {
      const pid = await readRuntimePid(join(directory, fileName), fileName)
      if (pid && isProcessAlive(pid)) pids.add(pid)
    }
  }
  return [...pids]
}

async function removeOwnedWorkingDirectory(directory: string, paths: MigrationPaths): Promise<void> {
  if (!(await isDirectory(directory))) return
  const marker = await readMarker(join(directory, LEGACY_WINDOWS_DATA_MIGRATION_MARKER))
  if (!marker || marker.action !== 'migrate' || !sameWindowsPath(marker.targetDirectory, paths.target)) {
    throw new Error(`Refusing to remove unrecognized migration directory: ${directory}`)
  }
  await rm(directory, { recursive: true, force: true })
}

async function recoverInterruptedSwap(env: MigrationEnvironment, paths: MigrationPaths): Promise<boolean> {
  let completedRecovery = false
  let targetExists = await isDirectory(paths.target)
  const stagingExists = await isDirectory(paths.staging)
  let backupExists = await isDirectory(paths.backup)

  if (!targetExists && stagingExists) {
    const stagedMarker = await readMarker(join(paths.staging, LEGACY_WINDOWS_DATA_MIGRATION_MARKER))
    if (stagedMarker?.action === 'migrate'
      && stagedMarker.state === 'completed'
      && sameWindowsPath(stagedMarker.targetDirectory, paths.target)) {
      await env.fs.renamePath(paths.staging, paths.target)
      targetExists = true
      completedRecovery = true
      if (backupExists) {
        await removeOwnedWorkingDirectory(paths.backup, paths)
        backupExists = false
      }
    }
  }

  if (!targetExists && backupExists) {
    await env.fs.renamePath(paths.backup, paths.target)
    targetExists = true
    backupExists = false
  }

  if (targetExists && backupExists) {
    const targetMarker = await readMarker(paths.marker)
    if (targetMarker?.action === 'migrate' && targetMarker.state === 'completed') {
      await removeOwnedWorkingDirectory(paths.backup, paths)
      backupExists = false
      completedRecovery = true
    } else {
      throw new Error(`Legacy Windows data migration backup requires manual recovery: ${paths.backup}`)
    }
  }

  if (targetExists && await isDirectory(paths.staging)) {
    await removeOwnedWorkingDirectory(paths.staging, paths)
  }
  return completedRecovery
}

function completedMarker(marker: LegacyWindowsDataMigrationDecision, now: Date): LegacyWindowsDataMigrationDecision {
  return {
    ...marker,
    state: 'completed',
    completedAt: now.toISOString(),
    failedAt: undefined,
    error: undefined,
  }
}

function failedMarker(marker: LegacyWindowsDataMigrationDecision, now: Date, error: unknown): LegacyWindowsDataMigrationDecision {
  return {
    ...marker,
    state: 'failed',
    completedAt: undefined,
    failedAt: now.toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Complete an accepted AppData migration before Desktop starts the Web UI
 * server or Hermes gateway. A failed attempt keeps the accepted marker and is
 * retried on the next launch without asking the user again.
 */
export async function migratePendingLegacyWindowsData(
  options: PendingLegacyWindowsDataMigrationOptions = {},
): Promise<PendingLegacyWindowsDataMigrationResult> {
  const env = environment(options)
  const paths = migrationPaths(env.userHome)
  const supported = env.platform === 'win32' && sameWindowsPath(env.hermesHome, paths.target)
  if (!supported) return { supported: false, attempted: false, completed: false, retryPending: false }

  let completedRecovery = false
  try {
    completedRecovery = await recoverInterruptedSwap(env, paths)
  } catch (error) {
    return {
      supported: true,
      attempted: true,
      completed: false,
      retryPending: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const marker = await readMarker(paths.marker)
  if (!marker || marker.action !== 'migrate' || marker.state === 'completed') {
    return {
      supported: true,
      attempted: completedRecovery,
      completed: completedRecovery,
      retryPending: false,
    }
  }

  let targetMoved = false
  try {
    validateAcceptedMarker(marker, env, paths)
    if (!(await isDirectory(marker.sourceDirectory))) {
      throw new Error(`Legacy Windows Hermes data directory is unavailable: ${marker.sourceDirectory}`)
    }
    const sourceGatewayPids = await activeGatewayPids(marker.sourceDirectory, env.fs.isProcessAlive)
    if (sourceGatewayPids.length > 0) {
      throw new Error(`Legacy Windows Hermes gateway is still using the source directory (PID: ${sourceGatewayPids.join(', ')})`)
    }

    await mkdir(paths.staging, { recursive: true })
    await writeMarker(join(paths.staging, LEGACY_WINDOWS_DATA_MIGRATION_MARKER), marker)
    await copyDirectoryContents(paths.target, paths.staging, true)
    await copyDirectoryContents(marker.sourceDirectory, paths.staging, true)
    await writeMarker(
      join(paths.staging, LEGACY_WINDOWS_DATA_MIGRATION_MARKER),
      completedMarker(marker, env.now()),
    )

    await env.fs.renamePath(paths.target, paths.backup)
    targetMoved = true
    try {
      await env.fs.renamePath(paths.staging, paths.target)
      targetMoved = false
    } catch (error) {
      await env.fs.renamePath(paths.backup, paths.target)
      targetMoved = false
      throw error
    }
    // Activation has completed once staging becomes the target. Backup cleanup
    // is best-effort here; startup recovery will remove it on the next launch.
    try { await removeOwnedWorkingDirectory(paths.backup, paths) } catch { }

    return { supported: true, attempted: true, completed: true, retryPending: false }
  } catch (error) {
    if (targetMoved && !(await isDirectory(paths.target)) && await isDirectory(paths.backup)) {
      try {
        await env.fs.renamePath(paths.backup, paths.target)
        targetMoved = false
      } catch { }
    }

    if (await isDirectory(paths.target)) {
      try {
        await writeMarker(paths.marker, failedMarker(marker, env.now(), error))
      } catch { }
      if (await isDirectory(paths.staging)) {
        try { await removeOwnedWorkingDirectory(paths.staging, paths) } catch { }
      }
    }

    return {
      supported: true,
      attempted: true,
      completed: false,
      retryPending: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
