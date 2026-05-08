import { readFile, writeFile, mkdir } from 'fs/promises'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const APP_HOME = join(homedir(), '.hermes-web-ui')
const LOCK_FILE = join(APP_HOME, '.login-lock.json')

// Per-IP settings
const IP_MAX_FAILURES = 3
const IP_LOCK_DURATION_MS = 60 * 60_000 // 1 hour
const IP_MAP_MAX_SIZE = 10000

// Global safety net (against distributed attacks)
const GLOBAL_WINDOW_MS = 60_000
const GLOBAL_MAX_REQUESTS_PER_WINDOW = 100
const GLOBAL_MAX_TOTAL_FAILURES = 50
const GLOBAL_LOCK_DURATION_MS = 30 * 60_000 // 30 minutes

interface IpEntry {
  failures: number
  lockedUntil: number
}

interface LimiterState {
  passwordIpMap: Record<string, IpEntry>
  tokenIpMap: Record<string, IpEntry>
  globalMinuteCount: number
  globalMinuteWindow: number
  globalTotalFailures: number
  globalLockedUntil: number
}

let state: LimiterState = {
  passwordIpMap: {},
  tokenIpMap: {},
  globalMinuteCount: 0,
  globalMinuteWindow: 0,
  globalTotalFailures: 0,
  globalLockedUntil: 0,
}

let dirty = false
let persistTimer: ReturnType<typeof setTimeout> | null = null

function now(): number {
  return Date.now()
}

function extractIp(ctx: any): string {
  return ctx?.ip || ctx?.request?.ip || 'unknown'
}

function pruneIpMap(map: Record<string, IpEntry>): void {
  const keys = Object.keys(map)
  if (keys.length <= IP_MAP_MAX_SIZE) return
  const t = now()
  for (const key of keys) {
    if (map[key].lockedUntil > 0 && t >= map[key].lockedUntil) {
      delete map[key]
    }
  }
  const remaining = Object.keys(map)
  if (remaining.length <= IP_MAP_MAX_SIZE) return
  remaining.sort((a, b) => (map[a].lockedUntil || 0) - (map[b].lockedUntil || 0))
  for (let i = 0; i < remaining.length - IP_MAP_MAX_SIZE; i++) {
    delete map[remaining[i]]
  }
}

async function loadState(): Promise<void> {
  try {
    const raw = await readFile(LOCK_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    state = {
      passwordIpMap: parsed.passwordIpMap || {},
      tokenIpMap: parsed.tokenIpMap || {},
      globalMinuteCount: parsed.globalMinuteCount || 0,
      globalMinuteWindow: parsed.globalMinuteWindow || 0,
      globalTotalFailures: parsed.globalTotalFailures || 0,
      globalLockedUntil: parsed.globalLockedUntil || 0,
    }
  } catch {
    // use defaults
  }
}

async function persistState(): Promise<void> {
  try {
    await mkdir(APP_HOME, { recursive: true })
    await writeFile(LOCK_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    dirty = false
  } catch {
    // best effort
  }
}

function persistStateSync(): void {
  try {
    writeFileSync(LOCK_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    dirty = false
  } catch {
    // best effort
  }
}

function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (dirty) persistState().catch(() => {})
  }, 2000)
}

export type CheckResult =
  | { allowed: true }
  | { allowed: false; status: 429 | 503 }

function checkGlobalLimits(): CheckResult | null {
  const t = now()
  if (state.globalLockedUntil > 0 && t < state.globalLockedUntil) {
    return { allowed: false, status: 503 }
  }
  if (state.globalLockedUntil > 0 && t >= state.globalLockedUntil) {
    state.globalLockedUntil = 0
    state.globalTotalFailures = 0
    dirty = true
  }
  if (t - state.globalMinuteWindow >= GLOBAL_WINDOW_MS) {
    state.globalMinuteWindow = t
    state.globalMinuteCount = 0
  }
  if (state.globalMinuteCount >= GLOBAL_MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, status: 429 }
  }
  return null
}

function checkIpLock(ip: string, map: Record<string, IpEntry>): CheckResult | null {
  const t = now()
  const entry = map[ip]
  if (entry && entry.lockedUntil > 0 && t < entry.lockedUntil) {
    return { allowed: false, status: 429 }
  }
  if (entry && entry.lockedUntil > 0 && t >= entry.lockedUntil) {
    delete map[ip]
    dirty = true
  }
  return null
}

export function checkPassword(ip: string): CheckResult {
  const global = checkGlobalLimits()
  if (global) return global

  // Check both maps — IP locked by either password or token = blocked
  const ipLock = checkIpLock(ip, state.passwordIpMap) || checkIpLock(ip, state.tokenIpMap)
  if (ipLock) return ipLock

  state.globalMinuteCount++
  dirty = true
  schedulePersist()
  return { allowed: true }
}

