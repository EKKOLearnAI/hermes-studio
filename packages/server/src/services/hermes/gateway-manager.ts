/**
 * GatewayManager — 多 Profile 网关生命周期管理
 *
 * 核心职责：
 *   1. 启动时检测所有 profile 的网关运行状态（PID、端口、健康检查）
 *   2. 自动发现端口冲突并重新分配
 *   3. 启动/停止网关进程
 *
 * 启动检测流程（detectStatus）：
 *   ① 读取 gateway.pid → 获取 PID
 *   ② 读取 config.yaml (platforms.api_server.extra.port/host) → 获取配置端口
 *   ③ PID 存活？
 *      - 否 → 标记为 stopped
 *      - 是 → 继续
 *   ④ 对配置端口做 health check？
 *      - 通过 → 配置与运行状态匹配，注册网关
 *      - 失败 → 用 lsof 查 PID 实际监听端口
 *   ⑤ 实际端口 ≠ 配置端口？
 *      - 是 → 更新 config.yaml 到实际端口，重新 health check，通过则注册
 *      - 否 → 标记为 stopped
 *
 * 端口分配流程（resolvePort，启动前调用）：
 *   ① 读取配置端口
 *   ② 检查是否被已管理的网关占用
 *   ③ 检查是否被外部系统进程占用（TCP bind 测试）
 *   ④ 冲突则从 base+1 递增找空闲端口，并写入 config.yaml
 *
 * 启动模式：
 *   - 正常系统（macOS/Linux）：hermes gateway start/stop（系统服务管理）
 *   - WSL / Docker：hermes gateway run（detached 子进程，手动 kill）
 */

import { spawn, type ChildProcess } from 'child_process'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createServer } from 'net'
import yaml from 'js-yaml'
import { logger } from '../logger'

const execFileAsync = promisify(execFile)

// ============================
// 常量 & 环境检测
// ============================

const HERMES_BASE = resolve(homedir(), '.hermes')
const HERMES_BIN = process.env.HERMES_BIN?.trim() || 'hermes'

/**
 * 检测系统的 init 系统（服务管理器）
 * - macOS → launchd
 * - Windows → windows-service
 * - Linux → systemd / sysvinit / other
 *
 * 没有 systemd/launchd/windows-service 的环境需要用 "gateway run" 代替 "gateway start"
 * （适用于 WSL/Docker/Termux/proot 等无服务管理器的环境）
 */
function detectInitSystem(): string {
  const platform = process.platform

  // macOS → launchd
  if (platform === 'darwin') {
    return 'launchd'
  }

  // Windows → Service Manager
  if (platform === 'win32') {
    return 'windows-service'
  }

  // Linux 才检查 /proc
  if (platform === 'linux') {
    try {
      const comm = readFileSync('/proc/1/comm', 'utf-8').trim()

      if (comm === 'systemd') return 'systemd'
      if (comm === 'init') return 'sysvinit'

      return 'other'
    } catch {
      return 'unknown'
    }
  }

  return 'unknown'
}

const initSystem = detectInitSystem()
const needsRunMode = !['systemd', 'launchd', 'windows-service'].includes(initSystem)
// 启动时输出 init 系统检测结果（方便调试）
logger.debug('Detected init system: %s (needsRunMode: %s)', initSystem, needsRunMode)

// ============================
// 类型定义
// ============================

export interface GatewayStatus {
  profile: string
  port: number
  host: string
  url: string
  running: boolean
  pid?: number
}

interface ManagedGateway {
  pid: number
  port: number
  host: string
  url: string
  process?: ChildProcess
}

// ============================
// GatewayManager
// ============================

export class GatewayManager {
  /** 已注册的网关：profile name → { pid, port, host, url } */
  private gateways = new Map<string, ManagedGateway>()

  /** 本次启动过程中已分配的端口集合（防止并发分配到相同端口） */
  private allocatedPorts = new Set<number>()

  /** 当前活跃的 profile（用于代理路由的默认上游） */
  private activeProfile: string

  constructor(activeProfile: string) {
    this.activeProfile = activeProfile
  }

