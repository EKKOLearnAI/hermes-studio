import { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage, Notification } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startWebUiServer, stopWebUiServer, getToken } from './webui-server'
import { bundledNode, desktopIcon, desktopRuntimeVersion, desktopTrayTemplateIcon, desktopWindowsTrayIcon, hermesBinExists, hermesBin, webuiDir } from './paths'
import { checkForDesktopUpdates, initAutoUpdater } from './updater'
import { t } from './desktop-i18n'
import { installHermesStudioCliShim, installHermesStudioMcpShim } from './cli-shim'
import { parseHermesCliArgs, runBundledHermesCli } from './hermes-cli'
import {
  cachedRuntimeNeedsPackagedReleaseUpdate,
  ensureDesktopRuntime,
  isDesktopRuntimeReady,
  migrateLegacyDesktopRuntime,
  writeActiveRuntimeVersion,
  type RuntimeDownloadSource,
  type RuntimeProgress,
} from './runtime-manager'

const PORT = Number(process.env.HERMES_DESKTOP_PORT) || 8748
const START_HIDDEN = process.argv.includes('--hidden')
const QUIT_EXISTING = process.argv.includes('--quit')
const APP_USER_MODEL_ID = 'com.hermeswebui.studio'
type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close'

let mainWindow: BrowserWindow | null = null
let serverUrl: string | null = null
let tray: Tray | null = null
let isQuitting = false
let isBootstrapping = false
let windowFadeTimer: NodeJS.Timeout | null = null
const activeNotifications = new Set<Notification>()

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

function cancelWindowFade() {
  if (windowFadeTimer) {
    clearInterval(windowFadeTimer)
    windowFadeTimer = null
  }
}

function showWindowWithFade(focus = true) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()

  cancelWindowFade()
  if (process.platform !== 'win32' || mainWindow.isVisible()) {
    mainWindow.setOpacity(1)
    mainWindow.show()
    if (focus) mainWindow.focus()
    return
  }

  const durationMs = 180
  const startedAt = Date.now()
  mainWindow.setOpacity(0)
  mainWindow.show()
  if (focus) mainWindow.focus()
  windowFadeTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      cancelWindowFade()
      return
    }
    const progress = Math.min(1, (Date.now() - startedAt) / durationMs)
    mainWindow.setOpacity(progress)
    if (progress >= 1) {
      mainWindow.setOpacity(1)
      cancelWindowFade()
    }
  }, 16)
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow()
  }
  if (!mainWindow) return
  showWindowWithFade(true)
}

function quitApp() {
  isQuitting = true
  app.quit()
}

function windowState() {
  return {
    isMaximized: !!mainWindow?.isMaximized(),
  }
}

function handleWindowControl(action: WindowControlAction) {
  if (!mainWindow || mainWindow.isDestroyed()) return windowState()
  if (action === 'minimize') {
    mainWindow.minimize()
  } else if (action === 'toggle-maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  } else if (action === 'close') {
    mainWindow.close()
  }
  return windowState()
}

