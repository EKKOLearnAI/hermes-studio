import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

type DesktopPlatform = 'darwin' | 'linux' | 'win32'
type DesktopWindowKind = 'main' | 'chat'

async function installDesktopBridge(page: Page, platform: DesktopPlatform, withBrowser = false, windowKind: DesktopWindowKind = 'main') {
  await page.addInitScript(({ desktopPlatform, includeBrowser, desktopWindowKind }) => {
    const state = {
      actions: [] as string[],
      isMaximized: false,
      chatWindows: [] as Array<{ sessionId: string; profile?: string }>,
    }
    ;(window as typeof window & { __PW_DESKTOP_WINDOW__?: typeof state }).__PW_DESKTOP_WINDOW__ = state
    const browserState = {
      available: true,
      activeProfileId: 'profile-default',
      activeTabId: 'tab-1',
      tabs: [{
        id: 'tab-1', profileId: 'profile-default', title: 'New Tab', url: 'about:blank',
        loading: false, canGoBack: false, canGoForward: false, crashed: false, agentControl: 'idle',
      }],
      profiles: [{
        id: 'profile-default', name: 'Default', rootPath: '/tmp/hermes-browser', sessionPath: '/tmp/hermes-browser/data',
        downloadPath: '/tmp/hermes-browser/download', proxyMode: 'direct', proxyRules: '', askBeforeDownload: true,
        downloadConflictPolicy: 'uniquify', createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-01-01T00:00:00.000Z', tabs: ['tab-1'],
      }, {
        id: 'profile-work', name: 'Work', rootPath: '/tmp/hermes-browser-work', sessionPath: '/tmp/hermes-browser-work/data',
        downloadPath: '/tmp/hermes-browser-work/download', proxyMode: 'system', proxyRules: '', askBeforeDownload: false,
        downloadConflictPolicy: 'uniquify', createdAt: '2026-01-02T00:00:00.000Z',
        lastUsedAt: '2026-01-02T00:00:00.000Z', tabs: [],
      }],
      downloads: [{
        id: 'download-1', profileId: 'profile-default', fileName: 'report.pdf', sourceUrl: 'https://example.test/report.pdf',
        savePath: '/tmp/hermes-browser/download/report.pdf', receivedBytes: 25, totalBytes: 100,
        state: 'progressing', startedAt: '2026-01-03T00:00:00.000Z',
      }], permissions: [], visible: false, maxTabs: 8,
    }
    const browserHarness = {
      viewportCalls: [] as Array<{ bounds: unknown; visible: boolean }>,
      annotationCount: 0,
      clearAnnotationCalls: 0,
      captureAnnotationCalls: 0,
      annotationNotes: {} as Record<number, string>,
      requestAnnotation: undefined as undefined | ((request: { tabId: string; mode: 'element' | 'region' }) => void),
    }
    ;(window as typeof window & { __PW_DESKTOP_BROWSER__?: typeof browserHarness }).__PW_DESKTOP_BROWSER__ = browserHarness
    const browser = includeBrowser ? {
      getState: async () => browserState,
      setViewport: async (bounds: unknown, visible: boolean) => {
        browserHarness.viewportCalls.push({ bounds, visible })
        browserState.visible = visible
        return browserState
      },
      createTab: async () => browserState.tabs[0],
      closeTab: async () => browserState,
      activateTab: async () => browserState,
      navigate: async () => browserState.tabs[0],
      navigationAction: async () => browserState.tabs[0],
      createProfile: async () => browserState.profiles[0],
      chooseProfileRootDirectory: async () => '/tmp/hermes-browser-new',
      renameProfile: async () => browserState.profiles[0],
      profileSwitchImpact: async () => ({ activeAgentRuns: 0, activeDownloads: 0, pendingAnnotations: 0, openTabs: 1, requiresConfirmation: false }),
      switchProfile: async (profileId: string) => { browserState.activeProfileId = profileId; return { ...browserState } },
      updateProfile: async () => browserState.profiles[0],
      deleteProfile: async () => browserState,
      clearProfileData: async () => browserState,
      cancelDownload: async (downloadId: string) => {
        const download = browserState.downloads.find(item => item.id === downloadId)
        if (download) download.state = 'cancelled'
        return { ...browserState, downloads: browserState.downloads.map(item => ({ ...item })) }
      },
      takeOver: async () => true,
      annotate: async (_tabId: string, mode: 'element' | 'region') => {
        browserHarness.annotationCount += 1
        const marker = browserHarness.annotationCount
        return {
          tabId: 'tab-1', marker, mode, url: 'about:blank', title: 'New Tab',
          viewport: { width: 800, height: 600, scaleFactor: 1 },
          region: marker === 1 ? { x: 160, y: 120, width: 240, height: 90 } : { x: 480, y: 300, width: 160, height: 120 },
          screenshot: { mediaType: 'image/png', data: '', width: 800, height: 600 },
        }
      },
      cancelAnnotation: async () => true,
      updateAnnotationNote: async (_tabId: string, marker: number, note: string) => {
        browserHarness.annotationNotes[marker] = note
        return true
      },
      captureAnnotations: async () => {
        browserHarness.captureAnnotationCalls += 1
        return { mediaType: 'image/png', data: '', width: 800, height: 600 }
      },
      clearAnnotations: async () => { browserHarness.clearAnnotationCalls += 1; return true },
      onAnnotationRequest: (callback: (request: { tabId: string; mode: 'element' | 'region' }) => void) => {
        browserHarness.requestAnnotation = callback
        return () => { if (browserHarness.requestAnnotation === callback) browserHarness.requestAnnotation = undefined }
      },
      onStateChange: () => () => undefined,
    } : undefined
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        isDesktop: true,
        platform: desktopPlatform,
        windowKind: desktopWindowKind,
        getWindowState: async () => ({ isMaximized: state.isMaximized }),
        windowControl: async (action: string) => {
          state.actions.push(action)
          if (action === 'toggle-maximize') state.isMaximized = !state.isMaximized
          return { isMaximized: state.isMaximized }
        },
        openChatWindow: async (sessionId: string, profile?: string) => {
          state.chatWindows.push({ sessionId, profile })
        },
        ...(browser ? { browser } : {}),
      },
    })
  }, { desktopPlatform: platform, includeBrowser: withBrowser, desktopWindowKind: windowKind })
}

