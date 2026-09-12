import { BrowserWindow } from 'electron'
import { t } from './desktop-i18n'
import { updateProgressHtml, normalizeDownloadProgress } from './update-progress-view'

let window: BrowserWindow | null = null
let active = false
let hidden = false
let state = { percent: 0, transferred: 0, total: 0, speed: 0, failed: false }
export function updateProgressWindow(progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number }, failed = false): void {
  // Update-check errors must not create a misleading download-failed window.
  if (failed && !active) return
  active = true
  if (progress) state = { ...normalizeDownloadProgress(progress), failed }
  else state = { ...state, failed }
  if (hidden) return
  if (!window || window.isDestroyed()) {
    const current = new BrowserWindow({ width: 480, height: 300, useContentSize: true, show: false, resizable: false, minimizable: true, title: t('update.progressTitle'), webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
    window = current
    current.setMenu(null)
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    current.webContents.on('will-navigate', event => event.preventDefault())
    current.webContents.once('did-finish-load', () => {
      if (window !== current || current.isDestroyed()) return
      render()
      current.showInactive()
    })
    current.on('closed', () => { if (window === current) { window = null; hidden = true } })
    void current.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(updateProgressHtml())).catch(() => undefined)
  } else render()
}
function render(): void {
  if (!window || window.isDestroyed() || window.webContents.isLoading()) return
  const message = state.failed ? t('update.downloadFailed') : state.total > 0 ? t('update.downloading') : t('update.preparingDownload')
  const detail = state.total > 0 ? `${(state.transferred / 1048576).toFixed(1)} / ${(state.total / 1048576).toFixed(1)} MB` : '— / — MB'
  const data = {status: message,subtitle:t('update.progressTitle'),percent:state.total > 0 ? `${state.percent.toFixed(1)}%` : '—',detail,speed:state.failed || !state.total ? '—' : `${(state.speed / 1048576).toFixed(1)} MB/s`,hint:state.failed?t('update.downloadFailedHint'):t('update.downloadBackgroundHint')}
  void window.webContents.executeJavaScript(`(()=>{const data=${JSON.stringify(data)};for(const [id,text] of Object.entries(data))document.getElementById(id).textContent=text;document.body.dataset.failed=${JSON.stringify(String(state.failed))};const bar=document.getElementById('bar');${state.total > 0 ? `bar.value=${JSON.stringify(state.percent)}` : "bar.removeAttribute('value')"};})()`).catch(() => undefined)
}
export function clearUpdateProgress(): void {
  for (const view of BrowserWindow.getAllWindows()) if (!view.isDestroyed()) view.setProgressBar(-1)
  const previous = window
  window = null
  previous?.close()
  active = false
  hidden = false
  state = { percent: 0, transferred: 0, total: 0, speed: 0, failed: false }
}
