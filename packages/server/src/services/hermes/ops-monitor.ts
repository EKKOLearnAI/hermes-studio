import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { cpus, freemem, loadavg, platform, totalmem, uptime } from 'os'
import { AgentBridgeClient } from './agent-bridge'
import { getAgentBridgeManager } from './agent-bridge/manager'

export interface ProcessUsage {
  pid: number
  role: 'web' | 'broker' | 'worker'
  profile?: string
  running: boolean
  cpuPercent: number
  memoryRssBytes: number
  command?: string
  error?: string
}

export interface OpsRuntimeSnapshot {
  timestamp: number
  system: {
    platform: NodeJS.Platform
    arch: string
    uptimeSeconds: number
    cpuCount: number
    cpuPercent: number
    loadAverage: number[]
    totalMemoryBytes: number
    freeMemoryBytes: number
    usedMemoryBytes: number
    memoryPercent: number
  }
  web: {
    pid: number
    uptimeSeconds: number
    memory: NodeJS.MemoryUsage
    cpuPercent: number
  }
  bridge: {
    endpoint: string
    reachable: boolean
    error?: string
    broker: {
      running: boolean
      ready: boolean
      pid?: number
      process?: ProcessUsage
      restartScheduled: boolean
      restartAttempts: number
    }
    workers: Array<ProcessUsage & {
      endpoint?: string
      lastUsedAt?: number
      sessionCount: number
      runningSessionCount: number
    }>
    totalWorkerMemoryRssBytes: number
  }
  sessions: {
    active: number
    running: number
    byProfile: Record<string, number>
  }
}

interface CpuTimesSample {
  idle: number
  total: number
}

interface WebCpuSample {
  at: number
  usage: NodeJS.CpuUsage
}

interface SystemMemoryUsage {
  totalMemoryBytes: number
  freeMemoryBytes: number
  usedMemoryBytes: number
  memoryPercent: number
}

let previousSystemCpu: CpuTimesSample | null = null
let previousWebCpu: WebCpuSample | null = null

function safeCpus(): ReturnType<typeof cpus> {
  try {
    return cpus()
  } catch {
    return []
  }
}

function safeLoadAverage(): number[] {
  try {
    return loadavg()
  } catch {
    return [0, 0, 0]
  }
}

function safeUptime(): number {
  try {
    return uptime()
  } catch {
    return 0
  }
}

function safeProcessUptime(): number {
  try {
    return process.uptime()
  } catch {
    return 0
  }
}

function safeProcessMemoryUsage(): NodeJS.MemoryUsage {
  try {
    return process.memoryUsage()
  } catch {
    return {
      rss: 0,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    }
  }
}

function readCpuTimes(): CpuTimesSample {
  let idle = 0
  let total = 0
  for (const cpu of safeCpus()) {
    idle += cpu.times.idle
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
  }
  return { idle, total }
}

function sampleSystemCpuPercent(): number | null {
  try {
    const current = readCpuTimes()
    const previous = previousSystemCpu
    previousSystemCpu = current
    if (!previous) return null

    const idleDelta = current.idle - previous.idle
    const totalDelta = current.total - previous.total
    if (totalDelta <= 0) return null
    return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100)
  } catch {
    return null
  }
}

