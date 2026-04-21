import Router from '@koa/router'
import { spawn, execSync } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { config } from '../config'

export const tunnelRoutes = new Router()

let tunnelProcess: ReturnType<typeof spawn> | null = null
let tunnelUrl: string | null = null

/** Clean up tunnel process (called on server shutdown) */
export function cleanupTunnel(): void {
  if (tunnelProcess && !tunnelProcess.killed) {
    tunnelProcess.kill('SIGTERM')
    tunnelProcess = null
    tunnelUrl = null
    console.log('✓ Tunnel process cleaned up')
  }
}

function checkCloudflared(): { available: boolean; error?: string } {
  try {
    execSync('which cloudflared', { stdio: 'ignore' })
    return { available: true }
  } catch {
    return {
      available: false,
      error:
        'cloudflared not found. Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    }
  }
}

tunnelRoutes.get('/api/hermes/tunnel/status', async (ctx) => {
  const check = checkCloudflared()
  ctx.body = {
    running: tunnelProcess !== null && !tunnelProcess.killed,
    url: tunnelUrl,
    cloudflaredInstalled: check.available,
    error: check.error,
  }
})

tunnelRoutes.post('/api/hermes/tunnel/start', async (ctx) => {
  if (tunnelProcess && !tunnelProcess.killed) {
    ctx.body = { success: true, url: tunnelUrl, message: 'Tunnel already running' }
    return
  }

  const check = checkCloudflared()
  if (!check.available) {
    ctx.status = 400
    ctx.body = { success: false, error: check.error }
    return
  }

  const port = config.port
  let resolved = false

  return new Promise<void>((resolve) => {
    tunnelProcess = spawn(
      'cloudflared',
      ['tunnel', '--url', `http://localhost:${port}`, '--protocol', 'http2'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    let stdoutBuffer = ''
    let stderrBuffer = ''
    const MAX_BUF = 65536

    const checkUrl = () => {
      if (resolved) return
      const fullBuffer = stdoutBuffer + stderrBuffer
      const match = fullBuffer.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)
      if (match && !tunnelUrl) {
        tunnelUrl = match[0]
        console.log(`Tunnel ready: ${tunnelUrl}`)
        ctx.body = { success: true, url: tunnelUrl }
        resolved = true
        resolve()
      }
    }

    tunnelProcess.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString()
      if (stdoutBuffer.length > MAX_BUF) stdoutBuffer = stdoutBuffer.slice(-MAX_BUF)
      checkUrl()
    })

    tunnelProcess.stderr?.on('data', (data: Buffer) => {
      stderrBuffer += data.toString()
      if (stderrBuffer.length > MAX_BUF) stderrBuffer = stderrBuffer.slice(-MAX_BUF)
      checkUrl()
    })

    tunnelProcess.on('error', (err: Error) => {
      console.error('Tunnel error:', err)
      tunnelProcess = null
      tunnelUrl = null
      if (!resolved) {
        ctx.status = 500
        ctx.body = { success: false, error: err.message }
        resolved = true
        resolve()
      }
    })

    tunnelProcess.on('exit', (code: number | null) => {
      if (code !== 0 && !resolved) {
        console.log(`Tunnel exited with code ${code}`)
        ctx.body = { success: false, error: `cloudflared exited with code ${code}` }
        resolved = true
        resolve()
      }
      tunnelProcess = null
      if (!tunnelUrl || (resolved && !(ctx.body as any)?.success)) {
        tunnelUrl = null
      }
    })

    setTimeout(() => {
      if (!resolved) {
        if (tunnelProcess && !tunnelProcess.killed) {
          tunnelProcess.kill('SIGTERM')
          tunnelProcess = null
        }
        tunnelUrl = null
        ctx.status = 504
        ctx.body = { success: false, error: 'Tunnel timed out — cloudflared did not return a URL within 10s' }
        resolved = true
        resolve()
      }
    }, 10000)
  })
})

tunnelRoutes.post('/api/hermes/tunnel/stop', async (ctx) => {
  if (tunnelProcess && !tunnelProcess.killed) {
    const proc = tunnelProcess
    tunnelProcess = null
    tunnelUrl = null
    await new Promise<void>((resolve) => {
      proc.on('exit', resolve)
      proc.kill('SIGTERM')
      setTimeout(() => {
        if (!proc.killed) {
          try { proc.kill('SIGKILL') } catch {}
        }
        resolve()
      }, 5000)
    })
    ctx.body = { success: true }
  } else {
    // Clean up any orphaned cloudflared processes
    try {
      const pids = execSync("pgrep -f 'cloudflared tunnel'", { encoding: 'utf-8' }).trim()
      if (pids) {
        for (const pid of pids.split('\n')) {
          try { process.kill(parseInt(pid), 'SIGTERM') } catch {}
        }
      }
    } catch {}
    tunnelProcess = null
    tunnelUrl = null
    ctx.body = { success: true, message: 'No tunnel running' }
  }
})

tunnelRoutes.get('/api/hermes/tunnel/token', async (ctx) => {
  // Prefer env var (consistent with auth.ts)
  if (process.env.AUTH_TOKEN) {
    ctx.body = { token: process.env.AUTH_TOKEN }
    return
  }
  // Fallback: read from file
  try {
    const tokenPath = join(config.dataDir, '.token')
    const token = await readFile(tokenPath, 'utf-8')
    ctx.body = { token: token.trim() }
  } catch {
    ctx.body = { token: '' }
  }
})
