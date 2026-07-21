import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

type DesktopPlatform = 'darwin' | 'linux' | 'win32'

async function installDesktopBridge(page: Page, platform: DesktopPlatform) {
  await page.addInitScript((desktopPlatform) => {
    const state = { actions: [] as string[], isMaximized: false }
    ;(window as typeof window & { __PW_DESKTOP_WINDOW__?: typeof state }).__PW_DESKTOP_WINDOW__ = state
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        isDesktop: true,
        platform: desktopPlatform,
        getWindowState: async () => ({ isMaximized: state.isMaximized }),
        windowControl: async (action: string) => {
          state.actions.push(action)
          if (action === 'toggle-maximize') state.isMaximized = !state.isMaximized
          return { isMaximized: state.isMaximized }
        },
      },
    })
  }, platform)
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

test('places Windows controls inside the page header without a logo title bar', async ({ page }) => {
  await openDesktopJobs(page, 'win32')

  const controls = page.locator('.desktop-titlebar')
  const header = page.locator('.page-header')
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
  expect(headerBox!.y).toBe(11)
  expect(controlsBox!.y).toBeGreaterThanOrEqual(headerBox!.y)
  expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height)
  await expect(header).toHaveCSS('padding-right', '158px')
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

  await expect(page.locator('.chat-panel > .session-list > .page-sidebar-top')).toHaveCSS('padding-top', '12px')
})

test('keeps Linux on native chrome and preserves its original sidebar spacing', async ({ page }) => {
  await openDesktopJobs(page, 'linux')

  await expect(page.locator('.desktop-titlebar')).toHaveCount(0)
  expect((await page.locator('.app-layout').boundingBox())?.y).toBe(0)
  expect((await page.locator('aside.sidebar').boundingBox())?.y).toBe(10)
  await expect(page.locator('aside.sidebar')).toHaveCSS('padding-top', '8px')
  await expect.poll(() => topGutterDragRegion(page)).toEqual({ appRegion: 'none', height: 'auto' })
})