async function openDesktopJobs(page: Page, platform: DesktopPlatform) {
  await installDesktopBridge(page, platform)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await page.goto('/#/hermes/jobs')
  await expect(page.getByRole('heading', { name: 'Scheduled Jobs' })).toBeVisible()
}

async function topGutterDragRegion(page: Page) {
  return page.locator('.app-shell').evaluate((shell) => {
    const style = getComputedStyle(shell, '::before')
    return {
      appRegion: style.getPropertyValue('-webkit-app-region'),
      height: style.height,
    }
  })
}

async function openDesktopPageSidebar(page: Page, platform: DesktopPlatform, path: string) {
  await installDesktopBridge(page, platform)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.goto(path)
}

test('places Windows controls in a dedicated bar above main content', async ({ page }) => {
  await openDesktopJobs(page, 'win32')

  const controls = page.locator('.desktop-titlebar')
  const header = page.locator('.page-header')
  const sidebar = page.locator('aside.sidebar')
  await expect(controls).toBeVisible()
  await expect(controls.locator('.desktop-window-btn')).toHaveCount(3)
  await expect(controls.locator('img')).toHaveCount(0)
  await expect(controls).not.toContainText('Hermes Studio')

  const [controlsBox, headerBox] = await Promise.all([
    controls.boundingBox(),
    header.boundingBox(),
  ])
  expect(controlsBox).not.toBeNull()
  expect(headerBox).not.toBeNull()
  expect(controlsBox!.y).toBe(10)
  expect(headerBox!.y).toBe(51)
  expect(controlsBox!.y + controlsBox!.height).toBeLessThan(headerBox!.y)
  expect(controlsBox!.x).toBeGreaterThanOrEqual((await sidebar.boundingBox())!.x + (await sidebar.boundingBox())!.width)
  await expect(header).toHaveCSS('padding-right', '20px')
  await expect.poll(() => topGutterDragRegion(page)).toEqual({ appRegion: 'drag', height: '10px' })

  await controls.locator('.desktop-window-btn').nth(1).click()
  await expect(controls.getByRole('button', { name: 'Restore' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __PW_DESKTOP_WINDOW__?: { actions: string[] } }
  ).__PW_DESKTOP_WINDOW__?.actions)).toEqual(['toggle-maximize'])
})

test('reserves the macOS traffic-light area inside the primary sidebar', async ({ page }) => {
  await openDesktopJobs(page, 'darwin')

  await expect(page.locator('.desktop-titlebar')).toHaveCount(0)
  expect((await page.locator('.app-layout').boundingBox())?.y).toBe(0)
  expect((await page.locator('aside.sidebar').boundingBox())?.y).toBe(10)
  await expect(page.locator('aside.sidebar')).toHaveCSS('padding-top', '40px')
  await expect.poll(() => topGutterDragRegion(page)).toEqual({ appRegion: 'drag', height: '10px' })
})

