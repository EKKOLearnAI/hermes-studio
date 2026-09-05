import { spawn } from 'node:child_process'
import * as tar from 'tar'

const MAX_ERROR_LENGTH = 16 * 1024

function appendError(current: string, chunk: Buffer | string): string {
  if (current.length >= MAX_ERROR_LENGTH) return current
  return `${current}${chunk.toString()}`.slice(0, MAX_ERROR_LENGTH)
}

function extractWithWindowsTar(archive: string, targetRoot: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar.exe', ['-xzf', archive, '-C', targetRoot], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.on('data', chunk => {
      stderr = appendError(stderr, chunk)
    })
    child.once('error', error => {
      rejectPromise(new Error(`Windows tar.exe failed to start: ${error.message}`, { cause: error }))
    })
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const detail = stderr.trim() || `exit code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''}`
      rejectPromise(new Error(`Windows tar.exe failed to extract Runtime archive: ${detail}`))
    })
  })
}

export async function extractTarGzipArchive(archive: string, targetRoot: string): Promise<void> {
  if (process.platform === 'win32') {
    await extractWithWindowsTar(archive, targetRoot)
    return
  }

  await tar.x({
    file: archive,
    cwd: targetRoot,
    preserveOwner: false,
    unlink: false,
  })
}
