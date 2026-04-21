import { spawn } from 'child_process'

export async function handleUpdate(ctx: any) {
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'cmd /c npm install -g hermes-web-ui@latest' : 'npm install -g hermes-web-ui@latest'
  try {
    const { execSync } = await import('child_process')
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] })
    ctx.body = { success: true, message: output.trim() }
    setTimeout(() => {
      spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', 'hermes-web-ui restart'] : ['-c', 'hermes-web-ui restart'], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref()
      process.exit(0)
    }, 2000)
  } catch (err: any) {
    ctx.status = 500; ctx.body = { success: false, message: err.stderr || err.message }
  }
}