test('keeps chat gutters while placing New below macOS traffic lights', async ({ page }) => {
  await openDesktopPageSidebar(page, 'darwin', '/#/hermes/chat')

  const chatSidebar = page.locator('.chat-panel > .session-list')
  const newChat = chatSidebar.locator('.page-sidebar-tab').first()
  await expect(newChat).toBeVisible()
  expect((await chatSidebar.boundingBox())?.y).toBe(10)
  expect((await newChat.boundingBox())?.y).toBeGreaterThanOrEqual(43)

  await page.goto('/#/hermes/group-chat')
  const groupSidebar = page.locator('.group-chat-panel > .room-sidebar')
  const newRoom = groupSidebar.locator('.page-sidebar-tab').first()
  await expect(newRoom).toBeVisible()
  expect((await groupSidebar.boundingBox())?.y).toBe(10)
  expect((await newRoom.boundingBox())?.y).toBeGreaterThanOrEqual(43)
})

test('renders a native-chrome desktop chat route with only messages and input', async ({ page }) => {
  const session = {
    id: 'desktop-chat-1',
    title: 'Focused Desktop Chat',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    profile: 'research',
    started_at: 1_800_000_000,
    ended_at: null,
    last_active: 1_800_000_100,
    message_count: 0,
  }
  await installDesktopBridge(page, 'darwin', false, 'chat')
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    ;(window as typeof window & { __PW_CHAT_SOCKET_RESUMES__?: Record<string, unknown> }).__PW_CHAT_SOCKET_RESUMES__ = {
      'desktop-chat-1': {
        session_id: 'desktop-chat-1',
        messages: [],
        isWorking: false,
        messageLoadedCount: 0,
        messageTotal: 0,
      },
    }
  })
  await mockChatSocket(page)
  await mockHermesApi(page, { sessions: [session] })
  await page.goto('/#/desktop-chat/desktop-chat-1?profile=research')

  await expect(page.locator('.desktop-titlebar')).toHaveCount(0)
  await expect.poll(() => topGutterDragRegion(page)).toEqual({ appRegion: 'drag', height: '46px' })
  await expect(page.locator('.message-list-shell')).toBeVisible()
  await expect(page.locator('.chat-input-area')).toBeVisible()
  await expect(page.locator('.session-list')).toHaveCount(0)
  await expect(page.locator('.chat-header')).toHaveCount(0)
  await expect(page.locator('aside.sidebar')).toHaveCount(0)
})

test('routes the desktop session popup action to the native chat window bridge', async ({ page }) => {
  const session = {
    id: 'desktop-popup-1',
    title: 'Popup Session',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    profile: 'research',
    started_at: 1_800_000_000,
    ended_at: null,
    last_active: 1_800_000_100,
    message_count: 0,
  }
  await installDesktopBridge(page, 'darwin')
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    ;(window as typeof window & { __PW_CHAT_SOCKET_RESUMES__?: Record<string, unknown> }).__PW_CHAT_SOCKET_RESUMES__ = {
      'desktop-popup-1': {
        session_id: 'desktop-popup-1',
        messages: [],
        isWorking: false,
        messageLoadedCount: 0,
        messageTotal: 0,
      },
    }
  })
  await mockChatSocket(page)
  await mockHermesApi(page, { sessions: [session] })
  await page.goto('/#/hermes/chat')

  await page.locator('.session-item').first().click({ button: 'right' })
  await page.getByText('Open in new window', { exact: true }).click()

  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __PW_DESKTOP_WINDOW__?: { chatWindows: Array<{ sessionId: string; profile?: string }> }
    }
  ).__PW_DESKTOP_WINDOW__?.chatWindows)).toEqual([
    { sessionId: 'desktop-popup-1', profile: 'research' },
  ])
})

test('keeps the larger top gutter on macOS workflow pages', async ({ page }) => {
  await openDesktopPageSidebar(page, 'darwin', '/#/hermes/workflow')

  const workflowSidebar = page.locator('.workflow-view > .workflow-sidebar')
  const workflowMain = page.locator('.workflow-view > .workflow-main')
  await expect(workflowMain).toBeVisible()
  expect((await workflowSidebar.boundingBox())?.y).toBe(10)
  expect((await workflowMain.boundingBox())?.y).toBe(10)
})

