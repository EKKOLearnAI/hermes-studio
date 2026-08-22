import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

function sessionSummary(
  id: string,
  title: string,
  categoryId: number | null,
  lastActive: number,
  profile = 'research',
) {
  return {
    id,
    profile,
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    title,
    preview: title,
    started_at: lastActive - 10,
    ended_at: null,
    last_active: lastActive,
    message_count: 1,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: 'estimated',
    category_id: categoryId,
  }
}

async function waitForRun(page: Page) {
  const handle = await page.waitForFunction(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    return state?.emitted?.find((item: any) => item.event === 'run')?.payload || null
  })
  return handle.jsonValue() as Promise<any>
}

test('groups sessions by category and persists collapsed groups', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    if (localStorage.getItem('hermes_chat_collapsed_categories') === null) {
      localStorage.setItem('hermes_chat_collapsed_categories', '[]')
    }
  })
  await mockHermesApi(page, {
    sessionCategories: [{ id: 1, name: 'Work' }, { id: 2, name: 'Empty' }],
    sessions: [
      sessionSummary('work-session', 'Project Alpha', 1, 100),
      sessionSummary('default-work-session', 'Project Beta', 1, 90, 'default'),
      sessionSummary('uncategorized-session', 'General Notes', null, 200),
    ],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  const recentHeader = page.locator('.session-group-header').filter({ hasText: 'Recent' })
  const recentToggle = recentHeader.locator('.session-group-toggle')
  await expect(recentHeader).toBeVisible()
  await expect(recentHeader.locator('.session-group-count')).toHaveText('3')
  await expect(page.locator('.session-group-header').first()).toContainText('Recent')
  const workHeader = page.locator('.session-group-header').filter({ hasText: 'Work' })
  await expect(workHeader).toBeVisible()
  await expect(workHeader.locator('.session-group-count')).toHaveText('2')
  await expect(page.locator('.session-group-header').filter({ hasText: 'Uncategorized' })).toBeVisible()
  await expect(page.locator('.session-group-header').filter({ hasText: 'Empty' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Project Alpha/ }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /Project Beta/ }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /Project Alpha/ }).first().locator('.session-item-category-tag')).toHaveText('Work')
  await expect(page.getByRole('link', { name: /General Notes/ }).first().locator('.session-item-category-tag')).toHaveText('Uncategorized')
  await expect(page.getByRole('link', { name: /Project Alpha/ }).last().locator('.session-item-category-tag')).toHaveCount(0)

  await expect(recentToggle).toHaveAttribute('aria-expanded', 'true')
  await recentToggle.press('Enter')
  await expect(recentToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('link', { name: /Project Alpha/ }).first()).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hermes_recent_sessions_collapsed_v1'))).toBe('true')

  await recentToggle.press(' ')
  await expect(recentToggle).toHaveAttribute('aria-expanded', 'true')

  await recentHeader.locator('.session-group-config').click()
  const recentDialog = page.getByRole('dialog').filter({ hasText: 'Recent session count' })
  await recentDialog.locator('input').fill('2')
  await recentDialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(recentHeader.locator('.session-group-count')).toHaveText('2')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hermes_recent_session_count_v1'))).toBe('2')
  await expect(workHeader).toBeVisible()
  await expect(workHeader.locator('.session-group-count')).toHaveText('2')
  await expect(recentToggle).toHaveAttribute('aria-expanded', 'true')

  await workHeader.click()
  await expect(page.getByText('Project Alpha', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Project Beta', { exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hermes_chat_collapsed_categories')))
    .toContain('category-1')

  await page.reload()
  await expect(page.locator('.session-group-header').filter({ hasText: 'Work' })).toBeVisible()
  await expect(page.getByText('Project Alpha', { exact: true })).toHaveCount(1)
  await expect(recentHeader.locator('.session-group-count')).toHaveText('2')
})

test('persists the collapsed recent group across reloads without changing the active session', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, {
    sessionCategories: [{ id: 1, name: 'Work' }],
    sessions: [
      sessionSummary('work-session', 'Project Alpha', 1, 200),
      sessionSummary('notes-session', 'General Notes', null, 100),
    ],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/session/work-session')
  const recentHeader = page.locator('.session-group-header').filter({ hasText: 'Recent' })
  const recentToggle = recentHeader.locator('.session-group-toggle')
  await expect(page.getByRole('link', { name: /Project Alpha/ }).first()).toHaveAttribute('aria-current', 'page')

  await recentToggle.click()
  await expect(recentToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page).toHaveURL(/\/hermes\/session\/work-session$/)

  await page.reload()
  await expect(recentToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page).toHaveURL(/\/hermes\/session\/work-session$/)
  await expect(page.getByRole('link', { name: /Project Alpha/ })).toHaveCount(1)
})

