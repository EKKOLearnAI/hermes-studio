import { spawn } from 'child_process'

/**
 * 判断是否为可重试的网关连接错误
 */
export function isTransientGatewayError(err: any): boolean {
  const msg = String(err?.message || '')
  const causeCode = String(err?.cause?.code || '')
  return (
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ECONNRESET' ||
    /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(msg)
  )
}

/**
 * 判断 URL 是否指向本地网关地址
 */
export function isLocalGatewayUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]'].includes(host)
  } catch {
    return false
  }
}

/**
 * 将任意网关 URL 转换为 WSL 内部 loopback 地址
 */
export function toWslLoopbackUrl(url: string): string {
  const parsed = new URL(url)
  return `${parsed.protocol}//127.0.0.1:${parsed.port}${parsed.pathname}${parsed.search}`
}

export interface WslProxyResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * 通过 wsl.exe 在 WSL 内部发起 HTTP 请求，用于 Windows 侧无法直接访问 WSL localhost 的场景
 */
export async function requestViaWsl(
  url: string,
  requestInit: RequestInit,
  headers: Record<string, string>,
): Promise<WslProxyResponse> {
  const internalUrl = toWslLoopbackUrl(url)
  const method = String(requestInit.method || 'GET')
  const headerJson = JSON.stringify(headers)
  const script = [
    'import json',
    'import sys',
    'import urllib.error',
    'import urllib.request',
    '',
    'method = sys.argv[1]',
    'url = sys.argv[2]',
    'headers = json.loads(sys.argv[3])',
    'raw = sys.stdin.buffer.read()',
    'data = raw if raw else None',
    'req = urllib.request.Request(url, data=data, headers=headers, method=method)',
    '',
    'try:',
    '  res = urllib.request.urlopen(req, timeout=60)',
    '  payload = {',
    '    "status": int(getattr(res, "status", 200)),',
    '    "headers": dict(res.headers.items()),',
    '    "body": res.read().decode("utf-8", "replace"),',
    '  }',
    'except urllib.error.HTTPError as err:',
    '  payload = {',
    '    "status": int(getattr(err, "code", 502)),',
    '    "headers": dict(err.headers.items()) if err.headers else {},',
    '    "body": err.read().decode("utf-8", "replace") if hasattr(err, "read") else "",',
    '  }',
    '',
    'print(json.dumps(payload, ensure_ascii=False))',
  ].join('\n')

  return await new Promise<WslProxyResponse>((resolve, reject) => {
    const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'python3', '-c', script, method, internalUrl, headerJson], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr || `wsl proxy exited with code ${code}`))
        return
      }
      try {
        const payload = JSON.parse(stdout.trim()) as WslProxyResponse
        resolve(payload)
      } catch (err) {
        reject(new Error(`Failed to parse WSL proxy response: ${stderr || String(err)}`))
      }
    })

    const body = typeof requestInit.body === 'string' ? requestInit.body : ''
    if (body) {
      child.stdin.write(body)
    }
    child.stdin.end()
  })
}

/**
 * 等待网关在可达地址上响应 /health（最多 timeoutMs 毫秒）
 * Windows + WSL 场景下本地地址不可达，此函数主要通过 WSL proxy 检测
 */
export async function waitForGatewayReady(upstream: string, timeoutMs: number = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `${upstream}/health`

  while (Date.now() < deadline) {
    try {
      let res: Response
      try {
        res = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(1200),
        })
      } catch (err: any) {
        if (process.platform === 'win32' && isLocalGatewayUrl(upstream) && isTransientGatewayError(err)) {
          const fallback = await requestViaWsl(healthUrl, { method: 'GET' }, {})
          res = new Response(fallback.body, {
            status: fallback.status,
            headers: fallback.headers,
          })
        } else {
          throw err
        }
      }
      if (res.ok) return true
    } catch { /* ignore */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}
