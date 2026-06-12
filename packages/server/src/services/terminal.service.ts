import { EventEmitter } from 'events'
import * as pty from 'node-pty'
import * as os from 'os'

const SHELL = os.platform() === 'win32'
  ? (process.env.COMSPEC || 'cmd.exe')
  : (process.env.SHELL || '/bin/bash')

export interface ITerminalSession {
  id: string
  pty: pty.IPty
  emitter: EventEmitter
}

const sessions = new Map<string, ITerminalSession>()

export function createTerminalSession(id: string, cwd?: string): ITerminalSession {
  const emitter = new EventEmitter()
  const ptyProcess = pty.spawn(SHELL, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: cwd || process.env.HOME || os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  })
  ptyProcess.onData((data: string) => { emitter.emit('data', data) })
  ptyProcess.onExit(({ exitCode, signal }) => {
    emitter.emit('exit', { exitCode, signal })
    sessions.delete(id)
  })
  sessions.set(id, { id, pty: ptyProcess, emitter })
  return sessions.get(id)!
}

export function writeToTerminal(id: string, data: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  s.pty.write(data)
  return true
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const s = sessions.get(id)
  if (!s) return false
  s.pty.resize(cols, rows)
  return true
}

export function killTerminalSession(id: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  s.pty.kill()
  sessions.delete(id)
  return true
}
