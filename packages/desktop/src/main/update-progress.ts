import { BrowserWindow } from 'electron'
import { t } from './desktop-i18n'

let window: BrowserWindow | null = null
let state = { percent: 0, transferred: 0, total: 0, speed: 0, failed: false }
export function updateProgressWindow(progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number }, failed = false): void {
  if (progress) state = { percent: Math.max(0, Math.min(100, progress.percent)), transferred: progress.transferred, total: progress.total, speed: progress.bytesPerSecond, failed }
  else state = { ...state, failed }
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({ width: 460, height: 210, resizable: false, minimizable: true, title: t('update.checkingTitle'), webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
    window.setMenu(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    void window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font:14px system-ui;padding:24px}progress{width:100%;height:20px}small{display:block;margin-top:12px}</style><p id="status"></p><progress id="bar" max="100"></progress><small id="detail"></small>'))
    window.webContents.once('did-finish-load', render)
    window.on('closed', () => { window = null })
  } else render()
}
function render(): void {
  if (!window || window.isDestroyed() || window.webContents.isLoading()) return
  const message = state.failed ? t('update.failedMessage') : t('update.downloading')
  const detail = `${state.percent.toFixed(1)}% · ${(state.transferred / 1048576).toFixed(1)} / ${(state.total / 1048576).toFixed(1)} MB · ${(state.speed / 1048576).toFixed(1)} MB/s`
  void window.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(message)};document.getElementById('bar').value=${JSON.stringify(state.percent)};document.getElementById('detail').textContent=${JSON.stringify(detail)}`).catch(() => undefined)
}
export function clearUpdateProgress(): void {
  for (const view of BrowserWindow.getAllWindows()) if (!view.isDestroyed()) view.setProgressBar(-1)
  window?.close(); window = null
  state = { percent: 0, transferred: 0, total: 0, speed: 0, failed: false }
}
