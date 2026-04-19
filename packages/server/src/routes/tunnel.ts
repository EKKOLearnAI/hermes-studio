import Router from '@koa/router'
import { spawn } from 'child_process'
import { config } from '../config'

const tunnelRoutes = new Router()

let tunnelProcess: ReturnType<typeof spawn> | null = null
let tunnelUrl: string | null = null

tunnelRoutes.get('/api/tunnel/status', async (ctx) => {
  ctx.body = {
    running: tunnelProcess !== null && !tunnelProcess.killed,
    url: tunnelUrl,
  }
})

tunnelRoutes.post('/api/tunnel/start', async (ctx) => {
  if (tunnelProcess && !tunnelProcess.killed) {
    ctx.body = { success: true, url: tunnelUrl, message: 'Tunnel already running' }
    return
  }

  const port = config.port

  return new Promise<void>((resolve) => {
    tunnelProcess = spawn('/usr/local/bin/cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--protocol', 'http2'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let buffer = ''

    tunnelProcess.stderr?.on('data', (data: Buffer) => {
      buffer += data.toString()
      const match = buffer.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)
      if (match && !tunnelUrl) {
        tunnelUrl = match[0]
        console.log(`🌐 Tunnel ready: ${tunnelUrl}`)
        ctx.body = { success: true, url: tunnelUrl }
        resolve()
      }
    })

    tunnelProcess.on('error', (err) => {
      console.error('Tunnel error:', err)
      tunnelProcess = null
      ctx.status = 500
      ctx.body = { success: false, error: err.message }
      resolve()
    })

    tunnelProcess.on('exit', (code) => {
      if (code !== 0) {
        console.log(`Tunnel exited with code ${code}`)
      }
      tunnelProcess = null
      tunnelUrl = null
    })

    setTimeout(() => {
      if (!ctx.body) {
        ctx.body = { success: true, url: tunnelUrl, message: 'Tunnel starting...' }
        resolve()
      }
    }, 5000)
  })
})

tunnelRoutes.post('/api/tunnel/stop', async (ctx) => {
  if (tunnelProcess && !tunnelProcess.killed) {
    tunnelProcess.kill('SIGTERM')
    tunnelProcess = null
    tunnelUrl = null
    ctx.body = { success: true }
  } else {
    ctx.body = { success: true, message: 'No tunnel running' }
  }
})

export { tunnelRoutes }