test('does not reserve macOS traffic-light spacing in Windows chat sidebars', async ({ page }) => {
  await openDesktopPageSidebar(page, 'win32', '/#/hermes/chat')

  const sidebar = page.locator('.chat-panel > .session-list')
  const sidebarTop = page.locator('.chat-panel > .session-list > .page-sidebar-top')
  const newChat = sidebarTop.locator('.page-sidebar-tab').first()
  const main = page.locator('.chat-panel > .chat-main')
  const controls = page.locator('.desktop-titlebar')
  await expect(sidebarTop).toHaveCSS('padding-top', '12px')
  await expect(sidebarTop).toHaveCSS('-webkit-app-region', 'drag')
  await expect(newChat).toHaveCSS('-webkit-app-region', 'no-drag')
  expect((await sidebar.boundingBox())?.y).toBe(10)
  expect((await main.boundingBox())?.y).toBe(50)
  expect((await controls.boundingBox())!.x).toBeGreaterThanOrEqual((await sidebar.boundingBox())!.x + (await sidebar.boundingBox())!.width)
})

test('keeps Linux on native chrome and preserves its original sidebar spacing', async ({ page }) => {
  await openDesktopJobs(page, 'linux')

  await expect(page.locator('.desktop-titlebar')).toHaveCount(0)
  expect((await page.locator('.app-layout').boundingBox())?.y).toBe(0)
  expect((await page.locator('aside.sidebar').boundingBox())?.y).toBe(10)
  await expect(page.locator('aside.sidebar')).toHaveCSS('padding-top', '8px')
  await expect.poll(() => topGutterDragRegion(page)).toEqual({ appRegion: 'none', height: 'auto' })
})

