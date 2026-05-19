/**
 * GatewayManager — 多 Profile 网关生命周期管理
 *
 * 核心职责：
 *   1. 启动时检测所有 profile 的网关运行状态（PID、端口、健康检查）
 *   2. 自动发现端口冲突并重新分配
 *   3. 启动/停止网关进程
 *
 * 启动检测流程（detectStatus）：
 *   ① 读取 gateway.pid，缺失时回退读取 gateway_state.json → 获取 PID
 *   ② 读取 config.yaml (platforms.api_server.extra.port/host) → 获取配置端口
 *   ③ PID 存活且配置端口 health check 通过？
 *      - 是 → 配置与运行状态匹配，注册网关
 *      - 否 → 标记为 stopped
 *
 * detectStatus 只做只读检测：不会认领未知端口上的进程，也不会探测实际监听端口后回写
 * config.yaml。端口修正发生在启动前的 resolvePort 阶段。
 *
 * 端口分配流程（resolvePort，启动前调用）：
 *   ① 读取配置端口
 *   ② 如果内存记录或 PID 文件对应的配置端口仍健康运行，复用该端口
 *   ③ 收集本轮已分配端口、其他已管理网关端口、Web UI 端口
 *   ④ 从 8642 起递增查找空闲端口，并写入 config.yaml
 *
 * 启动模式：
 *   - 所有平台统一使用 `hermes gateway run --replace`
 *   - 停止时先尝试 `hermes gateway stop`，再根据 PID / 监听端口清理进程
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { readFileSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createServer } from 'net'
import yaml from 'js-yaml'
import { logger } from '../logger'
import { detectHermesHome, getHermesBin } from './hermes-path'
import { safeFileStore } from '../safe-file-store'

const execFileAsync = promisify(execFile)

// ============================
// 常量 & 环境检测
// ============================

const HERMES_BASE = detectHermesHome()
const HERMES_BIN = getHermesBin()
const DEFAULT_WEB_UI_PORT = 8648

const GATEWAY_RUNTIME_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'SHELL',
  'LANG',
  'TZ',
  'TMP',
  'TEMP',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'HERMES_BIN',
  'HERMES_ALLOW_ROOT_GATEWAY',
  'SYSTEMROOT',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
])

function parseEnvKeys(raw: string): Set<string> {
  const keys = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (match) keys.add(match[1])
  }
  return keys
}

function readProfileEnvKeys(): Set<string> {
  const keys = new Set<string>()
  const envPaths = [join(HERMES_BASE, '.env')]
  const profilesDir = join(HERMES_BASE, 'profiles')

  if (existsSync(profilesDir)) {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) envPaths.push(join(profilesDir, entry.name, '.env'))
    }
  }

  for (const envPath of envPaths) {
    try {
      for (const key of parseEnvKeys(readFileSync(envPath, 'utf-8'))) keys.add(key)
    } catch {}
  }

  return keys
}

export function buildGatewayProcessEnv(profileName: string, hermesHome: string): NodeJS.ProcessEnv {
  const base = { ...process.env }

  if (profileName !== 'default') {
    for (const key of readProfileEnvKeys()) {
      if (!GATEWAY_RUNTIME_ENV_KEYS.has(key.toUpperCase())) delete base[key]
    }
  }

  return {
    ...base,
    HERMES_HOME: hermesHome,
  }
}

function getWebUiPort(): number | null {
  const port = parseInt(process.env.PORT || String(DEFAULT_WEB_UI_PORT), 10)
  return port > 0 && port <= 65535 ? port : null
}

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
  diagnostics?: GatewayDiagnostics
}

export interface GatewayDiagnostics {
  pid_path: string
  config_path: string
  pid_file_exists: boolean
  config_exists: boolean
  health_url: string
  health_checked_at: string
  health_ok?: boolean
  reason: string
}

interface ManagedGateway {
  pid: number
  port: number
  host: string
  url: string
  owned: boolean
  process?: ChildProcess
}

interface ResolvedGatewayEndpoint {
  port: number
  host: string
}

function formatHostForUrl(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host
  return host.includes(':') ? `[${host}]` : host
}

function buildHttpUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`
}

function isLocalHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'].includes(host)
}

function shouldDetachGatewayProcess(): boolean {
  // In dev mode (nodemon), always detach gateway processes so they survive restarts
  // Production mode: attach gateways so they can be managed together with the server
  const override = process.env.HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN?.trim().toLowerCase()
  const shouldDetach = override === '0' || override === 'false'

  if (shouldDetach) {
    console.log('[gateway] Detaching gateway process (dev mode: HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=' + override + ')')
  } else {
    console.log('[gateway] Attaching gateway process (prod mode: HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=' + (override || 'not set') + ')')
  }

  return shouldDetach
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
    const defaultHost = process.env.GATEWAY_HOST || '127.0.0.1'

    if (!existsSync(configPath)) return { port: 8642, host: defaultHost }

    try {
      const content = readFileSync(configPath, 'utf-8')
      const cfg = yaml.load(content, { json: true }) as any || {}

      const extra = cfg?.platforms?.api_server?.extra
      const rawPort = extra?.port || 8642
      const port = typeof rawPort === 'number' ? rawPort : parseInt(rawPort, 10) || 8642
      const host = extra?.host || defaultHost
      // 端口超出合法范围时回退到默认值
      return { port: port > 0 && port <= 65535 ? port : 8642, host }
    } catch {
      return { port: 8642, host: defaultHost }
    }
  }

  /** Read a profile gateway PID, falling back to runtime state when gateway.pid is missing. */
  private readPidFile(name: string): number | null {
    const profilePath = this.profileDir(name)
    const pidPath = join(profilePath, 'gateway.pid')

    try {
      if (existsSync(pidPath)) {
        const content = readFileSync(pidPath, 'utf-8').trim()
        const data = JSON.parse(content)
        return typeof data.pid === 'number' ? data.pid : parseInt(data.pid, 10) || null
      }
    } catch {}

    const statePath = join(profilePath, 'gateway_state.json')
    if (!existsSync(statePath)) return null

    try {
      const content = readFileSync(statePath, 'utf-8').trim()
      const data = JSON.parse(content)
      const pid = typeof data.pid === 'number' ? data.pid : parseInt(data.pid, 10) || null
      const state = data?.gateway_state
      return pid && Number.isFinite(pid) && pid > 0 && (state === 'running' || state === 'starting') ? pid : null
    } catch {
      return null
    }
  }

  // ============================
  // 进程 & 端口检测工具
  // ============================

  /** Check process liveness without sending a terminating signal. */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (err: any) {
      return err?.code === 'EPERM'
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
  /** 清理过期的 PID 文件 */
  private clearPidFile(name: string): void {
    try {
      const pidPath = join(this.profileDir(name), 'gateway.pid')
      if (existsSync(pidPath)) {
        unlinkSync(pidPath)
        logger.debug('Cleared stale PID file for profile "%s"', name)
      }
    } catch (err) {
      logger.debug('Failed to clear PID file: %s', err)
    }
  }

  /** 从 base 端口开始递增查找空闲端口（上限 65535） */
  private findFreePort(base: number, host = '127.0.0.1', reservedPorts = new Set<number>()): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryPort = (port: number) => {
        if (port > 65535) {
          reject(new Error(`No free port found in range ${base}-65535`))
          return
        }
        if (reservedPorts.has(port)) {
          tryPort(port + 1)
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
  private async writeProfilePort(name: string, port: number, host: string): Promise<void> {
    const configPath = join(this.profileDir(name), 'config.yaml')
    try {
      await safeFileStore.updateYaml(configPath, (cfg) => {
        // 确保 platforms.api_server 结构存在（不会影响其他位置的 platforms）
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
        return cfg
      })
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
   *   1. 当前 profile 已经健康运行 → 直接使用运行端口
   *   2. 未运行 → 从 8642 开始找空闲端口
   *   3. 检查已管理 profile / 本轮已分配端口 / 系统 TCP 占用
   *   4. 先写入 config.yaml，再启动 gateway
   */
  private async resolvePort(name: string): Promise<{ port: number; host: string }> {
    const { port: configuredPort, host } = this.readProfilePort(name)
    const configuredUrl = buildHttpUrl(host, configuredPort)

    // 检查是否是当前 profile 自己的端口（内存中的记录）
    const existing = this.gateways.get(name)
    if (existing && existing.host === host && this.isProcessAlive(existing.pid) && await this.checkHealth(existing.url, 1000)) {
      // 如果内存中有记录且进程存活，直接使用内存中的端口
      logger.info('Profile "%s" already running on port %d (in-memory record)', name, existing.port)
      this.allocatedPorts.add(existing.port)
      return { port: existing.port, host }
    }

    // 检查 PID 文件指向的当前 profile 是否仍健康运行
    const pid = this.readPidFile(name)
    if (pid && this.isProcessAlive(pid) && await this.checkHealth(configuredUrl, 1000)) {
      logger.info('Profile "%s" already running on configured port %d (PID: %d)', name, configuredPort, pid)
      this.gateways.set(name, { pid, port: configuredPort, host, url: configuredUrl, owned: false })
      this.allocatedPorts.add(configuredPort)
      return { port: configuredPort, host }
    }

    // 如果没有 PID 文件也没有内存记录，不认领端口上的未知网关
    // 如果端口被占用，findFreePort 会分配新端口

    // 收集已占用端口：本次启动已分配的端口 + 其他 profile 的网关端口
    const usedPorts = new Set<number>(this.allocatedPorts)
    for (const [profileName, gw] of Array.from(this.gateways.entries())) {
      // 跳过当前 profile 自己的端口
      if (profileName === name) continue
      if (gw.host === host && this.isProcessAlive(gw.pid)) {
        usedPorts.add(gw.port)
      }
    }
    const webUiPort = getWebUiPort()
    if (webUiPort !== null) usedPorts.add(webUiPort)

    const port = await this.findFreePort(8642, host, usedPorts)
    if (configuredPort !== port) {
      logger.info('Assigning port for profile "%s": %d → %d', name, configuredPort, port)
    } else {
      logger.debug('Assigning port %d for profile "%s"', port, name)
    }
    await this.writeProfilePort(name, port, host)

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
    return buildHttpUrl(host, port)
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
    const url = buildHttpUrl(host, port)
    const pidPath = join(this.profileDir(name), 'gateway.pid')
    const configPath = join(this.profileDir(name), 'config.yaml')
    const diagnostics: GatewayDiagnostics = {
      pid_path: pidPath,
      config_path: configPath,
      pid_file_exists: existsSync(pidPath),
      config_exists: existsSync(configPath),
      health_url: `${url.replace(/\/$/, '')}/health`,
      health_checked_at: new Date().toISOString(),
      reason: 'stopped',
    }

    // 首先检查 PID 文件：如果存在且进程存活且健康，则标记为运行
    if (pid && this.isProcessAlive(pid) && await this.checkHealth(url)) {
      diagnostics.health_ok = true
      diagnostics.reason = 'pid alive and health check passed'
      this.gateways.set(name, { pid, port, host, url, owned: false })
      return { profile: name, port, host, url, running: true, pid, diagnostics }
    }

    if (pid) {
      diagnostics.health_ok = false
      diagnostics.reason = this.isProcessAlive(pid) ? 'pid alive but health check failed' : 'stale pid file'
    } else if (!diagnostics.pid_file_exists) {
      diagnostics.reason = 'missing pid file'
    }

    // 没有 PID 文件时不认领端口上的未知网关，避免误判其他 profile 的网关
    this.gateways.delete(name)
    return { profile: name, port, host, url, running: false, diagnostics }
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
    // 检查是否已在运行
    const existing = this.gateways.get(name)
    if (existing && this.isProcessAlive(existing.pid)) {
      if (await this.checkHealth(existing.url, 1000)) {
        logger.info('Gateway for profile "%s" already running (PID: %d, port: %d)', name, existing.pid, existing.port)
        return { profile: name, port: existing.port, host: existing.host, url: existing.url, running: true, pid: existing.pid }
      }

      logger.info('Gateway for profile "%s" is alive but unhealthy (PID: %d, port: %d), restarting',
        name, existing.pid, existing.port)
      try {
        await this.stop(name)
      } catch (err) {
        logger.debug('Failed to stop unhealthy gateway before restart: %s', err)
      }
    }

    const endpoint = await this.resolvePort(name)
    return this.startResolved(name, endpoint)
  }

  /** 使用已经解析好的端口启动网关，避免 startAll() 中重复分配端口 */
  private async startResolved(name: string, endpoint: ResolvedGatewayEndpoint): Promise<GatewayStatus> {
    const { port, host } = endpoint
    const hermesHome = this.profileDir(name)
    const url = buildHttpUrl(host, port)

    // Windows 特定：清理僵尸锁定文件
    if (process.platform === 'win32') {
      const lockPath = join(hermesHome, 'gateway.lock')
      if (existsSync(lockPath)) {
        try {
          const content = readFileSync(lockPath, 'utf-8').trim()
          const lockData = JSON.parse(content)
          const pid = lockData.pid

          if (pid && !this.isProcessAlive(pid)) {
            logger.warn('Found stale gateway lock file (PID: %d), attempting cleanup', pid)
            try {
              // 使用 Node.js 内置方法删除文件，避免 PowerShell 弹窗
              unlinkSync(lockPath)
              logger.info('Successfully removed stale lock file')
            } catch (err) {
              logger.debug('Failed to remove lock file: %s', err)
            }
          }
        } catch (err) {
          logger.debug('Failed to check lock file: %s', err)
        }
      }
    }

    // 所有平台统一使用 run 模式；dev/nodemon 可通过 env 保留 gateway 进程。
    return new Promise((resolve, reject) => {
      const env = buildGatewayProcessEnv(name, hermesHome)
      const detachGateway = shouldDetachGatewayProcess()
      const child = spawn(HERMES_BIN, ['gateway', 'run', '--replace'], {
        stdio: 'ignore',
        detached: detachGateway,
        windowsHide: true,
        env,
      })
      if (detachGateway) {
        child.unref()
      }

      const pid = child.pid ?? 0
      logger.info('Starting gateway for profile "%s" (run mode, PID: %d, port: %d, detached: %s)', name, pid, port, detachGateway)

      // 保存子进程引用，用于后续管理
      this.gateways.set(name, { pid, port, host, url, owned: true, process: child })

      this.waitForReady(name, pid, port, host, url)
        .then(resolve)
        .catch(reject)
    })
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
        const previous = this.gateways.get(name)
        this.gateways.set(name, {
          pid: actualPid,
          port,
          host,
          url,
          owned: previous?.owned ?? true,
          process: previous?.process,
        })
        return { profile: name, port, host, url, running: true, pid: actualPid || undefined }
      }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error(`Gateway health check timed out after 15000ms`)
  }

  private async getListeningPids(port: number): Promise<number[]> {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
          timeout: 5000,
          windowsHide: true,
        })
        const pids = new Set<number>()
        for (const line of stdout.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue
          const localAddress = parts[1]
          const state = parts[3]?.toUpperCase()
          const pid = parseInt(parts[4], 10)
          if (state === 'LISTENING' && localAddress.endsWith(`:${port}`) && Number.isFinite(pid)) {
            pids.add(pid)
          }
        }
        return Array.from(pids)
      }

      const { stdout } = await execFileAsync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
        timeout: 5000,
      })
      return stdout
        .split(/\r?\n/)
        .map(line => parseInt(line.trim(), 10))
        .filter(pid => Number.isFinite(pid))
    } catch {
      return []
    }
  }

  private async killPid(pid: number, force = false): Promise<void> {
    if (!pid) return

    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 5000,
          windowsHide: true,
        })
      } catch {
        try { process.kill(pid) } catch { }
      }
      return
    }

    const signal = force ? 'SIGKILL' : 'SIGTERM'
    try {
      process.kill(-pid, signal)
    } catch {
      try { process.kill(pid, signal) } catch { }
    }
  }

  private async stopViaHermesCli(name: string): Promise<void> {
    const hermesHome = this.profileDir(name)
    try {
      const { stdout, stderr } = await execFileAsync(HERMES_BIN, ['gateway', 'stop'], {
        timeout: 15000,
        windowsHide: true,
        env: buildGatewayProcessEnv(name, hermesHome),
      })
      const output = `${stdout}${stderr}`.trim()
      if (output) logger.debug('%s: hermes gateway stop: %s', name, output)
    } catch (err) {
      logger.debug('Failed to stop gateway via Hermes CLI for profile "%s": %s', name, err)
    }
  }

  /**
   * 停止单个 profile 的网关
   * 所有平台使用 run 模式，直接 kill 进程
   * 返回前等待 health check 确认网关已真正停止
   */
  async stop(name: string, timeoutMs = 10000): Promise<void> {
    // 记录当前 URL，用于确认停止
    const gw = this.gateways.get(name)
    const configured = this.readProfilePort(name)
    const port = gw?.port ?? configured.port
    const host = gw?.host ?? configured.host
    const url = gw?.url || buildHttpUrl(host, port)

    // 所有平台使用 run 模式，直接杀进程
    const pids = new Set<number>()
    if (gw?.process?.pid) pids.add(gw.process.pid)
    if (gw?.pid) pids.add(gw.pid)
    const pidFilePid = this.readPidFile(name)
    if (pidFilePid) pids.add(pidFilePid)
    if (isLocalHost(host)) {
      for (const pid of await this.getListeningPids(port)) {
        pids.add(pid)
      }
    }

    if (pids.size === 0) {
      if (!(await this.checkHealth(url, 1000))) {
        this.gateways.delete(name)
        this.allocatedPorts.delete(port)
        this.clearPidFile(name)
        logger.info('Stopped gateway for profile "%s" (already stopped)', name)
        return
      }
      await this.stopViaHermesCli(name)
      if (!(await this.checkHealth(url, 1000))) {
        this.gateways.delete(name)
        this.allocatedPorts.delete(port)
        this.clearPidFile(name)
        logger.info('Stopped gateway for profile "%s"', name)
        return
      }
      throw new Error(`Cannot stop gateway for profile "${name}": no PID available`)
    }

    await this.stopViaHermesCli(name)

    if (!(await this.checkHealth(url, 1000))) {
      this.gateways.delete(name)
      this.allocatedPorts.delete(port)
      this.clearPidFile(name)
      logger.info('Stopped gateway for profile "%s"', name)
      return
    }

    if (gw?.process && !gw.process.killed) {
      try { gw.process.kill(process.platform === 'win32' ? undefined : 'SIGTERM') } catch { }
    }

    for (const pid of pids) {
      await this.killPid(pid)
    }

    // 等待 health check 失败，确认网关已真正停止
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await this.checkHealth(url, 1000))) {
        this.gateways.delete(name)
        this.allocatedPorts.delete(port)
        this.clearPidFile(name)
        logger.info('Stopped gateway for profile "%s"', name)
        return
      }
      await new Promise(r => setTimeout(r, 300))
    }

    if (isLocalHost(host)) {
      const listeningPids = await this.getListeningPids(port)
      if (listeningPids.length) {
        logger.warn(
          'Gateway for profile "%s" still listening on port %d, force killing PIDs: %s',
          name,
          port,
          listeningPids.join(', '),
        )
        for (const pid of listeningPids) {
          await this.killPid(pid, true)
        }

        const forceDeadline = Date.now() + 3000
        while (Date.now() < forceDeadline) {
          if (!(await this.checkHealth(url, 500))) {
            this.gateways.delete(name)
            this.allocatedPorts.delete(port)
            this.clearPidFile(name)
            logger.info('Stopped gateway for profile "%s" (force killed)', name)
            return
          }
          await new Promise(r => setTimeout(r, 200))
        }
      }
    }

    logger.warn('Failed to stop gateway for profile "%s" within %dms', name, timeoutMs)
    throw new Error(`Gateway stop timed out after ${timeoutMs}ms`)
  }

  /** 停止所有已管理的网关（并行执行） */
  async stopAll(): Promise<void> {
    const entries = Array.from(this.gateways.entries())
      .filter(([, gw]) => gw.owned)
      .map(([name]) => name)
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
    // 确保使用 default profile 启动网关
    const currentProfile = this.getActiveProfile()
    if (currentProfile !== 'default') {
      logger.info('Current profile is "%s", switching to "default" for gateway startup', currentProfile)
      try {
        await execFileAsync(HERMES_BIN, ['profile', 'use', 'default'], {
          timeout: 10000,
          windowsHide: true,
        })
        this.setActiveProfile('default')
        logger.info('Waiting for profile switch to take effect...')
        // 等待一下让 profile 切换完全生效，确保配置文件更新完成
        await new Promise(resolve => setTimeout(resolve, 2000))
        logger.info('Successfully switched to default profile')
      } catch (err) {
        logger.error(err, 'Failed to switch to default profile, continuing with current profile')
      }
    }

    // 清空已分配端口集合，确保每次启动都从干净状态开始
    this.allocatedPorts.clear()

    const profiles = await this.listProfiles()
    // Phase 1: 顺序处理
    const toStart: Array<{ name: string; endpoint: ResolvedGatewayEndpoint }> = []
    for (const name of profiles) {
      const existing = this.gateways.get(name)
      if (existing && this.isProcessAlive(existing.pid)) {
        if (await this.checkHealth(existing.url, 1000)) {
          logger.info('%s: already running (PID: %d, port: %d)', name, existing.pid, existing.port)
          continue
        }

        logger.info('%s: process alive but unhealthy (PID: %d, port: %d), restarting',
          name, existing.pid, existing.port)
        try {
          await this.stop(name)
        } catch (err) {
          logger.debug('Failed to stop unhealthy gateway: %s', err)
        }
      }

      // Skip remote profiles — local hermes command cannot start remote gateways
      const { host } = this.readProfilePort(name)
      if (host && host !== '127.0.0.1' && host !== 'localhost') {
        logger.info('%s: remote profile (host=%s), skipping auto-start', name, host)
        continue
      }

      // 有 PID 文件但进程未在正确端口运行 → 通过 health check 检查网关状态
      const pid = this.readPidFile(name)
      if (pid && this.isProcessAlive(pid)) {
        const { port: configuredPort, host } = this.readProfilePort(name)
        const configuredUrl = buildHttpUrl(host, configuredPort)

        // 检查配置文件中的端口是否有正常的网关在运行
        if (await this.checkHealth(configuredUrl, 2000)) {
          // Health check 通过，说明网关正常工作
          logger.info('%s: gateway already running on configured port %d (PID: %d, health check passed)',
            name, configuredPort, pid)
          // 注册到内存中
          this.gateways.set(name, { pid, port: configuredPort, host, url: configuredUrl, owned: false })
          continue
        } else {
          // Health check 失败，说明网关有问题（僵尸进程或端口冲突）
          logger.info('%s: stale process (PID: %d) health check failed on port %d, stopping and restarting',
            name, pid, configuredPort)
          try {
            await this.stop(name)
          } catch (err) {
            logger.debug('Failed to stop stale gateway: %s', err)
          }
          // 清理过期的 PID 文件
          this.clearPidFile(name)
        }
      }

      // 只为真正需要启动的网关分配端口
      const endpoint = await this.resolvePort(name)
      toStart.push({ name, endpoint })
    }

    // Phase 2: 并行启动
    // 串行启动网关，避免并发时的lock file竞争条件
    for (const { name, endpoint } of toStart) {
      try {
        await this.startResolved(name, endpoint)
      } catch (err: any) {
        logger.error(err, '%s: failed to start', name)
      }
    }
  }
}