function sampleWebCpuPercent(): number | null {
  try {
    const current = {
      at: Date.now(),
      usage: process.cpuUsage(),
    }
    const previous = previousWebCpu
    previousWebCpu = current
    if (!previous) return null

    const elapsedMicros = (current.at - previous.at) * 1000
    const used = (current.usage.user - previous.usage.user) + (current.usage.system - previous.usage.system)
    if (elapsedMicros <= 0 || used < 0) return null
    return clampPercent((used / elapsedMicros / Math.max(safeCpus().length, 1)) * 100)
  } catch {
    return null
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function fallbackSystemMemoryUsage(): SystemMemoryUsage {
  let memoryTotal = 0
  let memoryFree = 0
  try {
    memoryTotal = totalmem()
    memoryFree = freemem()
  } catch {}
  const usedMemory = memoryTotal - memoryFree
  return {
    totalMemoryBytes: memoryTotal,
    freeMemoryBytes: memoryFree,
    usedMemoryBytes: usedMemory,
    memoryPercent: memoryTotal > 0 ? clampPercent((usedMemory / memoryTotal) * 100) : 0,
  }
}

function parseVmStatPageCount(line: string): number | null {
  const match = line.match(/:\s+([\d.]+)\.?$/)
  if (!match) return null
  const value = Number(match[1].replace(/\./g, ''))
  return Number.isFinite(value) ? value : null
}

export function parseMacVmStatMemory(vmStatOutput: string, totalMemoryBytes: number): SystemMemoryUsage | null {
  const pageSize = Number(vmStatOutput.match(/page size of\s+(\d+)\s+bytes/i)?.[1])
  if (!Number.isFinite(pageSize) || pageSize <= 0 || totalMemoryBytes <= 0) return null

  const pages: Record<string, number> = {}
  for (const line of vmStatOutput.split(/\r?\n/)) {
    const count = parseVmStatPageCount(line.trim())
    if (count == null) continue
    if (line.includes('Pages active')) pages.active = count
    else if (line.includes('Pages wired down')) pages.wired = count
    else if (line.includes('Pages occupied by compressor')) pages.compressed = count
  }

  const usedPages = (pages.active || 0) + (pages.wired || 0) + (pages.compressed || 0)
  if (usedPages <= 0) return null
  const usedMemory = Math.min(totalMemoryBytes, usedPages * pageSize)
  const freeMemory = Math.max(0, totalMemoryBytes - usedMemory)

  return {
    totalMemoryBytes,
    freeMemoryBytes: freeMemory,
    usedMemoryBytes: usedMemory,
    memoryPercent: clampPercent((usedMemory / totalMemoryBytes) * 100),
  }
}

function collectMacSystemMemoryUsage(): SystemMemoryUsage | null {
  try {
    const totalRaw = execFileSync('sysctl', ['-n', 'hw.memsize'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim()
    const totalMemoryBytes = Number(totalRaw)
    const vmStatOutput = execFileSync('vm_stat', {
      encoding: 'utf-8',
      timeout: 3000,
    })
    return parseMacVmStatMemory(vmStatOutput, totalMemoryBytes)
  } catch {
    return null
  }
}

function collectSystemMemoryUsage(): SystemMemoryUsage {
  if (platform() === 'darwin') {
    return collectMacSystemMemoryUsage() || fallbackSystemMemoryUsage()
  }
  return fallbackSystemMemoryUsage()
}

function collectPosixProcessMetrics(pids: number[]): Map<number, Partial<ProcessUsage>> {
  const metrics = collectProcfsProcessMetrics(pids)
  if (!pids.length) return metrics
  try {
    const output = execFileSync('ps', ['-o', 'pid=,pcpu=,rss=,comm=', '-p', pids.join(',')], {
      encoding: 'utf-8',
      timeout: 3000,
    })
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [pidRaw, cpuRaw, rssRaw, ...commandParts] = trimmed.split(/\s+/)
      const pid = Number(pidRaw)
      if (!Number.isFinite(pid)) continue
      const rssKb = numberOrNull(rssRaw)
      metrics.set(pid, {
        cpuPercent: numberOrNull(cpuRaw) ?? 0,
        memoryRssBytes: rssKb == null ? metrics.get(pid)?.memoryRssBytes : rssKb * 1024,
        command: commandParts.join(' ') || undefined,
      })
    }
    return metrics
  } catch {
    return metrics
  }
}

function collectProcfsProcessMetrics(pids: number[]): Map<number, Partial<ProcessUsage>> {
  const metrics = new Map<number, Partial<ProcessUsage>>()
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8')
      const rssKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB/im)?.[1])
      const name = status.match(/^Name:\s+(.+)$/im)?.[1]?.trim()
      metrics.set(pid, {
        cpuPercent: 0,
        memoryRssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
        command: name,
      })
    } catch {}
  }
  return metrics
}

