const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  nativeImage,
  shell,
  dialog,
  session,
} = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

/** @typedef {{ startUrl: string, launchCommand?: string }} ShellConfig */

const DEFAULT_START_URL = 'http://localhost:8648/'
const DEFAULT_LAUNCH_COMMAND = 'npx hermes-web-ui restart'
const APP_ICON_PATH = path.join(
  __dirname,
  'assets',
  process.platform === 'win32' ? 'hermes.ico' : 'hermes.png',
)
const APP_ICON = nativeImage.createFromPath(APP_ICON_PATH)

const LOCALE_FILE = 'hermes-shell-locale.json'

let mainWindow = null
let launcherWindow = null
let serverProcess = null
let healthCheckTimer = null

function configPath() {
  return path.join(app.getPath('userData'), 'hermes-shell-config.json')
}

function localePath() {
  return path.join(app.getPath('userData'), LOCALE_FILE)
}

const SUPPORTED_LOCALES = ['en', 'zh-CN', 'de', 'es', 'fr', 'ja', 'ko', 'pt']

/** @param {string} s */
function normalizeLocale(s) {
  const x = String(s || '')
    .replace(/_/g, '-')
    .toLowerCase()
  if (x.startsWith('zh')) return 'zh-CN'
  if (x.startsWith('de')) return 'de'
  if (x.startsWith('es')) return 'es'
  if (x.startsWith('fr')) return 'fr'
  if (x.startsWith('ja')) return 'ja'
  if (x.startsWith('ko')) return 'ko'
  if (x.startsWith('pt')) return 'pt'
  return 'en'
}

function readSavedLocale() {
  try {
    const raw = fs.readFileSync(localePath(), 'utf8')
    const j = JSON.parse(raw)
    if (typeof j?.locale === 'string' && j.locale.trim()) {
      return normalizeLocale(j.locale.trim())
    }
  } catch (_) {}
  return null
}

function writeSavedLocale(locale) {
  const id = normalizeLocale(locale)
  fs.mkdirSync(path.dirname(localePath()), { recursive: true })
  fs.writeFileSync(localePath(), JSON.stringify({ locale: id }, null, 2), 'utf8')
}

function getLocale() {
  const saved = readSavedLocale()
  if (saved) return saved
  return normalizeLocale(app.getLocale())
}

/** @param {Record<string, unknown>} obj @param {string} dotPath */
function pick(obj, dotPath) {
  const parts = dotPath.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return ''
    cur = /** @type {Record<string, unknown>} */ (cur)[p]
  }
  return cur == null ? '' : String(cur)
}

