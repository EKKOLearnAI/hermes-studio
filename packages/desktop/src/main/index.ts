import { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage } from 'electron'
import { join } from 'node:path'
import { startWebUiServer, stopWebUiServer, getToken } from './webui-server'
import { desktopIcon, desktopTrayTemplateIcon, desktopWindowsTrayIcon, hermesBinExists, hermesBin } from './paths'
import { checkForDesktopUpdates, initAutoUpdater } from './updater'
import { t } from './desktop-i18n'
import { installHermesStudioCliShim } from './cli-shim'
import { parseHermesCliArgs, runBundledHermesCli } from './hermes-cli'

const PORT = Number(process.env.HERMES_DESKTOP_PORT) || 8748
const START_HIDDEN = process.argv.includes('--hidden')
const QUIT_EXISTING = process.argv.includes('--quit')

let mainWindow: BrowserWindow | null = null
let serverUrl: string | null = null
let tray: Tray | null = null
let isQuitting = false

function showMainWindow() {
  if (!mainWindow) {
    createWindow()
  }
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quitApp() {
  isQuitting = true
  app.quit()
}

function loginItemOptions() {
  return {
    path: process.execPath,
    args: ['--hidden'],
  }
}

function getOpenAtLogin(): boolean {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin
}

function setOpenAtLogin(openAtLogin: boolean) {
  app.setLoginItemSettings({
    ...loginItemOptions(),
    openAtLogin,
    openAsHidden: true,
  })
}

function updateTrayMenu() {
  if (!tray) return
  const isVisible = !!mainWindow && mainWindow.isVisible()
  const menu = Menu.buildFromTemplate([
    {
      label: isVisible ? t('tray.hide') : t('tray.show'),
      click: () => {
        if (mainWindow?.isVisible()) {
          mainWindow.hide()
        } else {
          showMainWindow()
        }
        updateTrayMenu()
      },
    },
    {
      label: t('tray.checkForUpdates'),
      click: () => {
        checkForDesktopUpdates(true).catch(err => {
          console.error('[tray] update check failed:', err)
        })
      },
    },
    {
      label: t('tray.openAtLogin'),
      type: 'checkbox',
      checked: getOpenAtLogin(),
      click: (item) => {
        setOpenAtLogin(item.checked)
        updateTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: t('tray.quit'),
      click: quitApp,
    },
  ])
  tray.setContextMenu(menu)
}

function createTray() {
  if (tray) return
  const source = process.platform === 'darwin'
    ? desktopTrayTemplateIcon()
    : process.platform === 'win32'
      ? desktopWindowsTrayIcon()
      : desktopIcon()
  const icon = nativeImage.createFromPath(source).resize({
    width: process.platform === 'darwin' ? 18 : process.platform === 'win32' ? 24 : 16,
    height: process.platform === 'darwin' ? 18 : process.platform === 'win32' ? 24 : 16,
    quality: 'best',
  })
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true)
  }
  tray = new Tray(icon)
  tray.setToolTip('Hermes Studio')
  tray.on('click', () => {
    showMainWindow()
    updateTrayMenu()
  })
  updateTrayMenu()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'Hermes Studio',
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    show: !START_HIDDEN,
    ...(process.platform === 'linux' ? { icon: desktopIcon() } : {}),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    mainWindow?.hide()
    updateTrayMenu()
  })

  mainWindow.on('show', updateTrayMenu)
  mainWindow.on('hide', updateTrayMenu)

  // External links → system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })

  // If the Web UI server is already up (re-opening window after close on
  // macOS), go straight to it. Otherwise show a loading splash; bootstrap()
  // will swap in the real URL once the server is ready.
  if (serverUrl) {
    mainWindow.loadURL(serverUrl)
  } else {
    mainWindow.loadURL(splashHtml())
  }
  updateTrayMenu()
}

function splashHtml(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Hermes Studio</title>
<style>
  html,body{margin:0;height:100%;background:#1a1a1a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:24px}
  .dot{width:10px;height:10px;border-radius:50%;background:#888;animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
  .row{display:flex;gap:8px}
  .row .dot:nth-child(2){animation-delay:.2s}.row .dot:nth-child(3){animation-delay:.4s}
  .label{font-size:14px;color:#999}
  h1{font-weight:500;margin:0;font-size:18px}
</style></head><body><div class="wrap">
<h1>Hermes Studio</h1>
<div class="row"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
<div class="label">Starting local services…</div>
</div></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

async function bootstrap() {
  if (!hermesBinExists()) {
    console.error(`hermes binary missing at ${hermesBin()}`)
    console.error('Run: npm run prepare:python (to bundle Python + hermes-agent)')
  }

  try {
    const url = await startWebUiServer(PORT)
    serverUrl = url
    if (mainWindow) await mainWindow.loadURL(url)
  } catch (err) {
    console.error('Failed to start Web UI server:', err)
    if (mainWindow) {
      const msg = String(err instanceof Error ? err.message : err).replace(/[<>]/g, '')
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        `<html><body style="font-family:system-ui;padding:32px;background:#1a1a1a;color:#eee">
         <h2>Failed to start local services</h2><pre style="white-space:pre-wrap;color:#f88">${msg}</pre>
         </body></html>`,
      ))
    }
  }
}

ipcMain.handle('hermes-desktop:get-token', () => getToken())

function runDesktopApp() {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return
  }

  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quit')) {
      quitApp()
      return
    }
    showMainWindow()
  })

  app.whenReady().then(() => {
    if (QUIT_EXISTING) {
      quitApp()
      return
    }

    // Drop the default File/Edit/View/Window menu on Windows/Linux. The web
    // UI provides its own in-page controls, so the native menu bar is just
    // visual clutter. macOS keeps a menu (system requirement) but Electron's
    // default is fine there.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    if (app.isPackaged) {
      installHermesStudioCliShim().then(result => {
        if (result.status === 'skipped') {
          console.warn(`[cli-shim] ${result.reason}: ${result.shimPath}`)
        }
      }).catch(err => {
        console.warn(`[cli-shim] failed to install hermes-studio command: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    createTray()
    createWindow()
    bootstrap()
    initAutoUpdater({
      beforeQuitAndInstall: () => {
        isQuitting = true
      },
    })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      } else if (mainWindow) {
        showMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (isQuitting && process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', async (e) => {
    if (!isQuitting && process.platform !== 'darwin') {
      e.preventDefault()
      mainWindow?.hide()
      updateTrayMenu()
      return
    }
    e.preventDefault()
    await stopWebUiServer().catch(() => undefined)
    app.exit(0)
  })
}

const hermesCliArgs = parseHermesCliArgs(process.argv)
if (hermesCliArgs) {
  runBundledHermesCli(hermesCliArgs)
    .then(code => app.exit(code))
    .catch(err => {
      console.error(`Failed to run bundled Hermes CLI: ${err instanceof Error ? err.message : String(err)}`)
      app.exit(1)
    })
} else {
  runDesktopApp()
}