function parseWindowsJson(output: string): any[] {
  if (!output.trim()) return []
  const parsed = JSON.parse(output)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function collectWindowsProcessMetrics(pids: number[]): Map<number, Partial<ProcessUsage>> {
  if (!pids.length) return new Map()
  const idList = pids.join(',')
  try {
    const script = [
      `$ids=@(${idList})`,
      'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process',
      '| Where-Object { $ids -contains [int]$_.IDProcess }',
      '| Select-Object @{Name="pid";Expression={[int]$_.IDProcess}},@{Name="cpuPercent";Expression={[double]$_.PercentProcessorTime}},@{Name="memoryRssBytes";Expression={[double]$_.WorkingSet}},@{Name="command";Expression={$_.Name}}',
      '| ConvertTo-Json -Compress',
    ].join(' ')
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    })
    const metrics = new Map<number, Partial<ProcessUsage>>()
    for (const item of parseWindowsJson(output)) {
      const pid = Number(item?.pid)
      if (!Number.isFinite(pid)) continue
      metrics.set(pid, {
        cpuPercent: numberOrNull(item?.cpuPercent) ?? 0,
        memoryRssBytes: numberOrNull(item?.memoryRssBytes) ?? 0,
        command: typeof item?.command === 'string' ? item.command : undefined,
      })
    }
    return metrics
  } catch {}

  const metrics = new Map<number, Partial<ProcessUsage>>()
  for (const pid of pids) {
    try {
      const output = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf-8',
        timeout: 3000,
        windowsHide: true,
      })
      const line = output.split(/\r?\n/).find(item => item.includes(`"${pid}"`))
      if (!line) continue
      const columns = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g)?.map(value => value.replace(/^"|"$/g, '')) || []
      const memoryKb = Number(columns[4]?.replace(/[^\d]/g, ''))
      metrics.set(pid, {
        cpuPercent: 0,
        memoryRssBytes: Number.isFinite(memoryKb) ? memoryKb * 1024 : 0,
        command: columns[0],
      })
    } catch {}
  }
  return metrics
}

function collectProcessMetrics(pids: number[]): Map<number, Partial<ProcessUsage>> {
  const uniquePids = [...new Set(pids.filter(pid => Number.isFinite(pid) && pid > 0))]
  return platform() === 'win32'
    ? collectWindowsProcessMetrics(uniquePids)
    : collectPosixProcessMetrics(uniquePids)
}

function processUsage(
  pid: number | undefined,
  role: ProcessUsage['role'],
  metrics: Map<number, Partial<ProcessUsage>>,
  profile?: string,
): ProcessUsage | undefined {
  if (!pid) return undefined
  const metric = metrics.get(pid)
  return {
    pid,
    role,
    profile,
    running: !!metric,
    cpuPercent: metric?.cpuPercent ?? 0,
    memoryRssBytes: metric?.memoryRssBytes ?? 0,
    command: metric?.command,
  }
}

function normalizeWorker(raw: unknown): {
  running: boolean
  pid?: number
  endpoint?: string
  lastUsedAt?: number
} {
  if (typeof raw === 'boolean') return { running: raw }
  if (!raw || typeof raw !== 'object') return { running: false }
  const record = raw as Record<string, unknown>
  const pid = Number(record.pid)
  const lastUsedAt = Number(record.last_used_at)
  return {
    running: !!record.running,
    pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
    endpoint: typeof record.endpoint === 'string' ? record.endpoint : undefined,
    lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : undefined,
  }
}

export function createEmptyOpsRuntimeSnapshot(error?: string): OpsRuntimeSnapshot {
  return {
    timestamp: Date.now(),
    system: {
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: safeUptime(),
      cpuCount: safeCpus().length,
      cpuPercent: 0,
      loadAverage: safeLoadAverage(),
      totalMemoryBytes: 0,
      freeMemoryBytes: 0,
      usedMemoryBytes: 0,
      memoryPercent: 0,
    },
    web: {
      pid: process.pid,
      uptimeSeconds: safeProcessUptime(),
      memory: safeProcessMemoryUsage(),
      cpuPercent: 0,
    },
    bridge: {
      endpoint: '',
      reachable: false,
      error,
      broker: {
        running: false,
        ready: false,
        restartScheduled: false,
        restartAttempts: 0,
      },
      workers: [],
      totalWorkerMemoryRssBytes: 0,
    },
    sessions: {
      active: 0,
      running: 0,
      byProfile: {},
    },
  }
}