  // ============================
  // Profile 目录 & 配置读取
  // ============================

  /** 获取 profile 的 home 目录路径 */
  private profileDir(name: string): string {
    if (name === 'default') return HERMES_BASE
    return join(HERMES_BASE, 'profiles', name)
  }

  /**
   * 从 profile 的 config.yaml 读取 api_server 端口和主机
   * 读取路径：platforms.api_server.extra.port / extra.host
   */
  private readProfilePort(name: string): { port: number; host: string } {
    const configPath = join(this.profileDir(name), 'config.yaml')
    if (!existsSync(configPath)) return { port: 8642, host: '127.0.0.1' }

    try {
      const content = readFileSync(configPath, 'utf-8')
      const cfg = yaml.load(content) as any || {}

      const extra = cfg?.platforms?.api_server?.extra
      const rawPort = extra?.port || 8642
      const port = typeof rawPort === 'number' ? rawPort : parseInt(rawPort, 10) || 8642
      const host = extra?.host || '127.0.0.1'
      // 端口超出合法范围时回退到默认值
      return { port: port > 0 && port <= 65535 ? port : 8642, host }
    } catch {
      return { port: 8642, host: '127.0.0.1' }
    }
  }

  /** 从 profile 的 gateway.pid 文件读取 PID（JSON 格式 { "pid": 12345 }） */
  private readPidFile(name: string): number | null {
    const pidPath = join(this.profileDir(name), 'gateway.pid')
    if (!existsSync(pidPath)) return null

    try {
      const content = readFileSync(pidPath, 'utf-8').trim()
      const data = JSON.parse(content)
      return typeof data.pid === 'number' ? data.pid : parseInt(data.pid, 10) || null
    } catch {
      return null
    }
  }

  // ============================
  // 进程 & 端口检测工具
  // ============================

