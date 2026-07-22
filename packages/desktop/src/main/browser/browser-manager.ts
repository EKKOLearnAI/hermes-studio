import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  BrowserWindow,
  app,
  dialog,
  nativeImage,
  session,
  shell,
  WebContentsView,
  type DownloadItem,
  type Session,
  type WebContents,
} from 'electron'
import { BrowserAutomation } from './browser-automation'
import { BrowserProfileStore } from './browser-profile-store'
import type {
  BrowserAgentControl,
  BrowserBounds,
  BrowserConsoleEntry,
  BrowserInteractAction,
  BrowserProfileSwitchImpact,
  BrowserSelection,
  BrowserSitePermission,
  DesktopBrowserDownload,
  DesktopBrowserProfile,
  DesktopBrowserState,
  DesktopBrowserTab,
} from './browser-types'
import { isAllowedBrowserRequest, isAllowedBrowserSubresource, normalizeBrowserUrl, publicBrowserUrl, redactBrowserText } from './browser-url'

interface TabRecord {
  tab: DesktopBrowserTab
  view: WebContentsView
  console: BrowserConsoleEntry[]
}

const MAX_TABS = 8
const CONSOLE_LIMIT = 500
const ANNOTATION_WORLD_ID = 999
const ANNOTATION_CANCEL_EVENT = '__hermes_browser_cancel_annotation__'

const RISK_DIALOG_COPY = {
  de: ['Agent-Aktion bestätigen', 'Diese Browser-Aktion kann eine wichtige Änderung ausführen:', 'Abbrechen', 'Einmal erlauben'],
  en: ['Confirm Agent action', 'This browser action may perform an important change:', 'Cancel', 'Allow once'],
  es: ['Confirmar acción del Agent', 'Esta acción del navegador puede realizar un cambio importante:', 'Cancelar', 'Permitir una vez'],
  fr: ["Confirmer l’action de l’Agent", 'Cette action du navigateur peut effectuer une modification importante :', 'Annuler', 'Autoriser une fois'],
  ja: ['Agent 操作を確認', 'このブラウザ操作は重要な変更を実行する可能性があります：', 'キャンセル', '今回のみ許可'],
  ko: ['Agent 작업 확인', '이 브라우저 작업은 중요한 변경을 수행할 수 있습니다:', '취소', '한 번 허용'],
  pt: ['Confirmar ação do Agent', 'Esta ação do navegador pode fazer uma alteração importante:', 'Cancelar', 'Permitir uma vez'],
  ru: ['Подтвердите действие Agent', 'Это действие браузера может внести важное изменение:', 'Отмена', 'Разрешить один раз'],
  'zh-TW': ['確認 Agent 操作', '此瀏覽器操作可能會執行重要變更：', '取消', '僅允許這一次'],
  zh: ['确认 Agent 操作', '此浏览器操作可能会执行重要变更：', '取消', '仅允许这一次'],
} as const

function riskDialogCopy(): readonly [string, string, string, string] {
  const locale = app.getLocale().toLowerCase()
  if (locale.startsWith('zh-tw') || locale.startsWith('zh-hk')) return RISK_DIALOG_COPY['zh-TW']
  const language = locale.split('-')[0] as keyof typeof RISK_DIALOG_COPY
  return RISK_DIALOG_COPY[language] || RISK_DIALOG_COPY.en
}

function copyTab(tab: DesktopBrowserTab): DesktopBrowserTab {
  return { ...tab }
}