function hasQuitRequest(data: unknown): boolean {
  return typeof data === 'object'
    && data !== null
    && (data as { quit?: unknown }).quit === true
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
    show: false,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 12 },
        }
      : {
          frame: false,
        }),
    ...(process.platform === 'linux' ? { icon: desktopIcon() } : {}),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) showWindowWithFade(true)
  })

  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    cancelWindowFade()
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
  const startingLabel = escapeHtml(t('desktop.startingLocalServices'))
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Hermes Studio</title>
<style>
  html,body{margin:0;height:100%;background:#1a1a1a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:20px}
  .dot{width:10px;height:10px;border-radius:50%;background:#888;animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
  .row{display:flex;gap:8px}
  .row .dot:nth-child(2){animation-delay:.2s}.row .dot:nth-child(3){animation-delay:.4s}
  .label{font-size:14px;color:#b8b8b8}
  .detail{min-height:18px;font-size:12px;color:#7f7f7f}
  .progress{width:320px;height:6px;border-radius:999px;background:#2b2b2b;overflow:hidden}
  .bar{width:0;height:100%;background:#d8d8d8;transition:width .18s ease}
  h1{font-weight:500;margin:0;font-size:18px}
</style></head><body><div class="wrap">
<h1>Hermes Studio</h1>
<div class="row"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
<div id="label" class="label">${startingLabel}</div>
<div class="progress"><div id="bar" class="bar"></div></div>
<div id="detail" class="detail"></div>
</div></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] || char))
}

function runtimeSourceHtml(errorMessage?: string): string {
  const safeError = errorMessage ? escapeHtml(errorMessage) : ''
  const errorBlock = safeError
    ? `<section class="error" aria-live="polite">
        <div class="error-title">${escapeHtml(t('desktop.downloadFailed'))}</div>
        <pre>${safeError}</pre>
       </section>`
    : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Hermes Studio</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%;background:#191919;color:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;}
  body{display:grid;place-items:center;padding:32px}
  .wrap{width:min(720px,100%);display:flex;flex-direction:column;align-items:center;gap:22px;text-align:center}
  .brand{display:flex;align-items:center;gap:10px;color:#f6f6f6}
  .mark{width:32px;height:32px;border-radius:7px;background:#f0f0f0;color:#171717;display:grid;place-items:center;font-weight:700;font-size:16px}
  h1{font-weight:560;margin:0;font-size:22px;line-height:1.25}
  .label{max-width:520px;font-size:14px;line-height:1.6;color:#b9b9b9;margin:0}
  .actions{width:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  button{min-height:86px;border:1px solid #4c4c4c;border-radius:8px;background:#242424;color:#f2f2f2;cursor:pointer;padding:16px;text-align:left;display:flex;flex-direction:column;gap:7px;transition:background .14s ease,border-color .14s ease,transform .14s ease}
  button:hover{background:#2d2d2d;border-color:#747474;transform:translateY(-1px)}
  button:active{transform:translateY(0)}
  button:focus-visible{outline:2px solid #dcdcdc;outline-offset:3px}
  .button-title{font-size:15px;font-weight:650;line-height:1.2}
  .button-detail{font-size:12px;line-height:1.45;color:#aaaaaa}
  .error{width:100%;text-align:left;background:#241b1b;border:1px solid #6b3939;border-radius:8px;padding:14px}
  .error-title{font-size:13px;font-weight:650;color:#ffc3c3;margin-bottom:8px}
  pre{width:100%;max-height:180px;overflow:auto;white-space:pre-wrap;margin:0;color:#ffaaaa;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  @media (max-width:560px){
    body{padding:24px}
    .actions{grid-template-columns:1fr}
    button{min-height:78px}
  }
</style></head><body><main class="wrap">
<div class="brand"><div class="mark">H</div><h1>Hermes Studio</h1></div>
<p class="label">${escapeHtml(t('desktop.selectRuntimeSource'))}</p>
${errorBlock}
<div class="actions">
  <button id="cf">
    <span class="button-title">${escapeHtml(t('desktop.downloadCloudflareTitle'))}</span>
    <span class="button-detail">${escapeHtml(t('desktop.downloadCloudflareDetail'))}</span>
  </button>
  <button id="github">
    <span class="button-title">${escapeHtml(t('desktop.downloadGithubTitle'))}</span>
    <span class="button-detail">${escapeHtml(t('desktop.downloadGithubDetail'))}</span>
  </button>
</div>
<script>
  document.getElementById('cf')?.addEventListener('click', () => {
    window.hermesDesktop?.retryBootstrap?.('cf')
  })
  document.getElementById('github')?.addEventListener('click', () => {
    window.hermesDesktop?.retryBootstrap?.('github')
  })
</script>
</main></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

function envRuntimeDownloadSource(): RuntimeDownloadSource | undefined {
  const source = process.env.HERMES_DESKTOP_RUNTIME_SOURCE?.trim().toLowerCase()
  return source === 'cf' || source === 'github' ? source : undefined
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = units[0]
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024
    unit = units[i]
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`
}

function updateSplash(progress: RuntimeProgress) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const label = progress.message
  const percent = typeof progress.percent === 'number' ? Math.round(progress.percent) : null
  let detail = ''
  if (progress.receivedBytes && progress.totalBytes) {
    detail = `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
    if (percent !== null) detail += ` (${percent}%)`
  } else if (percent !== null) {
    detail = `${percent}%`
  }

  mainWindow.webContents.executeJavaScript(`
    {
      const label = document.getElementById('label');
      const detail = document.getElementById('detail');
      const bar = document.getElementById('bar');
      if (label) label.textContent = ${JSON.stringify(label)};
      if (detail) detail.textContent = ${JSON.stringify(detail)};
      if (bar) bar.style.width = ${JSON.stringify(percent === null ? '100%' : `${percent}%`)};
    }
  `).catch(() => undefined)
}

async function bootstrap(source?: RuntimeDownloadSource) {
  if (isBootstrapping) return
  isBootstrapping = true

  try {
    const selectedSource = source || envRuntimeDownloadSource()
    const migration = migrateLegacyDesktopRuntime(updateSplash)
    const migrationFailed = migration.status === 'failed'
    const runtimeUrlOverride = !!process.env.HERMES_DESKTOP_RUNTIME_URL?.trim()
    const manifestOverride = !!process.env.HERMES_DESKTOP_RUNTIME_MANIFEST_URL?.trim()
    const forceUpdate = !!process.env.HERMES_DESKTOP_RUNTIME_FORCE_UPDATE
    const runtimeReady = isDesktopRuntimeReady()
    const packagedRuntimeUpdate = app.isPackaged && runtimeReady && cachedRuntimeNeedsPackagedReleaseUpdate()
    const shouldCheckRuntime = !runtimeReady || forceUpdate || runtimeUrlOverride || manifestOverride || packagedRuntimeUpdate
    const runtimeSource = selectedSource || (!runtimeReady || packagedRuntimeUpdate || migrationFailed ? 'cf' : undefined)

    if (shouldCheckRuntime) {
      if (!runtimeSource && !runtimeUrlOverride && !manifestOverride) {
        if (mainWindow) await mainWindow.loadURL(runtimeSourceHtml())
        isBootstrapping = false
        return
      }
      await ensureDesktopRuntime(updateSplash, runtimeSource, true)
    }
    if (isDesktopRuntimeReady()) {
      writeActiveRuntimeVersion()
    }
  } catch (err) {
    console.error('Failed to prepare Hermes runtime:', err)
    if (mainWindow) {
      const msg = String(err instanceof Error ? err.message : err)
      await mainWindow.loadURL(runtimeSourceHtml(`${t('desktop.failedPrepareRuntime')}\n\n${msg}`))
    }
    isBootstrapping = false
    return
  }

  if (!hermesBinExists()) {
    console.error(`hermes binary missing at ${hermesBin()}`)
    console.error('Run: npm run prepare:runtime (to build a local Hermes runtime)')
  }

  try {
    const url = await startWebUiServer(PORT)
    serverUrl = url
    if (mainWindow) await mainWindow.loadURL(url)
  } catch (err) {
    console.error('Failed to start Web UI server:', err)
    if (mainWindow) {
      const msg = escapeHtml(String(err instanceof Error ? err.message : err))
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        `<html><body style="font-family:system-ui;padding:32px;background:#1a1a1a;color:#eee">
         <h2>${escapeHtml(t('desktop.failedStartServices'))}</h2><pre style="white-space:pre-wrap;color:#f88">${msg}</pre>
         </body></html>`,
      ))
    }
  } finally {
    isBootstrapping = false
  }
}

ipcMain.handle('hermes-desktop:get-token', () => getToken())
ipcMain.handle('hermes-desktop:get-window-state', () => windowState())
ipcMain.handle('hermes-desktop:window-control', (_event, action?: unknown) => {
  if (action !== 'minimize' && action !== 'toggle-maximize' && action !== 'close') return windowState()
  return handleWindowControl(action)
})
function resolveNotificationIcon(icon: unknown): string {
  if (typeof icon !== 'string') return desktopIcon()
  const normalized = icon.trim().replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) return desktopIcon()

  const candidates = [
    join(webuiDir(), 'dist', 'client', normalized),
    join(webuiDir(), 'dist', normalized),
    join(webuiDir(), 'packages', 'client', 'public', normalized),
    join(webuiDir(), normalized),
  ]
  return candidates.find(candidate => existsSync(candidate)) || desktopIcon()
}

ipcMain.handle('hermes-desktop:notify-completion', (_event, payload?: { title?: unknown; body?: unknown; icon?: unknown; tag?: unknown }) => {
  const supported = Notification.isSupported()
  if (!supported) {
    console.warn('[desktop-notification] Electron notifications are not supported on this system')
    return false
  }

  const title = typeof payload?.title === 'string' && payload.title.trim()
    ? payload.title.trim()
    : 'Hermes Studio'
  const body = typeof payload?.body === 'string' ? payload.body.trim().slice(0, 240) : ''
  const icon = resolveNotificationIcon(payload?.icon)
  const notification = new Notification({
    title,
    body,
    icon,
    silent: false,
  })
  activeNotifications.add(notification)
  const releaseNotification = () => {
    activeNotifications.delete(notification)
  }
  notification.on('click', () => {
    releaseNotification()
    showMainWindow()
  })
  notification.on('close', releaseNotification)
  notification.on('failed', (_event, error) => {
    console.warn('[desktop-notification] notification failed', error)
    releaseNotification()
  })
  notification.show()
  return true
})
ipcMain.handle('hermes-desktop:retry-bootstrap', async (_event, source?: RuntimeDownloadSource) => {
  if (serverUrl) {
    await mainWindow?.loadURL(serverUrl)
    return
  }
  const selectedSource = source === 'cf' || source === 'github' ? source : undefined
  await mainWindow?.loadURL(splashHtml())
  await bootstrap(selectedSource)
})

function runDesktopApp() {
  const gotLock = app.requestSingleInstanceLock(QUIT_EXISTING ? { quit: true } : undefined)
  if (!gotLock) {
    app.quit()
    return
  }

  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    if (argv.includes('--quit') || hasQuitRequest(additionalData)) {
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
      installHermesStudioCliShim({ runtimeVersion: desktopRuntimeVersion() }).then(result => {
        if (result.status === 'skipped') {
          console.warn(`[cli-shim] ${result.reason}: ${result.shimPath}`)
        }
      }).catch(err => {
        console.warn(`[cli-shim] failed to install hermes-studio command: ${err instanceof Error ? err.message : String(err)}`)
      })
      installHermesStudioMcpShim({
        nodePath: bundledNode(),
        scriptPath: join(webuiDir(), 'bin', 'hermes-web-ui-mcp.mjs'),
        webUiUrl: `http://127.0.0.1:${PORT}`,
      }).then(result => {
        if (result.status === 'skipped') {
          console.warn(`[cli-shim] ${result.reason}: ${result.shimPath}`)
        }
      }).catch(err => {
        console.warn(`[cli-shim] failed to install hermes-studio-mcp command: ${err instanceof Error ? err.message : String(err)}`)
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
    cancelWindowFade()
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