test('embeds the desktop browser beside workspace and terminal', async ({ page }) => {
  await installDesktopBridge(page, 'darwin', true)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.goto('/#/hermes/chat')

  await page.locator('.header-tool-toggle').click()
  const toolPanel = page.locator('.chat-tool-panel')
  await expect(toolPanel.locator('.chat-tool-tab')).toHaveText(['Workspace', 'Terminal', 'Browser'])

  await toolPanel.getByRole('tab', { name: 'Browser' }).click()
  await expect(toolPanel.locator('.browser-panel')).toBeVisible()
  await expect(toolPanel.locator('.native-viewport')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(true)

  const profileSwitcher = toolPanel.getByTestId('browser-profile-switcher')
  await expect(profileSwitcher).toContainText('Default')
  await toolPanel.getByRole('button', { name: 'Downloads' }).click()
  const downloadPopover = page.locator('.download-popover')
  await expect(downloadPopover).toContainText('report.pdf')
  await expect(downloadPopover).toContainText('25%')
  await downloadPopover.getByRole('button', { name: 'Cancel' }).click()
  await expect(downloadPopover).toContainText('Cancelled')
  await expect(downloadPopover.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
  await toolPanel.getByRole('button', { name: 'Downloads' }).click()

  await profileSwitcher.click()
  await page.locator('.n-base-select-option').filter({ hasText: 'Work' }).click()
  await expect(profileSwitcher).toContainText('Work')
  await profileSwitcher.click()
  await page.locator('.n-base-select-option').filter({ hasText: 'Default' }).click()
  await expect(profileSwitcher).toContainText('Default')

  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(page.locator('.new-chat-drawer')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.locator('.new-chat-drawer')).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(true)

  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.className = 'image-preview-overlay'
    overlay.dataset.browserImagePreviewTest = 'true'
    Object.assign(overlay.style, { position: 'fixed', inset: '0' })
    document.body.appendChild(overlay)
  })
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(false)
  await page.evaluate(() => document.querySelector('[data-browser-image-preview-test]')?.remove())
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(true)

  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.className = 'n-modal-body-wrapper'
    overlay.dataset.browserOverlayTest = 'true'
    Object.assign(overlay.style, { position: 'fixed', inset: '0' })
    document.body.appendChild(overlay)
  })
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(false)
  await page.evaluate(() => document.querySelector('[data-browser-overlay-test]')?.remove())
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(true)

  await page.evaluate(() => {
    const harness = (window as typeof window & {
      __PW_DESKTOP_BROWSER__?: { requestAnnotation?: (request: { tabId: string; mode: 'element' | 'region' }) => void }
    }).__PW_DESKTOP_BROWSER__
    harness?.requestAnnotation?.({ tabId: 'tab-1', mode: 'element' })
  })
  await expect(toolPanel.locator('.annotation-editor')).toBeVisible()
  await expect(toolPanel.locator('.annotation-popover')).toBeVisible()
  await expect(toolPanel.locator('.annotation-preview')).toHaveCSS('--annotation-left', '20%')
  await expect(toolPanel.locator('.annotation-preview')).toHaveCSS('--annotation-bottom', '35%')
  await expect(page.locator('.chat-input-area .attachment-preview')).toHaveCount(0)
  const firstNote = toolPanel.locator('.annotation-editor textarea')
  await firstNote.fill('Make this button more prominent')
  await firstNote.blur()
  await expect(toolPanel.locator('.annotation-editor')).toHaveCount(0)
  await expect(toolPanel.locator('.annotation-session-bar')).toContainText('1 annotation')
  await expect(toolPanel.locator('.native-viewport')).toBeVisible()
  await page.evaluate(() => {
    const harness = (window as typeof window & {
      __PW_DESKTOP_BROWSER__?: { requestAnnotation?: (request: { tabId: string; mode: 'element' | 'region' }) => void }
    }).__PW_DESKTOP_BROWSER__
    harness?.requestAnnotation?.({ tabId: 'tab-1', mode: 'region' })
  })
  await expect(toolPanel.locator('.annotation-popover')).toContainText('Annotation 2')
  await toolPanel.locator('.annotation-editor textarea').fill('Keep this card aligned with annotation one')
  await toolPanel.locator('.annotation-session-bar').getByRole('button', { name: 'Send' }).click()
  await expect(toolPanel.locator('.annotation-session-bar')).toHaveCount(0)
  await expect(page.locator('.chat-input-area .attachment-preview.image')).toHaveCount(1)
  await expect(page.locator('.chat-input-area textarea')).toHaveValue('')
  const selectionData = page.locator('.chat-input-area .attachment-context')
  await expect(selectionData).not.toHaveAttribute('open', '')
  await selectionData.locator('summary').click()
  await expect(selectionData).toHaveAttribute('open', '')
  await expect(selectionData.locator('pre')).toContainText('browser_selection')
  await expect(selectionData.locator('pre')).toContainText('Make this button more prominent')
  await expect(selectionData.locator('pre')).toContainText('Keep this card aligned with annotation one')
  await expect(selectionData.locator('pre')).toContainText('"marker": 2')
  await expect.poll(() => page.evaluate(() => {
    const harness = (window as typeof window & {
      __PW_DESKTOP_BROWSER__?: { annotationNotes: Record<number, string>; captureAnnotationCalls: number }
    }).__PW_DESKTOP_BROWSER__
    return { notes: harness?.annotationNotes, captures: harness?.captureAnnotationCalls }
  })).toEqual({
    notes: { 1: 'Make this button more prominent', 2: 'Keep this card aligned with annotation one' },
    captures: 1,
  })

  await toolPanel.getByRole('tab', { name: 'Workspace' }).click()
  await expect(toolPanel.locator('.browser-panel')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as typeof window & { __PW_DESKTOP_BROWSER__?: { viewportCalls: Array<{ visible: boolean }> } }).__PW_DESKTOP_BROWSER__?.viewportCalls || []
    return calls.at(-1)?.visible
  })).toBe(false)

  await page.goto('/#/hermes/browser')
  await expect(page.locator('.browser-settings-page')).toBeVisible()
  await expect(page.locator('.browser-settings-page .native-viewport')).toHaveCount(0)
})

test('manages desktop browser profiles with switchable cards and editor modals', async ({ page }) => {
  await installDesktopBridge(page, 'darwin', true)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await page.goto('/#/hermes/browser')

  await expect(page.getByRole('heading', { name: 'Browser' })).toBeVisible()
  const profileCard = page.locator('.profile-card')
  await expect(profileCard).toHaveCount(2)
  await expect(profileCard.first()).toContainText('Default')
  await expect(profileCard.first()).toContainText('Active profile')

  await profileCard.first().getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('dialog')).toContainText('Edit profile')
  await expect(page.getByRole('dialog').locator('input').first()).toHaveValue('Default')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: 'Add profile' }).click()
  await expect(page.getByRole('dialog')).toContainText('Add profile')
  await page.getByRole('dialog').getByPlaceholder('Profile name').fill('Work')
  const createButton = page.getByRole('dialog').getByRole('button', { name: 'Create' })
  await expect(createButton).toBeDisabled()
  await page.getByRole('dialog').getByTestId('choose-browser-profile-root').click()
  await expect(page.getByRole('dialog')).toContainText('/tmp/hermes-browser-new/data')
  await expect(page.getByRole('dialog')).toContainText('/tmp/hermes-browser-new/download')
  await expect(createButton).toBeEnabled()
})
