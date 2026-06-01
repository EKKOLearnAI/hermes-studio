import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { detectHermesRootHome } from '../../services/hermes/hermes-path'
import { getActiveProfileDir, getActiveProfileName } from '../../services/hermes/hermes-profile'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { resolveHermesLlmRuntime } from '../../services/hermes/dynamic-llm'

const execFileAsync = promisify(execFile)

type ComponentStatus = 'ok' | 'warn' | 'error' | 'unknown'
type SystemAction =
  | 'restart-gateway'
  | 'restart-mirofish'
  | 'open-mirofish'
  | 'open-obsidian'
  | 'open-knowledge-vault'
  | 'open-latest-report'

interface StatusItem {
  key: string
  label: string
  status: ComponentStatus
  summary: string
  detail?: string
  url?: string
  path?: string
  pid?: number
  updated_at: string
  metadata?: Record<string, unknown>
}

function nowIso() {
  return new Date().toISOString()
}

function redactRuntimeBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return baseUrl.replace(/\/\/[^/@]+@/, '//***@')
  }
}

async function checkHttp(url: string, okText?: string): Promise<{ ok: boolean; status?: number; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    const text = await res.text().catch(() => '')
    const ok = res.ok && (!okText || text.includes(okText))
    return {
      ok,
      status: res.status,
      detail: text.slice(0, 300),
    }
  } catch (err: any) {
    return { ok: false, detail: err?.message || String(err) }
  }
}

async function execShort(command: string, args: string[], timeout = 2500): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, { timeout })
    return {
      ok: true,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    }
  } catch (err: any) {
    return {
      ok: false,
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || err?.message || ''),
    }
  }
}

async function runCommand(command: string, args: string[], timeout = 10_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, { timeout })
  return `${stdout || ''}${stderr || ''}`.trim()
}

async function hermesGatewayStatus(): Promise<StatusItem> {
  const updated_at = nowIso()
  try {
    const mgr = getGatewayManagerInstance()
    const upstream = mgr?.getUpstream()
    if (!mgr || !upstream) {
      return {
        key: 'hermes-gateway',
        label: 'Hermes Gateway',
        status: 'error',
        summary: 'Gateway manager not initialized',
        updated_at,
      }
    }
    const health = await checkHttp(`${upstream.replace(/\/$/, '')}/health`, 'hermes-agent')
    const diagnostics = await mgr.detectStatus(getActiveProfileName()).catch(() => null)
    return {
      key: 'hermes-gateway',
      label: 'Hermes Gateway',
      status: health.ok ? 'ok' : 'error',
      summary: health.ok ? 'API server is responding' : 'API server is not responding',
      detail: health.ok ? diagnostics?.diagnostics?.reason || 'health ok' : health.detail,
      url: upstream,
      pid: diagnostics?.pid,
      updated_at,
      metadata: {
        profile: getActiveProfileName(),
        running: diagnostics?.running,
        port: diagnostics?.port,
      },
    }
  } catch (err: any) {
    return {
      key: 'hermes-gateway',
      label: 'Hermes Gateway',
      status: 'error',
      summary: 'Gateway check failed',
      detail: err?.message || String(err),
      updated_at,
    }
  }
}

async function mirofishStatus(): Promise<StatusItem[]> {
  const updated_at = nowIso()
  const backend = await checkHttp('http://127.0.0.1:5001/health', 'MiroFish Backend')
  const frontend = await checkHttp('http://127.0.0.1:3000', 'MiroFish')
  const launchLabel = 'ai.hermes.mirofish-kk'
  const launch = process.platform === 'darwin' && typeof process.getuid === 'function'
    ? await execShort('/bin/launchctl', ['print', `gui/${process.getuid()}/${launchLabel}`])
    : { ok: false, stdout: '', stderr: 'launchctl unavailable' }
  const launchPid = launch.stdout.match(/\bpid = (\d+)/)?.[1]
  const launchRunning = launch.ok && launch.stdout.includes('state = running')

  return [
    {
      key: 'mirofish-backend',
      label: 'MiroFish Backend',
      status: backend.ok ? 'ok' : 'error',
      summary: backend.ok ? 'Simulation backend is online' : 'Simulation backend is offline',
      detail: backend.ok ? 'health ok' : backend.detail,
      url: 'http://127.0.0.1:5001',
      updated_at,
    },
    {
      key: 'mirofish-frontend',
      label: 'MiroFish UI',
      status: frontend.ok ? 'ok' : 'warn',
      summary: frontend.ok ? 'Frontend is reachable' : 'Frontend is not reachable',
      detail: frontend.ok ? 'vite page returned html' : frontend.detail,
      url: 'http://localhost:3000',
      updated_at,
    },
    {
      key: 'mirofish-launchd',
      label: 'MiroFish LaunchAgent',
      status: launchRunning ? 'ok' : backend.ok ? 'warn' : 'error',
      summary: launchRunning ? 'launchd keeps MiroFish running' : 'launchd service is not running',
      detail: launchRunning ? launchLabel : (launch.stderr || 'not loaded'),
      pid: launchPid ? Number(launchPid) : undefined,
      path: '/Users/kk/Library/LaunchAgents/ai.hermes.mirofish-kk.plist',
      updated_at,
    },
  ]
}

