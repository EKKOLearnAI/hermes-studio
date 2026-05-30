import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

let initialized = false

export function initAutoUpdater() {
  if (initialized) return
  initialized = true

  if (!app.isPackaged) return // dev mode: skip
  if (process.env.HERMES_DESKTOP_ENABLE_AUTO_UPDATE !== 'true') return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', info => {
    console.log(`[updater] update available: ${info.version}`)
  })
  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date')
  })
  autoUpdater.on('error', err => {
    console.error('[updater] error:', err)
  })
  autoUpdater.on('update-downloaded', async info => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: `Hermes Studio ${info.version} is ready to install.`,
      detail: 'Restart now to apply the update, or it will be installed on next quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.checkForUpdates().catch(err => {
    console.error('[updater] initial check failed:', err)
  })

  // Recheck every 6h while app is running
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }, 6 * 60 * 60 * 1000)
}