function nextDownloadPath(directory: string, fileName: string): string {
  const safeFileName = basename(fileName).replace(/[\u0000-\u001f]/g, '_') || 'download'
  const initial = join(directory, safeFileName)
  if (!existsSync(initial)) return initial
  const extension = extname(safeFileName)
  const stem = safeFileName.slice(0, safeFileName.length - extension.length)
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = join(directory, `${stem} (${index})${extension}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(directory, `${stem}-${Date.now()}${extension}`)
}

export class BrowserManager {
  readonly automation = new BrowserAutomation()
  private readonly profileStore: BrowserProfileStore
  private readonly records = new Map<string, TabRecord>()
  private readonly downloads: DesktopBrowserDownload[] = []
  private readonly permissions: BrowserSitePermission[] = []
  private readonly configuredSessions = new Set<string>()
  private readonly automationVisibleTabs = new Set<string>()
  private readonly activeAnnotationTabs = new Set<string>()
  private readonly agentDownloadGuardUntil = new Map<string, number>()
  private readonly stateListeners = new Set<(state: DesktopBrowserState) => void>()
  private activeProfileId = ''
  private activeTabId: string | undefined
  private visible = false
  private bounds: BrowserBounds = { x: 0, y: 0, width: 800, height: 600 }

  constructor(private readonly window: BrowserWindow, stateRoot: string, downloadsRoot: string) {
    this.profileStore = new BrowserProfileStore(stateRoot, downloadsRoot)
  }

  async initialize(): Promise<void> {
    await this.profileStore.initialize()
    const profile = this.profileStore.active()
    this.activeProfileId = profile.id
    await this.restoreTabs(profile)
    this.emitState()
  }

  onStateChange(listener: (state: DesktopBrowserState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  state(): DesktopBrowserState {
    return {
      available: true,
      activeProfileId: this.activeProfileId,
      activeTabId: this.activeTabId,
      tabs: [...this.records.values()].map(record => copyTab(record.tab)),
      profiles: this.profileStore.list(),
      downloads: this.downloads.map(item => ({ ...item })),
      permissions: this.permissions.map(item => ({ ...item })),
      visible: this.visible,
      maxTabs: MAX_TABS,
    }
  }

  setViewport(bounds: BrowserBounds, visible: boolean): DesktopBrowserState {
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    }
    this.visible = visible
    this.syncViews()
    this.emitState()
    return this.state()
  }

  async createTab(url = 'about:blank', activate = true): Promise<DesktopBrowserTab> {
    return this.openTab(url, activate, true)
  }

  private async openTab(url: string, activate: boolean, waitForLoad: boolean): Promise<DesktopBrowserTab> {
    if (this.records.size >= MAX_TABS) throw new Error(`Browser supports at most ${MAX_TABS} tabs per profile`)
    const normalizedUrl = normalizeBrowserUrl(url, { allowBlank: true })
    const profile = this.requireProfile(this.activeProfileId)
    const record = this.buildTab(profile, normalizedUrl)
    this.records.set(record.tab.id, record)
    this.window.contentView.addChildView(record.view)
    if (activate || !this.activeTabId) this.activeTabId = record.tab.id
    this.syncViews()
    const loading = record.view.webContents.loadURL(normalizedUrl).catch(() => {
      record.tab.loading = false
      this.refreshTab(record)
      this.emitState()
    })
    if (waitForLoad) await loading
    await this.persistTabs()
    this.emitState()
    return copyTab(record.tab)
  }

  async closeTab(tabId: string): Promise<DesktopBrowserState> {
    const record = this.requireTab(tabId)
    await this.cancelAnnotation(tabId)
    const ids = [...this.records.keys()]
    const index = ids.indexOf(tabId)
    this.window.contentView.removeChildView(record.view)
    this.automation.detach(tabId, record.view.webContents)
    this.automationVisibleTabs.delete(tabId)
    this.agentDownloadGuardUntil.delete(tabId)
    record.view.webContents.close()
    this.records.delete(tabId)
    if (this.activeTabId === tabId) this.activeTabId = [...this.records.keys()][Math.max(0, index - 1)]
    if (this.records.size === 0) await this.createTab('about:blank', true)
    await this.persistTabs()
    this.syncViews()
    this.emitState()
    return this.state()
  }

  activateTab(tabId: string): DesktopBrowserState {
    this.requireTab(tabId)
    this.activeTabId = tabId
    this.syncViews()
    this.emitState()
    return this.state()
  }

  async navigate(tabId: string, url: string): Promise<DesktopBrowserTab> {
    const record = this.requireTab(tabId)
    const normalized = normalizeBrowserUrl(url)
    await record.view.webContents.loadURL(normalized)
    return copyTab(record.tab)
  }

  async navigationAction(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<DesktopBrowserTab> {
    const record = this.requireTab(tabId)
    const navigation = record.view.webContents.navigationHistory
    if (action === 'back' && navigation.canGoBack()) navigation.goBack()
    else if (action === 'forward' && navigation.canGoForward()) navigation.goForward()
    else if (action === 'reload') record.view.webContents.reload()
    else if (action === 'stop') record.view.webContents.stop()
    return copyTab(record.tab)
  }

  async createProfile(name: string): Promise<DesktopBrowserProfile> {
    const profile = await this.profileStore.create(name)
    this.emitState()
    return profile
  }

  async renameProfile(profileId: string, name: string): Promise<DesktopBrowserProfile> {
    const profile = await this.profileStore.renameProfile(profileId, name)
    this.emitState()
    return profile
  }

  profileSwitchImpact(): BrowserProfileSwitchImpact {
    const pendingAnnotations = this.activeAnnotationTabs.size
    return {
      activeAgentRuns: [...this.records.values()].filter(record => record.tab.agentControl !== 'idle').length,
      activeDownloads: this.downloads.filter(item => item.state === 'progressing').length,
      pendingAnnotations,
      openTabs: this.records.size,
      requiresConfirmation: pendingAnnotations > 0 || this.downloads.some(item => item.state === 'progressing') || [...this.records.values()].some(record => record.tab.agentControl !== 'idle'),
    }
  }

  async switchProfile(profileId: string, force = false): Promise<DesktopBrowserState> {
    if (profileId === this.activeProfileId) return this.state()
    const impact = this.profileSwitchImpact()
    if (impact.requiresConfirmation && !force) throw new Error('Profile switch requires confirmation while an Agent or download is active')
    await Promise.all([...this.activeAnnotationTabs].map(tabId => this.cancelAnnotation(tabId)))
    await this.persistTabs()
    this.destroyViews()
    const profile = await this.profileStore.setActive(profileId)
    this.activeProfileId = profile.id
    await this.restoreTabs(profile)
    this.emitState()
    return this.state()
  }

  async updateProfile(profileId: string, input: { askBeforeDownload?: boolean; downloadConflictPolicy?: 'ask' | 'uniquify' }): Promise<DesktopBrowserProfile> {
    const profile = await this.profileStore.setDownloadPreferences(profileId, input)
    this.emitState()
    return profile
  }

  async deleteProfile(profileId: string): Promise<DesktopBrowserState> {
    if (profileId === this.activeProfileId) throw new Error('Switch away from a profile before deleting it')
    const removed = await this.profileStore.deleteProfile(profileId)
    const managedRoot = resolve(this.profileStore.root, 'profiles')
    if (resolve(removed.sessionPath).startsWith(`${managedRoot}${process.platform === 'win32' ? '\\' : '/'}`)) {
      await shell.trashItem(dirname(removed.sessionPath)).catch(() => undefined)
    }
    this.emitState()
    return this.state()
  }

  async clearProfileData(profileId: string, kind: 'cache' | 'site-data' | 'permission-audit'): Promise<DesktopBrowserState> {
    const profile = this.requireProfile(profileId)
    if (kind === 'permission-audit') {
      for (let index = this.permissions.length - 1; index >= 0; index -= 1) {
        if (this.permissions[index].profileId === profileId) this.permissions.splice(index, 1)
      }
    } else {
      const browserSession = session.fromPath(profile.sessionPath)
      if (kind === 'cache') await browserSession.clearCache()
      else await browserSession.clearStorageData()
      if (profileId === this.activeProfileId) {
        for (const record of this.records.values()) record.view.webContents.reload()
      }
    }
    this.emitState()
    return this.state()
  }

  async chooseDirectory(kind: 'download' | 'session', profileId: string): Promise<DesktopBrowserProfile | null> {
    const profile = this.requireProfile(profileId)
    const result = await dialog.showOpenDialog(this.window, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: kind === 'download' ? profile.downloadPath : profile.sessionPath,
    })
    const pathname = result.canceled ? '' : result.filePaths[0] || ''
    if (!pathname) return null
    const updated = kind === 'download'
      ? await this.profileStore.setDownloadDirectory(profileId, pathname)
      : await this.profileStore.scheduleSessionDirectory(profileId, pathname)
    if (kind === 'download' && profileId === this.activeProfileId) {
      session.fromPath(profile.sessionPath).setDownloadPath(updated.downloadPath)
    }
    this.emitState()
    return updated
  }

  async snapshot(tabId: string) {
    const record = this.requireTab(tabId)
    return this.automation.snapshot(tabId, record.view.webContents)
  }

  async interact(tabId: string, action: BrowserInteractAction): Promise<DesktopBrowserTab> {
    const record = this.requireTab(tabId)
    const risk = this.automation.interactionRisk(tabId, action)
    if (risk) {
      const [title, message, cancel, allow] = riskDialogCopy()
      const previousLabel = record.tab.agentLabel
      this.setAgentControl(tabId, 'waiting-for-user', previousLabel, risk.kind)
      let confirmationTimer: NodeJS.Timeout | undefined
      let result: Awaited<ReturnType<typeof dialog.showMessageBox>>
      try {
        result = await Promise.race([
          dialog.showMessageBox(this.window, {
            type: 'warning',
            title,
            message,
            detail: risk.label,
            buttons: [cancel, allow],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          }),
          new Promise<never>((_resolve, reject) => {
            confirmationTimer = setTimeout(() => reject(new Error('High-risk browser confirmation timed out')), 25_000)
            confirmationTimer.unref?.()
          }),
        ])
      } catch (error) {
        this.setAgentControl(tabId, 'idle')
        throw error
      } finally {
        if (confirmationTimer) clearTimeout(confirmationTimer)
      }
      if (result.response !== 1) {
        this.setAgentControl(tabId, 'idle')
        throw new Error('High-risk browser action was declined by the user')
      }
      this.setAgentControl(tabId, 'active', previousLabel, action.action)
    }
    await this.withAutomationView(record, () => this.automation.interact(tabId, record.view.webContents, action))
    return copyTab(record.tab)
  }

  async screenshot(tabId: string, fullPage = false) {
    const record = this.requireTab(tabId)
    return this.withAutomationView(record, () => this.automation.screenshot(tabId, record.view.webContents, fullPage))
  }

  consoleEntries(tabId: string): BrowserConsoleEntry[] {
    return this.requireTab(tabId).console.map(entry => ({ ...entry }))
  }

  clearConsole(tabId: string): void {
    this.requireTab(tabId).console = []
  }

  setAgentControl(tabId: string, control: BrowserAgentControl, label?: string, action?: string): void {
    const tab = this.requireTab(tabId).tab
    if (control !== 'idle') this.agentDownloadGuardUntil.set(tabId, Date.now() + 5 * 60 * 1000)
    tab.agentControl = control
    tab.agentLabel = label
    tab.agentAction = action
    this.emitState()
  }

  revokeAgentControl(tabId: string): void {
    this.setAgentControl(tabId, 'idle')
  }

  cancelAgentOperation(tabId: string): void {
    const record = this.requireTab(tabId)
    if (record.view.webContents.isLoading()) record.view.webContents.stop()
    this.automation.invalidate(tabId)
    this.revokeAgentControl(tabId)
  }

  async annotate(tabId: string, mode: 'element' | 'region'): Promise<BrowserSelection> {
    const record = this.requireTab(tabId)
    if (this.activeAnnotationTabs.has(tabId)) throw new Error('An annotation is already active in this tab')
    this.visible = true
    this.activeTabId = tabId
    this.syncViews()
    this.activeAnnotationTabs.add(tabId)
    this.emitState()
    try {
      const selected = await record.view.webContents.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD_ID, [{
      code: `new Promise((resolve, reject) => {
        const mode = ${JSON.stringify(mode)};
        const root = document.documentElement;
        const overlay = document.createElement('div');
        const box = document.createElement('div');
        Object.assign(overlay.style, { position:'fixed', inset:'0', zIndex:'2147483647', cursor:'crosshair', background:'rgba(59,130,246,.04)' });
        Object.assign(box.style, { position:'fixed', display:'none', zIndex:'2147483647', pointerEvents:'none', border:'2px solid #3b82f6', background:'rgba(59,130,246,.14)', boxSizing:'border-box' });
        root.append(overlay, box);
        let start = null, moveHandler = null, clickHandler = null;
        const cleanup = () => { overlay.remove(); box.remove(); removeEventListener('keydown', onKey, true); removeEventListener(${JSON.stringify(ANNOTATION_CANCEL_EVENT)}, onCancel, true); if(moveHandler)removeEventListener('mousemove',moveHandler,true); if(clickHandler)removeEventListener('click',clickHandler,true); };
        const draw = r => Object.assign(box.style, { display:'block', left:r.x+'px', top:r.y+'px', width:r.width+'px', height:r.height+'px' });
        const finish = (region, element) => { cleanup(); resolve({ region, element, viewport:{ width:innerWidth, height:innerHeight, scaleFactor:devicePixelRatio || 1 } }); };
        const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); cleanup(); reject(new Error('Annotation cancelled')); } };
        const onCancel = () => { cleanup(); reject(new Error('Annotation cancelled')); };
        addEventListener('keydown', onKey, true);
        addEventListener(${JSON.stringify(ANNOTATION_CANCEL_EVENT)}, onCancel, true);
        if (mode === 'element') {
          const elementBelow = (x, y) => { overlay.style.visibility='hidden'; box.style.visibility='hidden'; const target=document.elementFromPoint(x,y); overlay.style.visibility=''; box.style.visibility=''; return target; };
          moveHandler = event => {
            const target = elementBelow(event.clientX, event.clientY);
            if (!target || target === overlay || target === box) return;
            const r = target.getBoundingClientRect(); draw({ x:r.left, y:r.top, width:r.width, height:r.height });
          };
          clickHandler = event => {
            event.preventDefault(); event.stopImmediatePropagation();
            const target = elementBelow(event.clientX, event.clientY);
            if (!target) return;
            const r = target.getBoundingClientRect();
            const safeIdentifier = value => { const text=String(value||'').slice(0,80); return text && /^[A-Za-z0-9_-]+$/.test(text) && !/(token|secret|password|auth|session|key)/i.test(text) ? text : undefined; };
            finish({ x:r.left, y:r.top, width:r.width, height:r.height }, { role:String(target.getAttribute('role') || '').slice(0,40) || undefined, name:String(target.getAttribute('aria-label') || target.textContent || '').trim().slice(0,120) || undefined, tag:target.tagName.toLowerCase(), id:safeIdentifier(target.id), classNames:[...target.classList].map(safeIdentifier).filter(Boolean).slice(0,8) });
          };
          addEventListener('mousemove', moveHandler, true);
          addEventListener('click', clickHandler, true);
        } else {
          overlay.onpointerdown = event => { start = { x:event.clientX, y:event.clientY }; overlay.setPointerCapture(event.pointerId); };
          overlay.onpointermove = event => { if (!start) return; const x=Math.min(start.x,event.clientX), y=Math.min(start.y,event.clientY); draw({x,y,width:Math.abs(event.clientX-start.x),height:Math.abs(event.clientY-start.y)}); };
          overlay.onpointerup = event => { if (!start) return; const region={x:Math.min(start.x,event.clientX),y:Math.min(start.y,event.clientY),width:Math.abs(event.clientX-start.x),height:Math.abs(event.clientY-start.y)}; if(region.width<4||region.height<4){cleanup();reject(new Error('Selection is too small'));return;} finish(region); };
        }
      })`,
      }], true) as { region: BrowserBounds; element?: BrowserSelection['element']; viewport: BrowserSelection['viewport'] }
      const whole = await this.automation.screenshot(tabId, record.view.webContents, false)
      const image = nativeImage.createFromDataURL(`data:${whole.mediaType};base64,${whole.data}`)
      const imageSize = image.getSize()
      const scaleX = imageSize.width / Math.max(1, selected.viewport.width)
      const scaleY = imageSize.height / Math.max(1, selected.viewport.height)
      const crop = {
        x: Math.max(0, Math.round(selected.region.x * scaleX)),
        y: Math.max(0, Math.round(selected.region.y * scaleY)),
        width: Math.max(1, Math.min(imageSize.width, Math.round(selected.region.width * scaleX))),
        height: Math.max(1, Math.min(imageSize.height, Math.round(selected.region.height * scaleY))),
      }
      crop.width = Math.min(crop.width, imageSize.width - crop.x)
      crop.height = Math.min(crop.height, imageSize.height - crop.y)
      const cropped = image.crop(crop)
      return {
        tabId,
        mode,
        url: publicBrowserUrl(record.tab.url),
        title: redactBrowserText(record.tab.title),
        viewport: selected.viewport,
        region: selected.region,
        element: selected.element ? {
          ...selected.element,
          role: selected.element.role ? redactBrowserText(selected.element.role, 40) : undefined,
          name: selected.element.name ? redactBrowserText(selected.element.name, 120) : undefined,
        } : undefined,
        screenshot: { ...whole, data: cropped.toPNG().toString('base64'), width: crop.width, height: crop.height },
      }
    } finally {
      this.activeAnnotationTabs.delete(tabId)
      this.emitState()
    }
  }

  async cancelAnnotation(tabId: string): Promise<boolean> {
    if (!this.activeAnnotationTabs.has(tabId)) return false
    const record = this.records.get(tabId)
    if (!record || record.view.webContents.isDestroyed()) {
      this.activeAnnotationTabs.delete(tabId)
      return false
    }
    await record.view.webContents.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD_ID, [{
      code: `dispatchEvent(new CustomEvent(${JSON.stringify(ANNOTATION_CANCEL_EVENT)}))`,
    }], true).catch(() => undefined)
    return true
  }

  destroy(): void {
    this.destroyViews()
    this.stateListeners.clear()
  }

  private buildTab(profile: DesktopBrowserProfile, url: string): TabRecord {
    const id = randomUUID()
    const browserSession = session.fromPath(profile.sessionPath, { cache: true })
    this.configureSession(profile, browserSession)
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
      },
    })
    view.setBackgroundColor('#ffffff')
    const tab: DesktopBrowserTab = {
      id,
      profileId: profile.id,
      title: url === 'about:blank' ? 'New Tab' : url,
      url,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      agentControl: 'idle',
    }
    const record: TabRecord = { tab, view, console: [] }
    const contents = view.webContents
    contents.setWindowOpenHandler(details => {
      if (!isAllowedBrowserRequest(details.url)) return { action: 'deny' }
      void this.createTab(details.url, true).catch(error => {
        console.warn('[desktop-browser] failed to open popup:', error)
      })
      return { action: 'deny' }
    })
    contents.on('will-navigate', details => {
      if (!isAllowedBrowserRequest(details.url)) details.preventDefault()
    })
    contents.on('did-start-loading', () => { tab.loading = true; this.automation.invalidate(id); this.emitState() })
    contents.on('did-stop-loading', () => { tab.loading = false; this.refreshTab(record); this.emitState() })
    contents.on('did-fail-load', () => { tab.loading = false; this.refreshTab(record); this.emitState() })
    const persistNavigation = () => { void this.persistTabs().catch(error => console.warn('[desktop-browser] failed to persist tabs:', error)) }
    contents.on('did-navigate', () => { this.refreshTab(record); this.automation.invalidate(id); persistNavigation(); this.emitState() })
    contents.on('did-navigate-in-page', () => { this.refreshTab(record); this.automation.invalidate(id); persistNavigation(); this.emitState() })
    contents.on('page-title-updated', (_event, title) => { tab.title = title || tab.url; this.emitState() })
    contents.on('page-favicon-updated', (_event, favicons) => { tab.faviconUrl = favicons[0]; this.emitState() })
    contents.on('render-process-gone', () => { tab.crashed = true; tab.loading = false; this.emitState() })
    contents.debugger.on('detach', () => {
      this.automation.invalidate(id)
      tab.agentControl = 'idle'
      tab.agentLabel = undefined
      tab.agentAction = undefined
      this.emitState()
    })
    contents.on('console-message', details => {
      const levelNumber = ({ debug: 0, info: 1, warning: 2, error: 3 } as Record<string, number>)[details.level] ?? 1
      record.console.push({ level: levelNumber, message: details.message, line: details.lineNumber, sourceId: details.sourceId, timestamp: new Date().toISOString() })
      if (record.console.length > CONSOLE_LIMIT) record.console.splice(0, record.console.length - CONSOLE_LIMIT)
    })
    return record
  }

  private configureSession(profile: DesktopBrowserProfile, browserSession: Session): void {
    if (this.configuredSessions.has(profile.sessionPath)) return
    this.configuredSessions.add(profile.sessionPath)
    browserSession.setDownloadPath(profile.downloadPath)
    browserSession.setPermissionCheckHandler((contents, permission, origin) => {
      this.recordPermission(profile.id, origin || contents?.getURL() || 'unknown', permission)
      return false
    })
    browserSession.setPermissionRequestHandler((contents, permission, callback) => {
      const origin = (() => { try { return new URL(contents.getURL()).origin } catch { return 'unknown' } })()
      this.recordPermission(profile.id, origin, permission)
      callback(false)
    })
    browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    browserSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedBrowserSubresource(details.url) }))
    browserSession.on('will-download', (_event, item, contents) => {
      item.pause()
      void this.handleDownload(this.requireProfile(profile.id), item, contents).catch(error => {
        item.cancel()
        console.warn('[desktop-browser] failed to prepare download:', error)
      })
    })
  }

  private async handleDownload(profile: DesktopBrowserProfile, item: DownloadItem, contents: WebContents): Promise<void> {
    const record = [...this.records.values()].find(candidate => candidate.view.webContents === contents)
    if (!record || record.tab.profileId !== profile.id) { item.cancel(); return }
    await mkdir(profile.downloadPath, { recursive: true, mode: 0o700 })
    const safeFileName = basename(item.getFilename()).replace(/[\u0000-\u001f]/g, '_') || 'download'
    const basePath = join(profile.downloadPath, safeFileName)
    let savePath = profile.downloadConflictPolicy === 'uniquify' ? nextDownloadPath(profile.downloadPath, safeFileName) : basePath
    if ((this.agentDownloadGuardUntil.get(record.tab.id) || 0) > Date.now() || profile.askBeforeDownload || (profile.downloadConflictPolicy === 'ask' && existsSync(basePath))) {
      const result = await dialog.showSaveDialog(this.window, { defaultPath: savePath })
      if (result.canceled || !result.filePath) { item.cancel(); return }
      savePath = result.filePath
    }
    item.setSavePath(savePath)
    const download: DesktopBrowserDownload = {
      id: randomUUID(), profileId: profile.id, fileName: item.getFilename(), sourceUrl: item.getURL(), savePath,
      receivedBytes: 0, totalBytes: item.getTotalBytes(), state: 'progressing', startedAt: new Date().toISOString(),
    }
    this.downloads.unshift(download)
    item.on('updated', (_event, state) => {
      download.receivedBytes = item.getReceivedBytes()
      download.totalBytes = item.getTotalBytes()
      download.state = state === 'interrupted' ? 'interrupted' : 'progressing'
      this.emitState()
    })
    item.once('done', (_event, state) => { download.receivedBytes = item.getReceivedBytes(); download.state = state; this.emitState() })
    this.emitState()
    item.resume()
  }

  private async restoreTabs(profile: DesktopBrowserProfile): Promise<void> {
    await Promise.all(profile.tabs.slice(0, MAX_TABS).map(url => this.openTab(url, false, false)))
    this.activeTabId = [...this.records.keys()][0]
    this.syncViews()
  }

  private async persistTabs(): Promise<void> {
    if (!this.activeProfileId) return
    await this.profileStore.setTabs(this.activeProfileId, [...this.records.values()].map(record => record.tab.url))
  }

  private refreshTab(record: TabRecord): void {
    const contents = record.view.webContents
    record.tab.url = contents.getURL() || 'about:blank'
    record.tab.title = contents.getTitle() || record.tab.url
    record.tab.canGoBack = contents.navigationHistory.canGoBack()
    record.tab.canGoForward = contents.navigationHistory.canGoForward()
    record.tab.crashed = false
  }

  private syncViews(): void {
    for (const [id, record] of this.records) {
      const userVisible = this.visible && id === this.activeTabId
      if (userVisible) {
        record.view.setBounds(this.bounds)
        record.view.setVisible(true)
      } else if (this.automationVisibleTabs.has(id)) {
        record.view.setBounds({
          x: -Math.max(10_000, this.bounds.width + 100),
          y: -Math.max(10_000, this.bounds.height + 100),
          width: this.bounds.width,
          height: this.bounds.height,
        })
        record.view.setVisible(true)
      } else {
        record.view.setBounds(this.bounds)
        record.view.setVisible(false)
      }
    }
  }

  private async withAutomationView<T>(record: TabRecord, operation: () => Promise<T>): Promise<T> {
    const tabId = record.tab.id
    const alreadyRendering = this.visible && this.activeTabId === tabId
    if (!alreadyRendering) {
      this.automationVisibleTabs.add(tabId)
      this.syncViews()
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    record.view.webContents.focus()
    try {
      return await operation()
    } finally {
      if (!alreadyRendering) {
        this.automationVisibleTabs.delete(tabId)
        this.syncViews()
      }
    }
  }

  private destroyViews(): void {
    for (const [id, record] of this.records) {
      this.window.contentView.removeChildView(record.view)
      this.automation.detach(id, record.view.webContents)
      if (!record.view.webContents.isDestroyed()) record.view.webContents.close()
    }
    this.records.clear()
    this.automationVisibleTabs.clear()
    this.activeAnnotationTabs.clear()
    this.agentDownloadGuardUntil.clear()
    this.activeTabId = undefined
  }

  private requireTab(tabId: string): TabRecord {
    const record = this.records.get(tabId)
    if (!record) throw new Error('Browser tab not found')
    return record
  }

  private requireProfile(profileId: string): DesktopBrowserProfile {
    const profile = this.profileStore.get(profileId)
    if (!profile) throw new Error('Browser profile not found')
    return profile
  }

  private recordPermission(profileId: string, input: string, permission: string): void {
    const origin = (() => { try { return new URL(input).origin } catch { return input.slice(0, 500) || 'unknown' } })()
    const existing = this.permissions.find(item => item.profileId === profileId && item.origin === origin && item.permission === permission)
    if (existing) existing.lastRequestedAt = new Date().toISOString()
    else this.permissions.unshift({ id: randomUUID(), profileId, origin, permission, allowed: false, lastRequestedAt: new Date().toISOString() })
    if (this.permissions.length > 500) this.permissions.length = 500
    this.emitState()
  }

  private emitState(): void {
    const state = this.state()
    for (const listener of this.stateListeners) listener(state)
  }
}