function obsidianStatus(): StatusItem[] {
  const updated_at = nowIso()
  const appPath = '/Applications/Obsidian.app'
  const vaultPath = '/Users/kk/Documents/KK-Obsidian'
  const knowledgePath = join(vaultPath, 'Hermes-Knowledge')
  const appExists = existsSync(appPath)
  const vaultExists = existsSync(vaultPath)
  const knowledgeExists = existsSync(knowledgePath)
  return [
    {
      key: 'obsidian-app',
      label: 'Obsidian App',
      status: appExists ? 'ok' : 'warn',
      summary: appExists ? 'Installed' : 'Not installed',
      path: appPath,
      updated_at,
    },
    {
      key: 'obsidian-vault',
      label: 'Obsidian Vault',
      status: vaultExists && knowledgeExists ? 'ok' : vaultExists ? 'warn' : 'error',
      summary: knowledgeExists ? 'Hermes Knowledge vault is available' : vaultExists ? 'Vault exists, Hermes-Knowledge missing' : 'Vault missing',
      path: knowledgeExists ? knowledgePath : vaultPath,
      updated_at,
    },
  ]
}

function cronStatus(): StatusItem {
  const updated_at = nowIso()
  const { path: cronPath, jobs } = readCronJobs()
  if (!existsSync(cronPath)) {
    return {
      key: 'hermes-cron',
      label: 'Hermes Cron',
      status: 'warn',
      summary: 'No cron jobs file found',
      path: cronPath,
      updated_at,
    }
  }

  try {
    const active = jobs.filter((job) => job?.enabled !== false)
    const yahoo = active.filter((job) => String(job?.name || '').includes('HERMES.YAHOO'))
    const yahooBriefs = yahoo.filter((job) => String(job?.script || '').includes('hermes_yahoo_'))
    const quantLab = active.filter((job) => String(job?.name || '').includes('HERMES Quant Lab'))
    const yahooReady = yahooBriefs.length >= 2 && yahooBriefs.every((job) => job?.no_agent === true && job?.deliver === 'telegram' && !job?.last_delivery_error)
    const quantReady = quantLab.length >= 2 && quantLab.every((job) => job?.no_agent === true && job?.deliver === 'telegram' && !job?.last_delivery_error)
    const nextRuns = active
      .map((job) => job?.next_run_at ? `${job.name}: ${job.next_run_at}` : '')
      .filter(Boolean)
      .slice(0, 3)

    return {
      key: 'hermes-cron',
      label: 'Hermes Cron',
      status: yahoo.length >= 2 && yahooReady && quantReady ? 'ok' : active.length > 0 ? 'warn' : 'error',
      summary: `${active.length} active job(s), ${yahoo.length} HERMES.YAHOO, ${quantLab.length} Quant Lab`,
      detail: nextRuns.join('\n') || 'No next run scheduled',
      path: cronPath,
      updated_at,
      metadata: {
        active_jobs: active.length,
        yahoo_jobs: yahoo.length,
        yahoo_brief_jobs: yahooBriefs.length,
        yahoo_script_only: yahooReady,
        quant_lab_jobs: quantLab.length,
        quant_lab_ready: quantReady,
      },
    }
  } catch (err: any) {
    return {
      key: 'hermes-cron',
      label: 'Hermes Cron',
      status: 'error',
      summary: 'Failed to read cron jobs',
      detail: err?.message || String(err),
      path: cronPath,
      updated_at,
    }
  }
}

