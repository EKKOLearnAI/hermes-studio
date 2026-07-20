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

  const workHeader = page.locator('.session-group-header').filter({ hasText: 'Work' })
  await expect(workHeader).toBeVisible()
  await expect(workHeader.locator('.session-group-count')).toHaveText('2')
  await expect(page.locator('.session-group-header').filter({ hasText: 'Empty' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Project Alpha/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Project Beta/ })).toBeVisible()

  await workHeader.click()
  await expect(page.getByText('Project Alpha', { exact: true })).toBeHidden()
  await expect(page.getByText('Project Beta', { exact: true })).toBeHidden()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hermes_chat_collapsed_categories')))
    .toContain('category-1')

  await page.reload()
  await expect(page.locator('.session-group-header').filter({ hasText: 'Work' })).toBeVisible()
  await expect(page.getByText('Project Alpha', { exact: true })).toBeHidden()
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
  })
  const api = await mockHermesApi(page, {
    sessionCategories: [{ id: 1, name: 'Work' }],
    sessions: [sessionSummary('work-session', 'Project Alpha', 1, 100)],
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

  const renamedHeader = page.locator('.session-group-header').filter({ hasText: 'Client Work' })
  await renamedHeader.click({ button: 'right' })
  await page.getByText('Delete category', { exact: true }).click()
  const deleteDialog = page.getByRole('dialog').filter({ hasText: 'Delete category' })
  await expect(deleteDialog).toContainText('Its sessions will move to Uncategorized')
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(page.getByText('Category deleted')).toBeVisible()
  await expect(page.locator('.session-group-header').filter({ hasText: 'Client Work' })).toHaveCount(0)
  await expect(page.locator('.session-group-header').filter({ hasText: 'Uncategorized' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Project Alpha/ })).toBeVisible()
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
  })
  const api = await mockHermesApi(page, {
    sessionCategories: [{ id: 1, name: 'Work' }],
    sessions: [sessionSummary('general-session', 'General Notes', null, 100)],
  })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  await page.getByRole('link', { name: /General Notes/ }).click({ button: 'right' })
  await page.locator('.n-dropdown-option').filter({ hasText: 'Move to category' }).hover()
  await page.locator('.n-dropdown-option').filter({ hasText: /^Work$/ }).click()

  await expect(page.getByText('Category updated')).toBeVisible()
  await expect(page.locator('.session-group-header').filter({ hasText: 'Work' })).toBeVisible()
  await expect(page.getByRole('link', { name: /General Notes/ })).toBeVisible()
  const moveRequest = api.requests.find(request =>
    request.method === 'POST' && request.pathname === '/api/hermes/sessions/general-session/category',
  )
  expect(JSON.parse(moveRequest?.postData || '{}')).toEqual({ categoryId: 1 })
})