test('hides the entire recent group from settings and restores its saved count', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    localStorage.setItem('hermes_recent_session_count_v1', '2')
  })
  await mockHermesApi(page, {
    sessionCategories: [{ id: 1, name: 'Work' }],
    sessions: [
      sessionSummary('latest-session', 'Latest Notes', null, 300),
      sessionSummary('work-session', 'Project Alpha', 1, 200),
      sessionSummary('older-session', 'Older Notes', null, 100),
    ],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  const recentHeader = page.locator('.session-group-header--recent')
  await expect(recentHeader).toBeVisible()
  await expect(recentHeader.locator('.session-group-count')).toHaveText('2')

  await page.goto('/#/hermes/settings?tab=session')
  const recentVisibilityRow = page.locator('.setting-row').filter({ hasText: 'Show recent sessions' })
  await expect(recentVisibilityRow).toBeVisible()
  await recentVisibilityRow.locator('.n-switch').click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hermes_show_recent_sessions_v1'))).toBe('false')

  await page.goto('/#/hermes/chat')
  await expect(recentHeader).toHaveCount(0)
  await expect(page.locator('.session-group-config')).toHaveCount(0)
  const workHeader = page.locator('.session-group-header').filter({ hasText: 'Work' })
  const uncategorizedHeader = page.locator('.session-group-header').filter({ hasText: 'Uncategorized' })
  await expect(workHeader.locator('.session-group-count')).toHaveText('1')
  await expect(uncategorizedHeader.locator('.session-group-count')).toHaveText('2')
  await expect(page.getByRole('link', { name: /Latest Notes/ })).toHaveCount(1)
  await workHeader.click()
  await expect(page.getByRole('link', { name: /Project Alpha/ })).toHaveCount(1)
  await expect(page.getByRole('link', { name: /Older Notes/ })).toHaveCount(1)

  await page.reload()
  await expect(recentHeader).toHaveCount(0)

  const settingsPage = await page.context().newPage()
  await authenticate(settingsPage, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(settingsPage)
  await settingsPage.goto('/#/hermes/settings?tab=session')
  await settingsPage.locator('.setting-row')
    .filter({ hasText: 'Show recent sessions' })
    .locator('.n-switch')
    .click()
  await expect.poll(() => settingsPage.evaluate(() => localStorage.getItem('hermes_show_recent_sessions_v1'))).toBe('true')
  await settingsPage.close()

  await page.reload()
  await expect(recentHeader).toBeVisible()
  await expect(recentHeader.locator('.session-group-count')).toHaveText('2')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hermes_recent_session_count_v1'))).toBe('2')
})

test('creates a category in the new chat selector and sends its id with the first run', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat' }).click()

  const categoryField = page.locator('.new-chat-field').filter({ hasText: /^Category/ })
  await categoryField.locator('.n-base-selection').click()
  await page.keyboard.type('Client Work')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Category "Client Work" created')).toBeVisible()

  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('Prepare the weekly summary')
  await page.getByRole('button', { name: 'Send' }).click()

  const run = await waitForRun(page)
  expect(run.category_id).toBe(1)
  expect(api.requests.some(request =>
    request.method === 'POST' &&
    request.pathname === '/api/hermes/session-categories' &&
    JSON.parse(request.postData || '{}').name === 'Client Work',
  )).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('renames and deletes a category from its context menu', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    localStorage.setItem('hermes_chat_collapsed_categories', '[]')
    localStorage.setItem('hermes_recent_session_count_v1', '2')
  })
  const api = await mockHermesApi(page, {
    sessionCategories: [{ id: 1, name: 'Work' }],
    sessions: [
      sessionSummary('recent-session', 'Latest Notes', null, 200),
      sessionSummary('work-session', 'Project Alpha', 1, 100),
    ],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  const workHeader = page.locator('.session-group-header').filter({ hasText: 'Work' })
  await workHeader.click({ button: 'right' })
  await page.getByText('Rename category', { exact: true }).click()
  const renameDialog = page.getByRole('dialog').filter({ hasText: 'Rename category' })
  await renameDialog.getByRole('textbox').fill('Client Work')
  await renameDialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(page.getByText('Category renamed')).toBeVisible()
  await expect(page.locator('.session-group-header').filter({ hasText: 'Client Work' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Project Alpha/ }).first().locator('.session-item-category-tag')).toHaveText('Client Work')

  const renamedHeader = page.locator('.session-group-header').filter({ hasText: 'Client Work' })
  await renamedHeader.click({ button: 'right' })
  await page.getByText('Delete category', { exact: true }).click()
  const deleteDialog = page.getByRole('dialog').filter({ hasText: 'Delete category' })
  await expect(deleteDialog).toContainText('Its sessions will move to Uncategorized')
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(page.getByText('Category deleted')).toBeVisible()
  await expect(page.locator('.session-group-header').filter({ hasText: 'Client Work' })).toHaveCount(0)
  await expect(page.locator('.session-group-header').filter({ hasText: 'Uncategorized' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Project Alpha/ }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /Project Alpha/ }).first().locator('.session-item-category-tag')).toHaveText('Uncategorized')
  expect(api.requests.some(request =>
    request.method === 'PATCH' && request.pathname === '/api/hermes/session-categories/1',
  )).toBe(true)
  expect(api.requests.some(request =>
    request.method === 'DELETE' && request.pathname === '/api/hermes/session-categories/1',
  )).toBe(true)
})

