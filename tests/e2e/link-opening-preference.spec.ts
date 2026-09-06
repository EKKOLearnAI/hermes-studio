import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

async function installDesktopBridge(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        isDesktop: true,
        platform: 'darwin',
        windowKind: 'main',
        getWindowState: async () => ({ isMaximized: false }),
        windowControl: async () => ({ isMaximized: false }),
      },
    })
  })
}

test('persists the desktop link-opening destination', async ({ page }) => {
  await installDesktopBridge(page)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/settings?tab=display')

  const select = page.getByTestId('link-open-target-select')
  await expect(page.getByText('Open web links in', { exact: true })).toBeVisible()
  await expect(select).toHaveAttribute('aria-label', 'Open web links in')
  await expect(select).toContainText('Hermes Studio')

  await select.locator('.n-base-selection-label').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Default browser', { exact: true }).last()).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')

  await expect.poll(() => page.evaluate(() => (
    window.localStorage.getItem('hermes_link_open_target')
  ))).toBe('default-browser')
  await expect(select).toContainText('Default browser')

  await page.reload()
  await expect(page.getByTestId('link-open-target-select')).toContainText('Default browser')
  expect(api.unexpectedRequests).toEqual([])
})

test('does not show the shell-specific preference in the Web UI', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.goto('/#/hermes/settings?tab=display')

  await expect(page.getByTestId('link-open-target-select')).toHaveCount(0)
  await expect(page.getByText('Open web links in', { exact: true })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})
