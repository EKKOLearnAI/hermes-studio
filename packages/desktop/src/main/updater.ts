import { app, dialog } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { t } from './desktop-i18n'

let initialized = false
let checking = false
let updateDownloaded = false

const LATEST_RELEASE_URL = 'https://api.github.com/repos/EKKOLearnAI/hermes-web-ui/releases/latest'
const CLOUDFLARE_DOWNLOAD_BASE_URL = 'https://download.ekkolearnai.com'

interface GitHubRelease {
  tag_name?: string
}

class MissingUpdateInfoError extends Error {
  constructor(public readonly url: string) {
    super(`Update information is not available at ${url}`)
    this.name = 'MissingUpdateInfoError'
  }
}

interface AutoUpdaterOptions {
  beforeQuitAndInstall?: () => void
}

let options: AutoUpdaterOptions = {}

async function getLatestReleaseTag(): Promise<string> {
  const res = await fetch(LATEST_RELEASE_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Hermes-Studio/${app.getVersion()}`,
    },
  })
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`)

  const release = await res.json() as GitHubRelease
  const tag = release.tag_name?.trim()
  if (!tag) throw new Error('Latest release response did not include a tag')
  return tag
}

function updateManifestFile(): string {
  if (process.platform === 'darwin') return 'latest-mac.yml'
  if (process.platform === 'win32') return 'latest.yml'
  return 'latest-linux.yml'
}

async function assertUpdateManifestExists(feedUrl: string): Promise<void> {
  const manifestUrl = `${feedUrl}/${updateManifestFile()}`
  const res = await fetch(manifestUrl, {
    method: 'HEAD',
    headers: {
      'User-Agent': `Hermes-Studio/${app.getVersion()}`,
    },
  })
  if (res.status === 404) throw new MissingUpdateInfoError(manifestUrl)
  if (!res.ok) throw new Error(`Update feed returned ${res.status}`)
}

async function configureFeedFromLatestRelease(): Promise<void> {
  const tag = await getLatestReleaseTag()
  const feedUrl = `${CLOUDFLARE_DOWNLOAD_BASE_URL}/${tag}`
  await assertUpdateManifestExists(feedUrl)
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: feedUrl,
  })
}

function showUpToDate(info?: UpdateInfo) {
  const version = info?.version || app.getVersion()
  dialog.showMessageBox({
    type: 'info',
    title: t('update.upToDateTitle'),
    message: t('update.upToDateMessage'),
    detail: t('update.currentVersion', { version }),
    buttons: [t('common.ok')],
  }).catch(() => undefined)
}

function showUpdateCheckFailed(err: unknown) {
  const isMissingUpdateInfo = err instanceof MissingUpdateInfoError
  dialog.showMessageBox({
    type: isMissingUpdateInfo ? 'info' : 'error',
    title: isMissingUpdateInfo ? t('update.upToDateTitle') : t('update.failedTitle'),
    message: isMissingUpdateInfo ? t('update.noUpdateInfoMessage') : t('update.failedMessage'),
    buttons: [t('common.ok')],
  }).catch(() => undefined)
}

export function initAutoUpdater(nextOptions: AutoUpdaterOptions = {}) {
  options = { ...options, ...nextOptions }
  if (initialized) return
  initialized = true

  if (!app.isPackaged) return // dev mode: skip

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', info => {
    console.log(`[updater] update available: ${info.version}`)
    dialog.showMessageBox({
      type: 'info',
      title: t('update.availableTitle'),
      message: t('update.availableMessage', { version: info.version }),
      detail: t('update.downloading'),
      buttons: [t('common.ok')],
    }).catch(() => undefined)
  })
  autoUpdater.on('update-not-available', info => {
    console.log('[updater] up to date')
    if (checking) showUpToDate(info)
  })
  autoUpdater.on('error', err => {
    console.error('[updater] error:', err)
    if (checking) showUpdateCheckFailed(err)
  })
  autoUpdater.on('download-progress', (info: ProgressInfo) => {
    console.log(`[updater] download ${Math.round(info.percent)}%`)
  })
  autoUpdater.on('update-downloaded', async (info: UpdateDownloadedEvent) => {
    updateDownloaded = true
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: t('update.readyTitle'),
      message: t('update.readyMessage', { version: info.version }),
      detail: t('update.readyDetail'),
      buttons: [t('update.restartNow'), t('update.later')],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      options.beforeQuitAndInstall?.()
      autoUpdater.quitAndInstall()
    }
  })

  if (process.env.HERMES_DESKTOP_ENABLE_AUTO_UPDATE !== 'false') {
    checkForDesktopUpdates(false).catch(err => {
      console.error('[updater] initial check failed:', err)
    })
  }

  // Recheck every 6h while app is running
  setInterval(() => {
    checkForDesktopUpdates(false).catch(() => undefined)
  }, 6 * 60 * 60 * 1000)
}

export async function checkForDesktopUpdates(manual: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: t('update.checkingTitle'),
        message: t('update.packagedOnlyMessage'),
        buttons: [t('common.ok')],
      })
    }
    return
  }

  if (updateDownloaded) {
    options.beforeQuitAndInstall?.()
    autoUpdater.quitAndInstall()
    return
  }

  if (manual) {
    await dialog.showMessageBox({
      type: 'info',
      title: t('update.checkingTitle'),
      message: t('update.checkingMessage'),
      buttons: [t('common.ok')],
    })
  }

  checking = manual
  try {
    await configureFeedFromLatestRelease()
    await autoUpdater.checkForUpdates()
  } catch (err) {
    if (manual) showUpdateCheckFailed(err)
    throw err
  } finally {
    checking = false
  }
}