export async function getOpsRuntimeSnapshot(): Promise<OpsRuntimeSnapshot> {
  const manager = getAgentBridgeManager()
  const managerState = manager.getRuntimeState()
  let bridgeReachable = false
  let bridgeError: string | undefined
  let bridgePing: Record<string, any> = {}
  let sessions: Array<Record<string, any>> = []

  try {
    const client = new AgentBridgeClient({ endpoint: managerState.endpoint, timeoutMs: 2000, connectRetryMs: 0 })
    bridgePing = await client.ping() as Record<string, any>
    bridgeReachable = true
    try {
      const list = await client.list()
      sessions = Array.isArray((list as any).sessions) ? (list as any).sessions : []
    } catch {}
  } catch (err: any) {
    bridgeError = err?.message || 'Agent bridge is not reachable'
  }

  const workerEntries = Object.entries((bridgePing.worker_details || {}) as Record<string, unknown>)
    .map(([profile, value]) => [profile, normalizeWorker(value)] as const)
  const brokerPid = Number(bridgePing.broker?.pid || managerState.pid)
  const pids = [
    process.pid,
    Number.isFinite(brokerPid) ? brokerPid : undefined,
    ...workerEntries.map(([, worker]) => worker.pid),
  ].filter((pid): pid is number => typeof pid === 'number' && pid > 0)
  const processMetrics = collectProcessMetrics(pids)

  const sessionCountsByProfile: Record<string, number> = {}
  let runningSessions = 0
  for (const session of sessions) {
    const profileName = String(session.profile || 'default')
    sessionCountsByProfile[profileName] = (sessionCountsByProfile[profileName] || 0) + 1
    if (session.running) runningSessions += 1
  }
  if (!sessions.length && bridgePing.sessions_by_profile && typeof bridgePing.sessions_by_profile === 'object') {
    for (const [profileName, count] of Object.entries(bridgePing.sessions_by_profile)) {
      const value = Number(count)
      if (Number.isFinite(value)) sessionCountsByProfile[profileName] = value
    }
  }

  const workers = workerEntries.map(([profileName, worker]) => {
    const usage = processUsage(worker.pid, 'worker', processMetrics, profileName)
    return {
      pid: worker.pid || 0,
      role: 'worker' as const,
      profile: profileName,
      running: worker.running,
      cpuPercent: usage?.cpuPercent ?? 0,
      memoryRssBytes: usage?.memoryRssBytes ?? 0,
      command: usage?.command,
      endpoint: worker.endpoint,
      lastUsedAt: worker.lastUsedAt,
      sessionCount: sessionCountsByProfile[profileName] || 0,
      runningSessionCount: sessions.filter(session => String(session.profile || 'default') === profileName && session.running).length,
    }
  })

  const systemMemory = collectSystemMemoryUsage()
  const totalWorkerMemory = workers.reduce((sum, worker) => sum + (worker.memoryRssBytes || 0), 0)

  return {
    timestamp: Date.now(),
    system: {
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: safeUptime(),
      cpuCount: safeCpus().length,
      cpuPercent: sampleSystemCpuPercent() ?? 0,
      loadAverage: safeLoadAverage(),
      totalMemoryBytes: systemMemory.totalMemoryBytes,
      freeMemoryBytes: systemMemory.freeMemoryBytes,
      usedMemoryBytes: systemMemory.usedMemoryBytes,
      memoryPercent: systemMemory.memoryPercent,
    },
    web: {
      pid: process.pid,
      uptimeSeconds: safeProcessUptime(),
      memory: safeProcessMemoryUsage(),
      cpuPercent: sampleWebCpuPercent() ?? 0,
    },
    bridge: {
      endpoint: managerState.endpoint,
      reachable: bridgeReachable,
      error: bridgeError,
      broker: {
        running: managerState.running,
        ready: managerState.ready,
        pid: Number.isFinite(brokerPid) && brokerPid > 0 ? brokerPid : undefined,
        process: processUsage(Number.isFinite(brokerPid) ? brokerPid : undefined, 'broker', processMetrics),
        restartScheduled: managerState.restartScheduled,
        restartAttempts: managerState.restartAttempts,
      },
      workers,
      totalWorkerMemoryRssBytes: totalWorkerMemory,
    },
    sessions: {
      active: sessions.length || Number(bridgePing.active_sessions || 0),
      running: runningSessions,
      byProfile: sessionCountsByProfile,
    },
  }
}