export function checkToken(ip: string): CheckResult {
  const global = checkGlobalLimits()
  if (global) return global

  // Check both maps — IP locked by either password or token = blocked
  const ipLock = checkIpLock(ip, state.tokenIpMap) || checkIpLock(ip, state.passwordIpMap)
  if (ipLock) return ipLock

  state.globalMinuteCount++
  dirty = true
  schedulePersist()
  return { allowed: true }
}

export function recordPasswordFailure(ip: string): void {
  if (!state.passwordIpMap[ip]) {
    state.passwordIpMap[ip] = { failures: 0, lockedUntil: 0 }
  }
  const entry = state.passwordIpMap[ip]
  entry.failures++
  state.globalTotalFailures++
  dirty = true

  if (entry.failures >= IP_MAX_FAILURES) {
    entry.lockedUntil = now() + IP_LOCK_DURATION_MS
    persistStateSync()
    return
  }
  if (state.globalTotalFailures >= GLOBAL_MAX_TOTAL_FAILURES) {
    state.globalLockedUntil = now() + GLOBAL_LOCK_DURATION_MS
    persistStateSync()
    return
  }
  pruneIpMap(state.passwordIpMap)
  schedulePersist()
}

export function recordTokenFailure(ip: string): void {
  if (!state.tokenIpMap[ip]) {
    state.tokenIpMap[ip] = { failures: 0, lockedUntil: 0 }
  }
  const entry = state.tokenIpMap[ip]
  entry.failures++
  state.globalTotalFailures++
  dirty = true

  if (entry.failures >= IP_MAX_FAILURES) {
    entry.lockedUntil = now() + IP_LOCK_DURATION_MS
    persistStateSync()
    return
  }
  if (state.globalTotalFailures >= GLOBAL_MAX_TOTAL_FAILURES) {
    state.globalLockedUntil = now() + GLOBAL_LOCK_DURATION_MS
    persistStateSync()
    return
  }
  pruneIpMap(state.tokenIpMap)
  schedulePersist()
}

export function recordPasswordSuccess(ip: string): void {
  if (state.passwordIpMap[ip]) {
    delete state.passwordIpMap[ip]
    state.globalTotalFailures = 0
    dirty = true
    schedulePersist()
  }
}

export function reset(): void {
  state = {
    passwordIpMap: {}, tokenIpMap: {},
    globalMinuteCount: 0, globalMinuteWindow: 0,
    globalTotalFailures: 0, globalLockedUntil: 0,
  }
  dirty = true
  schedulePersist()
}

export interface LockedIpInfo {
  ip: string
  type: 'password' | 'token'
  failures: number
  lockedUntil: number
}

export function getLockedIps(): LockedIpInfo[] {
  const t = now()
  const result: LockedIpInfo[] = []
  for (const [ip, entry] of Object.entries(state.passwordIpMap)) {
    if (entry.lockedUntil > 0 && t < entry.lockedUntil) {
      result.push({ ip, type: 'password', failures: entry.failures, lockedUntil: entry.lockedUntil })
    }
  }
  for (const [ip, entry] of Object.entries(state.tokenIpMap)) {
    if (entry.lockedUntil > 0 && t < entry.lockedUntil) {
      result.push({ ip, type: 'token', failures: entry.failures, lockedUntil: entry.lockedUntil })
    }
  }
  return result
}

export function unlockIp(ip: string): boolean {
  let found = false
  if (state.passwordIpMap[ip]) {
    delete state.passwordIpMap[ip]
    found = true
  }
  if (state.tokenIpMap[ip]) {
    delete state.tokenIpMap[ip]
    found = true
  }
  if (found) {
    dirty = true
    persistStateSync()
  }
  return found
}

export function unlockAll(): number {
  const count = getLockedIps().length
  state.passwordIpMap = {}
  state.tokenIpMap = {}
  state.globalTotalFailures = 0
  state.globalLockedUntil = 0
  dirty = true
  persistStateSync()
  return count
}

export { extractIp }

export async function initLoginLimiter(): Promise<void> {
  await loadState()
  const t = now()
  let changed = false
  for (const [ip, entry] of Object.entries(state.passwordIpMap)) {
    if (entry.lockedUntil > 0 && t >= entry.lockedUntil) {
      delete state.passwordIpMap[ip]
      changed = true
    }
  }
  for (const [ip, entry] of Object.entries(state.tokenIpMap)) {
    if (entry.lockedUntil > 0 && t >= entry.lockedUntil) {
      delete state.tokenIpMap[ip]
      changed = true
    }
  }
  if (state.globalLockedUntil > 0 && t >= state.globalLockedUntil) {
    state.globalLockedUntil = 0
    state.globalTotalFailures = 0
    changed = true
  }
  if (changed) {
    dirty = true
    await persistState()
  }
}
