import { createInterface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'

/** Probe transport only; production continues to use DshAcpTurn. */
export class ProbeRpc {
  private nextId = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  readonly notifications: any[] = []
  readonly sent: any[] = []
  stderr = ''
  constructor(readonly child: ChildProcess) {
    child.stderr!.on('data', chunk => { this.stderr += chunk.toString() })
    createInterface({ input: child.stdout! }).on('line', line => {
      try {
        const message = JSON.parse(line)
        if (message.method) {
          this.notifications.push(message)
          if (message.id !== undefined) this.write({ id: message.id, error: { code: -32601, message: 'No interactive client in M0' } })
          return
        }
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
        else pending.resolve(message.result)
      } catch (error) { this.fail(error as Error) }
    })
    child.on('error', error => this.fail(error))
    child.on('close', () => this.fail(new Error(`DSH exited: ${this.stderr}`)))
    child.stdin!.on('error', error => this.fail(error))
  }
  private fail(error: Error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    this.pending.clear()
  }
  private write(value: object) { this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n') }
  request(method: string, params: object = {}, timeout = 20_000): Promise<any> {
    const id = ++this.nextId
    this.sent.push({ id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out\n${this.stderr}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }
  notify(method: string, params: object) { this.write({ method, params }) }
}