/** @param {string} template @param {Record<string, string>} vars */
function formatStr(template, vars) {
  let s = template
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{${k}}`).join(v)
  }
  return s
}

/** @param {string} id */
function loadStrings(id) {
  const file = path.join(__dirname, 'locales', `${id}.json`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_) {
    const fallback = path.join(__dirname, 'locales', 'en.json')
    return JSON.parse(fs.readFileSync(fallback, 'utf8'))
  }
}

function getI18nPayload() {
  const locale = getLocale()
  return { locale, strings: loadStrings(locale) }
}

/** @returns {ShellConfig | null} */
function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const j = JSON.parse(raw)
    if (j && typeof j.startUrl === 'string' && j.startUrl.trim()) {
      return {
        startUrl: j.startUrl.trim(),
        launchCommand: typeof j.launchCommand === 'string' ? j.launchCommand.trim() : '',
      }
    }
  } catch (_) {}
  return null
}

/** @param {ShellConfig} cfg */
function writeConfig(cfg) {
  const out = {
    startUrl: String(cfg.startUrl || '').trim(),
    launchCommand: String(cfg.launchCommand || '').trim(),
  }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(out, null, 2), 'utf8')
}

/** @param {string} url */
function normalizeStartUrlForConfig(url) {
  try {
    const parsed = new URL(String(url || '').trim())
    return `${parsed.origin}/`
  } catch {
    return String(url || '').trim()
  }
}

/**
 * Check if the backend server is healthy by requesting /health.
 * @param {string} url - The base URL (e.g. http://localhost:8648)
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<boolean>}
 */
async function checkServerHealth(url, timeoutMs = 3000) {
  try {
    const parsed = new URL(url)
    const healthUrl = `${parsed.origin}/health`
    const resp = await net.fetch(healthUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return resp.ok
  } catch {
    return false
  }
}

function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
}

function killServerProcess() {
  stopHealthCheck()
  if (serverProcess) {
    try {
      // On Windows, kill the process tree
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(serverProcess.pid), '/f', '/t'], { stdio: 'ignore' })
      } else {
        serverProcess.kill('SIGTERM')
      }
    } catch (_) {}
    serverProcess = null
  }
}

function resetShellState() {
  killServerProcess()
  try {
    fs.rmSync(configPath(), { force: true })
  } catch (_) {}
  const ses = session.fromPartition('persist:hermes-shell')
  return ses.clearStorageData()
}

/** @param {ShellConfig} cfg */
function createMainWindow(cfg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close()
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 600,
    icon: APP_ICON,
    webPreferences: {
      partition: 'persist:hermes-shell',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const t = loadStrings(getLocale())
  mainWindow.loadURL(cfg.startUrl).catch((e) => {
    dialog.showErrorBox(
      pick(t, 'dialog.loadFailedTitle'),
      formatStr(pick(t, 'dialog.loadFailedBody'), {
        message: e.message || String(e),
      }),
    )
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** @param {'launch' | 'preferences'} [mode='launch'] */
function createLauncherWindow(mode = 'launch') {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.webContents.send('launcher-mode-changed', mode)
    launcherWindow.focus()
    return
  }
  launcherWindow = new BrowserWindow({
    width: 600,
    height: 520,
    resizable: true,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload-launcher.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // needed for child_process IPC
    },
  })
  launcherWindow.loadFile(path.join(__dirname, 'launcher.html'), {
    query: { mode },
  })
  launcherWindow.on('closed', () => {
    launcherWindow = null
    if ((!mainWindow || mainWindow.isDestroyed()) && process.platform !== 'darwin') {
      killServerProcess()
    }
  })
}

function buildAppMenu() {
  const id = getLocale()
  const t = loadStrings(id)
  const m = (key) => pick(t, `menu.${key}`)

  const shellPrefs = {
    label: m('preferences'),
    click: () => createLauncherWindow('preferences'),
  }
  const reopenApp = {
    label: m('reopen'),
    click: () => {
      if (launcherWindow && !launcherWindow.isDestroyed()) {
        launcherWindow.webContents.send('launcher-mode-changed', 'launch')
        launcherWindow.show()
        launcherWindow.focus()
        return
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close()
      }
      createLauncherWindow('launch')
    },
  }
  const resetShell = {
    label: m('resetShell'),
    click: async () => {
      try {
        await resetShellState()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.close()
        }
        createLauncherWindow()
      } catch (e) {
        dialog.showErrorBox(
          pick(t, 'dialog.loadFailedTitle'),
          formatStr(pick(t, 'dialog.loadFailedBody'), {
            message: e.message || String(e),
          }),
        )
      }
    },
  }
  const viewSub = [
    { role: 'reload', label: m('reload') },
    { role: 'forceReload', label: m('forceReload') },
    { type: 'separator' },
    { role: 'toggleDevTools', label: m('devTools') },
    { type: 'separator' },
    { role: 'resetZoom', label: m('resetZoom') },
    { role: 'zoomIn', label: m('zoomIn') },
    { role: 'zoomOut', label: m('zoomOut') },
  ]
  const template =
    process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: m('about') },
              { type: 'separator' },
              shellPrefs,
              reopenApp,
              resetShell,
              { type: 'separator' },
              { role: 'hide', label: m('hide') },
              { role: 'hideOthers', label: m('hideOthers') },
              { role: 'unhide', label: m('unhide') },
              { type: 'separator' },
              { role: 'quit', label: m('quit') },
            ],
          },
          { label: m('view'), submenu: viewSub },
        ]
      : [
          {
            label: m('file'),
            submenu: [shellPrefs, reopenApp, resetShell, { type: 'separator' }, { role: 'quit', label: m('quit') }],
          },
          { label: m('view'), submenu: viewSub },
        ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

ipcMain.handle('shell-get-config', () => {
  const c = readConfig()
  return {
    startUrl: c?.startUrl ?? '',
    defaultStartUrl: DEFAULT_START_URL,
  }
})

ipcMain.handle('shell-launcher-get-config', () => {
  const c = readConfig()
  return {
    startUrl: c?.startUrl ?? DEFAULT_START_URL,
    launchCommand: c?.launchCommand ?? '',
    defaultCommand: DEFAULT_LAUNCH_COMMAND,
  }
})

ipcMain.handle('shell-launcher-save-config', (_e, payload) => {
  const startUrl = String(payload?.startUrl || '').trim()
  const launchCommand = String(payload?.launchCommand || '').trim()
  if (!startUrl) throw new Error('Start URL is empty')
  writeConfig({ startUrl, launchCommand })
  return true
})

ipcMain.handle('shell-launcher-check-health', async (_e, payload) => {
  const startUrl = String(payload?.startUrl || '').trim()
  if (!startUrl) return false
  return checkServerHealth(startUrl)
})

ipcMain.handle('shell-start-server', async (_e, payload) => {
  const cmd = String(payload?.command || '').trim()
  const startUrl = String(payload?.startUrl || '').trim()
  if (!cmd) throw new Error('Command is empty')
  if (!startUrl) throw new Error('Start URL is empty')

  killServerProcess()

  const isWin = process.platform === 'win32'
  const shellCmd = isWin ? 'cmd' : '/bin/sh'
  const shellArgs = isWin ? ['/c', cmd] : ['-c', cmd]

  serverProcess = spawn(shellCmd, shellArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
    env: { ...process.env, HERMES_NO_BROWSER: '1' },
  })

  let detectedStartUrl = startUrl
  let pendingOutput = ''
  const urlPattern = /https?:\/\/[^\s"'<>]+/i

  const processOutputText = (text) => {
    pendingOutput += text
    const lines = pendingOutput.split(/\r?\n/)
    pendingOutput = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const m = trimmed.match(urlPattern)
      if (!m) continue
      const candidate = m[0]
      if (candidate === detectedStartUrl) continue
      try {
        new URL(candidate)
        detectedStartUrl = candidate
        if (launcherWindow && !launcherWindow.isDestroyed()) {
          launcherWindow.webContents.send('launcher-detected-url', detectedStartUrl)
        }
      } catch (_) {}
    }
  }

  const sendLog = (data) => {
    const text = data.toString()
    processOutputText(text)
    if (launcherWindow && !launcherWindow.isDestroyed()) {
      launcherWindow.webContents.send('launcher-log', text)
    }
  }

  serverProcess.stdout.on('data', sendLog)
  serverProcess.stderr.on('data', sendLog)

  serverProcess.on('error', (err) => {
    if (launcherWindow && !launcherWindow.isDestroyed()) {
      launcherWindow.webContents.send('launcher-server-failed', err.message)
    }
    stopHealthCheck()
    serverProcess = null
  })

  serverProcess.on('exit', (code) => {
    serverProcess = null
    if (code === 0 || code === null) return
    if (launcherWindow && !launcherWindow.isDestroyed()) {
      launcherWindow.webContents.send('launcher-server-failed', `Process exited with code ${code}`)
    }
  })

  // Save command and current URL immediately after launch command is issued.
  writeConfig({ startUrl, launchCommand: cmd })

  return true
})

ipcMain.handle('shell-stop-server', () => {
  killServerProcess()
  return true
})

ipcMain.handle('shell-launcher-open-main', (_e, payload) => {
  const startUrl = String(payload?.startUrl || '').trim()
  const launchCommand = String(payload?.launchCommand || '').trim()
  if (startUrl) {
    writeConfig({ startUrl, launchCommand })
    createMainWindow({ startUrl, launchCommand })
  } else {
    const c = readConfig()
    if (c && c.startUrl) createMainWindow(c)
    else createMainWindow({ startUrl: DEFAULT_START_URL })
  }
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.close()
  }
  return true
})

ipcMain.handle('shell-get-i18n', () => getI18nPayload())

ipcMain.handle('shell-set-locale', (_e, raw) => {
  writeSavedLocale(String(raw || ''))
  buildAppMenu()
  return getI18nPayload()
})

app.whenReady().then(async () => {
  app.setName('Hermes Web UI')
  buildAppMenu()
  const c = readConfig()
  if (c && c.startUrl) {
    const healthy = await checkServerHealth(c.startUrl)
    if (healthy) {
      createMainWindow(c)
    } else {
      createLauncherWindow()
    }
  } else {
    createLauncherWindow()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const c = readConfig()
    if (c && c.startUrl) {
      const healthy = await checkServerHealth(c.startUrl)
      if (healthy) createMainWindow(c)
      else createLauncherWindow()
    } else {
      createLauncherWindow()
    }
  }
})