test('moves a session to another category from its context menu', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    localStorage.setItem('hermes_chat_collapsed_categories', '[]')
    localStorage.setItem('hermes_recent_session_count_v1', '2')
  })
  const api = await mockHermesApi(page, {
    sessionCategories: [{ id: 1, name: 'Work' }],
    sessions: [
      sessionSummary('recent-session', 'Latest Notes', null, 200),
      sessionSummary('general-session', 'General Notes', null, 100),
    ],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  await page.getByRole('link', { name: /General Notes/ }).last().click({ button: 'right' })
  await page.locator('.n-dropdown-option').filter({ hasText: 'Move to category' }).hover()
  const uncategorizedOption = page.locator('.n-dropdown-option:visible')
    .filter({ hasText: /^Uncategorized$/ })
    .locator(':scope > .n-dropdown-option-body')
  await expect(uncategorizedOption).toHaveClass(/n-dropdown-option-body--disabled/)
  const workOption = page.locator('.n-dropdown-option:visible')
    .filter({ hasText: /^Work$/ })
    .locator(':scope > .n-dropdown-option-body')
  await expect(workOption).toBeVisible()
  // A pointer move can cross a sibling menu item and replace this submenu
  // before Playwright clicks it. Click the already-visible option directly.
  await workOption.evaluate((element: HTMLElement) => element.click())

  await expect(page.getByText('Category updated')).toBeVisible()
  await expect(page.locator('.session-group-header').filter({ hasText: 'Work' })).toBeVisible()
  await expect(page.getByRole('link', { name: /General Notes/ }).first()).toBeVisible()
  const moveRequest = api.requests.find(request =>
    request.method === 'POST' && request.pathname === '/api/hermes/sessions/general-session/category',
  )
  expect(JSON.parse(moveRequest?.postData || '{}')).toEqual({ categoryId: 1 })

  await page.getByRole('link', { name: /General Notes/ }).first().click({ button: 'right' })
  await page.locator('.n-dropdown-option').filter({ hasText: 'Move to category' }).hover()
  await expect(page.locator('.n-dropdown-option:visible')
    .filter({ hasText: /^Work$/ })
    .locator(':scope > .n-dropdown-option-body'))
    .toHaveClass(/n-dropdown-option-body--disabled/)
  await expect(page.getByRole('link', { name: /General Notes/ }).first().locator('.session-item-category-tag')).toHaveText('Work')
})

test('uses the same current-category disabled state after a mobile-style long press', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, {
    sessionCategories: [{ id: 1, name: 'Work' }],
    sessions: [sessionSummary('work-session', 'Project Alpha', 1, 100)],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  const sessionLink = page.getByRole('link', { name: /Project Alpha/ }).first()
  await sessionLink.evaluate((element) => {
    const event = new Event('touchstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: [{ clientX: 120, clientY: 120 }],
    })
    element.dispatchEvent(event)
  })

  await page.locator('.n-dropdown-option').filter({ hasText: 'Move to category' }).hover()
  await expect(page.locator('.n-dropdown-option:visible')
    .filter({ hasText: /^Work$/ })
    .locator(':scope > .n-dropdown-option-body'))
    .toHaveClass(/n-dropdown-option-body--disabled/)

  await sessionLink.evaluate((element) => {
    element.dispatchEvent(new Event('touchend', { bubbles: true }))
  })
})

test('shows category load failure and retries instead of presenting an empty menu', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  let attempts = 0
  await mockHermesApi(page, {
    sessionCategories: [{ id: 1, name: 'Work' }],
    sessions: [sessionSummary('general-session', 'General Notes', null, 100)],
  })
  await page.route('**/api/hermes/session-categories', async route => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }
    attempts += 1
    if (attempts === 1) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'failed' }) })
      return
    }
    await route.fallback()
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  const failure = page.locator('.session-category-load-error')
  await expect(failure).toContainText('Failed to load categories')
  await expect(page.getByRole('link', { name: /General Notes/ }).first().locator('.session-item-category-tag')).toHaveCount(0)

  await page.getByRole('link', { name: /General Notes/ }).first().click({ button: 'right' })
  await page.locator('.n-dropdown-option').filter({ hasText: 'Move to category' }).hover()
  await expect(page.locator('.n-dropdown-option:visible').filter({ hasText: /^Failed to load categories$/ })).toBeVisible()
  await failure.getByRole('button', { name: 'Retry' }).click()

  await expect(failure).toHaveCount(0)
  await expect(page.getByRole('link', { name: /General Notes/ }).first().locator('.session-item-category-tag')).toHaveText('Uncategorized')
  expect(attempts).toBe(2)

  await page.getByRole('link', { name: /General Notes/ }).first().click({ button: 'right' })
  await page.locator('.n-dropdown-option').filter({ hasText: 'Move to category' }).hover()
  await expect(page.locator('.n-dropdown-option:visible').filter({ hasText: /^Work$/ })).toBeVisible()
})