function latestYahooReport(): StatusItem {
  const updated_at = nowIso()
  const runsDir = '/Users/kk/Documents/Codex/Hermes-Quant-Workspace/hermes-knowledge/raw/mirofish/runs'
  if (!existsSync(runsDir)) {
    return {
      key: 'latest-yahoo-mirofish',
      label: 'Latest Yahoo MiroFish Report',
      status: 'warn',
      summary: 'Runs directory missing',
      path: runsDir,
      updated_at,
    }
  }

  const reports = readdirSync(runsDir)
    .filter((name) => name.includes('hermes-yahoo') && name.endsWith('.md'))
    .map((name) => {
      const path = join(runsDir, name)
      const stat = statSync(path)
      return { name, path, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  const latest = reports[0]
  if (!latest) {
    return {
      key: 'latest-yahoo-mirofish',
      label: 'Latest Yahoo MiroFish Report',
      status: 'warn',
      summary: 'No HERMES.YAHOO MiroFish report found',
      path: runsDir,
      updated_at,
    }
  }

  let graphId = ''
  try {
    graphId = readFileSync(latest.path, 'utf-8').match(/Graph ID:\s*`([^`]+)`/)?.[1] || ''
  } catch { }

  return {
    key: 'latest-yahoo-mirofish',
    label: 'Latest Yahoo MiroFish Report',
    status: 'ok',
    summary: graphId ? `Latest graph ${graphId}` : latest.name,
    detail: latest.mtime,
    path: latest.path,
    updated_at,
  }
}

function telegramStatus(): StatusItem {
  const updated_at = nowIso()
  const logPath = join(getActiveProfileDir(), 'logs', 'agent.log')
  if (!existsSync(logPath)) {
    return {
      key: 'telegram',
      label: 'Telegram',
      status: 'unknown',
      summary: 'Agent log not found',
      path: logPath,
      updated_at,
    }
  }

  try {
    const stat = statSync(logPath)
    const size = Math.min(stat.size, 200_000)
    const fd = readFileSync(logPath)
    const tail = fd.subarray(Math.max(0, fd.length - size)).toString('utf-8')
    const lines = tail.split(/\r?\n/).filter((line) => line.includes('Telegram') || line.includes('telegram:'))
    const last = lines.at(-1) || ''
    const conflict = lines.slice(-20).some((line) => line.includes('polling conflict'))
    const delivered = lines.slice(-20).some((line) => line.includes('delivered to telegram'))
    const connected = lines.slice(-20).some((line) => line.includes('Connected to Telegram') || line.includes('polling resumed'))
    return {
      key: 'telegram',
      label: 'Telegram',
      status: conflict ? 'warn' : delivered || connected ? 'ok' : 'unknown',
      summary: conflict ? 'Recent polling conflict detected' : delivered ? 'Recent delivery succeeded' : connected ? 'Connected' : 'No recent Telegram event',
      detail: last,
      path: logPath,
      updated_at,
    }
  } catch (err: any) {
    return {
      key: 'telegram',
      label: 'Telegram',
      status: 'unknown',
      summary: 'Failed to read Telegram log',
      detail: err?.message || String(err),
      path: logPath,
      updated_at,
    }
  }
}

function readCronJobs(): { path: string; jobs: any[] } {
  const cronPath = join(getActiveProfileDir(), 'cron', 'jobs.json')
  if (!existsSync(cronPath)) return { path: cronPath, jobs: [] }

  const data = JSON.parse(readFileSync(cronPath, 'utf-8'))
  if (Array.isArray(data)) return { path: cronPath, jobs: data }
  if (Array.isArray(data?.jobs)) return { path: cronPath, jobs: data.jobs }
  return { path: cronPath, jobs: Object.values(data || {}).filter((item: any) => item && typeof item === 'object') }
}

function formatJobLine(job: any): string {
  const schedule = job?.schedule_display || job?.schedule?.display || job?.schedule?.expr || 'n/a'
  const last = job?.last_run_at ? `${job.last_run_at} ${job.last_status || 'unknown'}` : 'not run yet'
  const next = job?.next_run_at || 'n/a'
  return `${job?.name || job?.id || 'job'} | ${schedule} | last: ${last} | next: ${next}`
}

async function webUiSupervisorStatus(): Promise<StatusItem> {
  const updated_at = nowIso()
  const launchLabel = 'ai.hermes.web-ui-kk'
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    return {
      key: 'hermes-webui-supervisor',
      label: 'Hermes APP Supervisor',
      status: 'unknown',
      summary: 'launchd check is only available on macOS',
      updated_at,
    }
  }

  const launch = await execShort('/bin/launchctl', ['print', `gui/${process.getuid()}/${launchLabel}`])
  const running = launch.ok && launch.stdout.includes('state = running')
  const pid = launch.stdout.match(/\bpid = (\d+)/)?.[1]

  return {
    key: 'hermes-webui-supervisor',
    label: 'Hermes APP Supervisor',
    status: running ? 'ok' : 'error',
    summary: running ? 'APP LaunchAgent is running' : 'APP LaunchAgent is not running',
    detail: running
      ? 'Web UI owns the local Gateway process and its cron ticker for this APP session.'
      : (launch.stderr || 'launchd service not loaded'),
    pid: pid ? Number(pid) : undefined,
    path: '/Users/kk/Library/LaunchAgents/ai.hermes.web-ui-kk.plist',
    updated_at,
  }
}

async function llmRuntimeStatus(): Promise<StatusItem> {
  const updated_at = nowIso()
  try {
    const runtime = await resolveHermesLlmRuntime()
    return {
      key: 'hermes-llm-runtime',
      label: 'Hermes LLM Runtime',
      status: runtime.model ? 'ok' : 'warn',
      summary: `${runtime.mode} / ${runtime.model || 'model not configured'}`,
      detail: runtime.isOllama
        ? `Ollama/local runtime detected; timeout ${runtime.timeoutMs}ms`
        : `Provider ${runtime.provider || 'n/a'}; timeout ${runtime.timeoutMs}ms`,
      url: redactRuntimeBaseUrl(runtime.baseUrl),
      updated_at,
      metadata: {
        mode: runtime.mode,
        provider: runtime.provider,
        model: runtime.model,
        endpoint_kind: runtime.endpointKind,
        timeout_ms: runtime.timeoutMs,
        is_ollama: runtime.isOllama,
        api_key_configured: Boolean(runtime.apiKey),
      },
    }
  } catch (err: any) {
    return {
      key: 'hermes-llm-runtime',
      label: 'Hermes LLM Runtime',
      status: 'error',
      summary: 'Failed to resolve active LLM runtime',
      detail: err?.message || String(err),
      updated_at,
    }
  }
}

function quantLabScheduleStatus(): StatusItem {
  const updated_at = nowIso()
  const { path: cronPath, jobs } = readCronJobs()
  const quantJobs = jobs.filter((job: any) => String(job?.name || '').includes('HERMES Quant Lab'))
  const premarket = quantJobs.find((job: any) => String(job?.script || '').includes('premarket'))
  const afterclose = quantJobs.find((job: any) => String(job?.script || '').includes('afterclose'))
  const scriptsReady = [premarket, afterclose].every((job: any) => {
    if (!job?.script || job?.no_agent !== true || job?.deliver !== 'telegram' || job?.enabled === false) return false
    return existsSync(join(getActiveProfileDir(), 'scripts', job.script))
  })
  const lastRunsOk = [premarket, afterclose].every((job: any) => !job?.last_run_at || job?.last_status === 'ok')
  const deliveryOk = [premarket, afterclose].every((job: any) => !job?.last_delivery_error)
  const ready = Boolean(premarket && afterclose && scriptsReady && lastRunsOk && deliveryOk)

  return {
    key: 'quant-lab-schedule',
    label: 'Quant Lab 排程',
    status: ready ? 'ok' : quantJobs.length ? 'warn' : 'error',
    summary: ready
      ? '開盤前與收盤後簡報已排程並通過最近一次 delivery'
      : `${quantJobs.length} Quant Lab job(s) configured`,
    detail: quantJobs.map(formatJobLine).join('\n') || 'Quant Lab cron jobs missing',
    path: cronPath,
    updated_at,
    metadata: {
      quant_jobs: quantJobs.length,
      scripts_ready: scriptsReady,
      last_runs_ok: lastRunsOk,
      delivery_ok: deliveryOk,
    },
  }
}

export async function getSystemStatus(ctx: any) {
  const [gateway, supervisor, llmRuntime, mirofish] = await Promise.all([
    hermesGatewayStatus(),
    webUiSupervisorStatus(),
    llmRuntimeStatus(),
    mirofishStatus(),
  ])
  const components = [
    supervisor,
    gateway,
    llmRuntime,
    ...mirofish,
    ...obsidianStatus(),
    cronStatus(),
    quantLabScheduleStatus(),
    latestYahooReport(),
    telegramStatus(),
  ]
  const hasError = components.some((item) => item.status === 'error')
  const hasWarn = components.some((item) => item.status === 'warn' || item.status === 'unknown')
  ctx.body = {
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    checked_at: nowIso(),
    profile: getActiveProfileName(),
    hermes_home: detectHermesRootHome(),
    components,
  }
}

export async function getLlmRuntimeStatus(ctx: any) {
  const item = await llmRuntimeStatus()
  ctx.status = item.status === 'error' ? 500 : 200
  ctx.body = {
    status: item.status,
    checked_at: item.updated_at,
    runtime: {
      mode: item.metadata?.mode,
      provider: item.metadata?.provider,
      model: item.metadata?.model,
      endpoint_kind: item.metadata?.endpoint_kind,
      timeout_ms: item.metadata?.timeout_ms,
      is_ollama: item.metadata?.is_ollama,
      api_key_configured: item.metadata?.api_key_configured,
      base_url: item.url,
    },
    detail: item.detail,
  }
}

export async function runSystemStatusAction(ctx: any) {
  const action = String(ctx.request.body?.action || '') as SystemAction
  const profile = getActiveProfileName()
  const knowledgePath = '/Users/kk/Documents/Codex/Hermes-Quant-Workspace/hermes-knowledge'
  const obsidianVaultPath = '/Users/kk/Documents/KK-Obsidian'
  const obsidianAppPath = '/Applications/Obsidian.app'
  const launchLabel = 'ai.hermes.mirofish-kk'

  try {
    if (action === 'restart-gateway') {
      const mgr = getGatewayManagerInstance()
      if (!mgr) ctx.throw(503, 'Gateway manager not initialized')
      await mgr.stop(profile).catch(() => undefined)
      await mgr.start(profile)
      ctx.body = { ok: true, action, message: 'Hermes Gateway restarted' }
      return
    }

    if (action === 'restart-mirofish') {
      const getuid = process.getuid
      if (process.platform !== 'darwin' || typeof getuid !== 'function') {
        throw Object.assign(new Error('MiroFish launchd restart is only available on macOS'), { status: 400 })
      }
      await runCommand('/bin/launchctl', ['kickstart', '-k', `gui/${getuid()}/${launchLabel}`], 15_000)
      ctx.body = { ok: true, action, message: 'MiroFish LaunchAgent restarted' }
      return
    }

    if (action === 'open-mirofish') {
      await runCommand('/usr/bin/open', ['http://localhost:3000'])
      ctx.body = { ok: true, action, message: 'MiroFish UI opened' }
      return
    }

    if (action === 'open-obsidian') {
      if (existsSync(obsidianAppPath)) {
        await runCommand('/usr/bin/open', ['-a', 'Obsidian', obsidianVaultPath])
      } else {
        await runCommand('/usr/bin/open', [obsidianVaultPath])
      }
      ctx.body = { ok: true, action, message: 'Obsidian vault opened' }
      return
    }

    if (action === 'open-knowledge-vault') {
      await runCommand('/usr/bin/open', [knowledgePath])
      ctx.body = { ok: true, action, message: 'Hermes Knowledge vault opened' }
      return
    }

    if (action === 'open-latest-report') {
      const latest = latestYahooReport()
      const reportPath = latest.path
      if (!reportPath || !existsSync(reportPath)) {
        throw Object.assign(new Error('Latest report not found'), { status: 404 })
      }
      await runCommand('/usr/bin/open', [reportPath])
      ctx.body = { ok: true, action, message: 'Latest report opened' }
      return
    }

    ctx.throw(400, 'Unknown system action')
  } catch (err: any) {
    ctx.status = err?.status || 500
    ctx.body = {
      ok: false,
      action,
      message: err?.message || String(err),
    }
  }
}
