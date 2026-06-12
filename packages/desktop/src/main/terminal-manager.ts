import * as pty from 'node-pty'
import * as os from 'os'
import { BrowserWindow, ipcMain } from 'electron'

const sessions = new Map<string, { pty: pty.IPty; window: BrowserWindow }>()

export function setupTerminalManager() {
  ipcMain.handle('terminal:create', (event, { id, cwd }: { id: string; cwd?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    const ptyProcess = pty.spawn(
      os.platform() === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash'), [],
      { name: 'xterm-color', cols: 80, rows: 24, cwd: cwd || os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color' } }
    )
    ptyProcess.onData((data: string) => {
      if (!win.isDestroyed()) win.webContents.send('terminal:data:' + id, data)
    })
    sessions.set(id, { pty: ptyProcess, window: win })
    return true
  })
  ipcMain.handle('terminal:write', (_e, { id, data }: { id: string; data: string }) => {
    const s = sessions.get(id)
    if (!s) return false
    s.pty.write(data)
    return true
  })
  ipcMain.handle('terminal:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    const s = sessions.get(id)
    if (!s) return false
    s.pty.resize(cols, rows)
    return true
  })
  ipcMain.handle('terminal:kill', (_e, { id }: { id: string }) => {
    const s = sessions.get(id)
    if (!s) return false
    s.pty.kill()
    sessions.delete(id)
    return true
  })
}