  /** 检查进程是否存活（发送信号 0，不实际杀死进程） */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** 请求 /health 端点，判断网关是否真正就绪 */
  private async checkHealth(url: string, timeoutMs = 3000): Promise<boolean> {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** 尝试绑定端口，检测端口是否被系统级进程占用 */
  private checkPortAvailable(port: number, host: string): Promise<boolean> {
    if (port < 0 || port > 65535) return Promise.resolve(false)
    return new Promise((resolve) => {
      const server = createServer()
      server.once('error', () => {
        server.close()
        resolve(false)
      })
      server.once('listening', () => {
        server.close()
        resolve(true)
      })
      server.listen(port, host)
    })
  }

  /** 从 base 端口开始递增查找空闲端口（上限 65535） */
  private findFreePort(base: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryPort = (port: number) => {
        if (port > 65535) {
          reject(new Error(`No free port found in range ${base}-65535`))
          return
        }
        const server = createServer()
        server.once('error', () => {
          server.close()
          tryPort(port + 1)
        })
        server.once('listening', () => {
          server.close()
          resolve(port)
        })
        server.listen(port, host)
      }
      tryPort(base)
    })
  }

  // ============================
  // 配置写入
  // ============================

  /**
   * 将端口和主机写入 profile 的 config.yaml
   * 写入完整结构：
   *   platforms:
   *     api_server:
   *       enabled: true
   *       key: ''
   *       cors_origins: '*'
   *       extra:
   *         port: <port>
   *         host: <host>
   * 同时清理旧的顶层 port/host（避免 Hermes 读取错误）
   */
  private writeProfilePort(name: string, port: number, host: string): void {
    const configPath = join(this.profileDir(name), 'config.yaml')
    try {
      const content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
      const cfg = (yaml.load(content) as any) || {}

      if (!cfg.platforms) cfg.platforms = {}
      if (!cfg.platforms.api_server) cfg.platforms.api_server = {}
      if (!cfg.platforms.api_server.extra) cfg.platforms.api_server.extra = {}

      cfg.platforms.api_server.enabled = true
      cfg.platforms.api_server.key = ''
      cfg.platforms.api_server.cors_origins = '*'
      cfg.platforms.api_server.extra.port = port
      cfg.platforms.api_server.extra.host = host

      // 清理旧的顶层 port/host，Hermes 只从 extra 读取
      if (cfg.platforms.api_server.port !== undefined) {
        delete cfg.platforms.api_server.port
      }
      if (cfg.platforms.api_server.host !== undefined) {
        delete cfg.platforms.api_server.host
      }

      writeFileSync(configPath, yaml.dump(cfg, { lineWidth: -1 }), 'utf-8')
      logger.debug('Updated %s: api_server.extra.port = %d', configPath, port)
    } catch (err) {
      logger.error(err, 'Failed to write config for profile "%s"', name)
    }
  }

  // ============================
  // 端口分配
  // ============================

  /**
   * 为 profile 分配可用端口（启动前调用）
   *
   * 检测顺序：
   *   1. 已管理的网关 + 已分配的端口 → 内存级检查（快）
   *   2. 系统 TCP bind 测试 → 检测外部进程占用
   *   3. 冲突则从 base+1 递增找空闲端口，写入 config.yaml
   */
  private async resolvePort(name: string): Promise<{ port: number; host: string }> {
    let { port, host } = this.readProfilePort(name)

    // 收集已占用端口：正在运行的网关 + 本次启动已分配的端口
    const usedPorts = new Set<number>(this.allocatedPorts)
    for (const gw of Array.from(this.gateways.values())) {
      if (gw.host === host && this.isProcessAlive(gw.pid)) {
        usedPorts.add(gw.port)
      }
    }

    if (usedPorts.has(port)) {
      // 已管理端口冲突 → 找空闲端口
      const newPort = await this.findFreePort(port, host)
      logger.info('Port %d is in use for profile "%s", reassigning to %d', port, name, newPort)
      this.writeProfilePort(name, newPort, host)
      port = newPort
    } else {
      // 检查系统级端口占用（外部进程）
      const available = await this.checkPortAvailable(port, host)
      if (!available) {
        const newPort = await this.findFreePort(port, host)
        logger.info('Port %d is occupied by another process for profile "%s", reassigning to %d', port, name, newPort)
        this.writeProfilePort(name, newPort, host)
        port = newPort
      } else {
        // 端口空闲，写入完整配置（确保 api_server 配置齐全）
        this.writeProfilePort(name, port, host)
      }
    }

    this.allocatedPorts.add(port)
    return { port, host }
  }

  // ============================
  // 公开方法：状态查询
  // ============================

  /** 获取指定 profile 的网关 URL（代理路由使用） */
  getUpstream(profileName?: string): string {
    const name = profileName || this.activeProfile
    const gw = this.gateways.get(name)
    if (gw?.url) return gw.url
    const { port, host } = this.readProfilePort(name)
    return `http://${host}:${port}`
  }

  /** 读取 profile 的 API_SERVER_KEY（从 .env 文件） */
  getApiKey(profileName?: string): string | null {
    const name = profileName || this.activeProfile
    try {
      const envPath = join(this.profileDir(name), '.env')
      if (!existsSync(envPath)) return null
      const content = readFileSync(envPath, 'utf-8')
      const match = content.match(/^API_SERVER_KEY\s*=\s*"?([^"\n]+)"?/m)
      return match?.[1]?.trim() || null
    } catch {
      return null
    }
  }

  getActiveProfile(): string {
    return this.activeProfile
  }

  setActiveProfile(name: string) {
    this.activeProfile = name
  }

  /** 列出所有已知 profile 名称（通过 hermes CLI 或文件系统扫描） */
  async listProfiles(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(HERMES_BIN, ['profile', 'list'], {
        timeout: 10000,
        windowsHide: true,
      })
      const profiles: string[] = []
      for (const line of stdout.trim().split('\n')) {
        if (line.startsWith(' Profile') || line.match(/^ ─/)) continue
        const match = line.match(/^\s+(?:◆)?(.+?)\s+/)
        if (match) profiles.push(match[1])
      }
      return profiles
    } catch {
      // CLI 不可用时回退到文件系统扫描
      const profiles = ['default']
      const profilesDir = join(HERMES_BASE, 'profiles')
      if (existsSync(profilesDir)) {
        for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
          if (entry.isDirectory() && existsSync(join(profilesDir, entry.name, 'config.yaml'))) {
            profiles.push(entry.name)
          }
        }
      }
      return profiles
    }
  }

  /**
   * 检测单个 profile 的网关状态（只读，不修改任何进程或配置）
   *
   * 流程：
   *   ① 读 PID 文件 → 检查进程是否存活
   *   ② 读配置端口 → health check
   *   ③ 两者都通过 → 匹配，注册
   *   ④ 否则 → 标记为未运行（不杀进程，由 startAll 处理）
   */
  async detectStatus(name: string): Promise<GatewayStatus> {
    const pid = this.readPidFile(name)
    const { port, host } = this.readProfilePort(name)
    const url = `http://${host}:${port}`

    if (pid && this.isProcessAlive(pid) && await this.checkHealth(url)) {
      this.gateways.set(name, { pid, port, host, url })
      return { profile: name, port, host, url, running: true, pid }
    }

    // 未运行或端口不匹配
    this.gateways.delete(name)
    return { profile: name, port, host, url, running: false }
  }

  /** 检测所有 profile 的网关状态 */
  async listAll(): Promise<GatewayStatus[]> {
    const profiles = await this.listProfiles()
    const statuses = await Promise.all(profiles.map(name => this.detectStatus(name)))
    return statuses
  }

  // ============================
  // 公开方法：启动 & 停止
  // ============================

  /**
   * 启动单个 profile 的网关
   * 启动前自动调用 resolvePort() 确保端口可用且配置完整
   */
  async start(name: string): Promise<GatewayStatus> {
    const { port, host } = await this.resolvePort(name)
    const hermesHome = this.profileDir(name)
    const url = `http://${host}:${port}`

    if (needsRunMode) {
      // WSL / Docker：无 systemd/launchd，用 "gateway run" 作为 detached 子进程
      return new Promise((resolve, reject) => {
        const env = { ...process.env, HERMES_HOME: hermesHome }
        const child = spawn(HERMES_BIN, ['gateway', 'run', '--replace'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env,
        })
        child.unref()

        const pid = child.pid ?? 0
        logger.info('Starting gateway for profile "%s" (run mode, PID: %d, port: %d)', name, pid, port)

        this.waitForReady(name, pid, port, host, url)
          .then(resolve)
          .catch(reject)
      })
    }

    // 正常系统：先 start，失败则 restart（处理服务已运行的情况）
    logger.info('Starting gateway for profile "%s" (start mode, port: %d)', name, port)
    const env = { ...process.env, HERMES_HOME: hermesHome }
    try {
      const { stdout } = await execFileAsync(HERMES_BIN, ['gateway', 'start'], {
        timeout: 30000,
        env,
        windowsHide: true,
      })
      logger.debug('gateway start output: %s', stdout?.trim())
    } catch {
      // start 失败（可能服务已运行），用 restart
      try {
        const { stdout } = await execFileAsync(HERMES_BIN, ['gateway', 'restart'], {
          timeout: 30000,
          env,
          windowsHide: true,
        })
        logger.debug('gateway restart output: %s', stdout?.trim())
      } catch (err: any) {
        logger.warn(err, 'gateway start/restart (non-fatal)')
      }
    }

    return this.waitForReady(name, 0, port, host, url)
  }

  /** 等待网关健康检查通过，最多 15 秒 */
  private async waitForReady(name: string, pid: number, port: number, host: string, url: string): Promise<GatewayStatus> {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (pid && !this.isProcessAlive(pid)) {
        throw new Error(`Gateway process exited unexpectedly (PID: ${pid})`)
      }
      if (await this.checkHealth(url, 2000)) {
        // "gateway start" 自行管理进程，重新从 pid 文件读取实际 PID
        const actualPid = this.readPidFile(name) ?? pid
        this.gateways.set(name, { pid: actualPid, port, host, url })
        return { profile: name, port, host, url, running: true, pid: actualPid || undefined }
      }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error(`Gateway health check timed out after 15000ms`)
  }

  /**
   * 停止单个 profile 的网关
   * 正常系统用 "gateway stop"，WSL/Docker 直接 kill 进程组
   * 返回前等待 health check 确认网关已真正停止
   */
  async stop(name: string, timeoutMs = 10000): Promise<void> {
    // 记录当前 URL，用于确认停止
    const gw = this.gateways.get(name)
    const url = gw?.url || (() => {
      const { port, host } = this.readProfilePort(name)
      return `http://${host}:${port}`
    })()

    if (!needsRunMode) {
      // 正常系统：通过 hermes CLI 停止系统服务
      try {
        const hermesHome = this.profileDir(name)
        const env = { ...process.env, HERMES_HOME: hermesHome }
        await execFileAsync(HERMES_BIN, ['gateway', 'stop'], {
          timeout: 10000,
          env,
          windowsHide: true,
        })
      } catch { }
    } else {
      // WSL / Docker：直接杀进程组
      let pid = gw?.pid
      if (!pid) {
        pid = this.readPidFile(name) ?? undefined
      }
      if (pid) {
        try { process.kill(-pid, 'SIGTERM') } catch {
          try { process.kill(pid, 'SIGTERM') } catch { }
        }
      }
    }

    // 等待 health check 失败，确认网关已真正停止
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await this.checkHealth(url, 1000))) {
        this.gateways.delete(name)
        logger.info('Stopped gateway for profile "%s"', name)
        return
      }
      await new Promise(r => setTimeout(r, 300))
    }
    // 超时也清理
    this.gateways.delete(name)
    logger.warn('Stopped gateway for profile "%s" (timeout)', name)
  }

  /** 停止所有已管理的网关（并行执行） */
  async stopAll(): Promise<void> {
    const entries = Array.from(this.gateways.keys())
    await Promise.allSettled(entries.map(name => this.stop(name)))
  }

  // ============================
  // 批量操作（启动时调用）
  // ============================

  /** 扫描所有 profile，检测网关运行状态并注册 */
  async detectAllOnStartup(): Promise<void> {
    logger.info('Scanning profiles for running gateways...')
    const profiles = await this.listProfiles()

    for (const name of profiles) {
      const status = await this.detectStatus(name)
      if (status.running) {
        logger.info('%s: running (PID: %s, port: %d)', name, status.pid, status.port)
      } else {
        logger.debug('%s: stopped', name)
      }
    }
  }

  /**
   * 启动所有未运行的网关
   *
   * 两阶段执行：
   *   Phase 1 — 顺序处理：检查状态、清理旧进程、分配端口
   *   Phase 2 — 并行启动网关进程
   */
  async startAll(): Promise<void> {
    const profiles = await this.listProfiles()

    // Phase 1: 顺序处理
    const toStart: string[] = []
    for (const name of profiles) {
      const existing = this.gateways.get(name)
      if (existing && this.isProcessAlive(existing.pid)) {
        logger.info('%s: already running (PID: %d)', name, existing.pid)
        continue
      }

      // 有 PID 文件但进程未在正确端口运行 → 旧进程，先停掉
      const pid = this.readPidFile(name)
      if (pid && this.isProcessAlive(pid)) {
        logger.info('%s: stale process (PID: %d), stopping', name, pid)
        try { await this.stop(name) } catch { }
      }

      await this.resolvePort(name)

      // Skip remote profiles — local hermes command cannot start remote gateways
      const { host } = this.readProfilePort(name)
      if (host && host !== '127.0.0.1' && host !== 'localhost') {
        logger.info('%s: remote profile (host=%s), skipping auto-start', name, host)
        continue
      }

      toStart.push(name)
    }

    // Phase 2: 并行启动
    const tasks = toStart.map(async (name) => {
      try {
        await this.start(name)
      } catch (err: any) {
        logger.error(err, '%s: failed to start', name)
      }
    })

    await Promise.allSettled(tasks)
  }
}
