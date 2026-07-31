import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const now = Math.floor(Date.now() / 1000)
const tasks = Array.from({ length: 12 }, (_, index) => ({
  id: `task-${index + 1}`,
  title: `Canvas task ${index + 1}`,
  body: `Task body ${index + 1}`,
  assignee: 'research',
  status: 'todo',
  priority: 2,
  created_by: null,
  created_at: now + index,
  started_at: null,
  completed_at: null,
  workspace_kind: 'local',
  workspace_path: null,
  tenant: null,
  result: null,
  skills: null,
}))

test('keeps canvas task lists scrollable and task cards clickable', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.route(/\/api\/hermes\/kanban(?:\/|\?|$)/, async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    const taskMatch = pathname.match(/^\/api\/hermes\/kanban\/(task-\d+)$/)

    if (pathname === '/api/hermes/kanban/boards') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          boards: [{
            slug: 'default',
            name: 'Default',
            description: '',
            icon: '',
            color: '',
            created_at: now,
            archived: false,
            is_current: true,
            counts: { todo: tasks.length },
            total: tasks.length,
          }],
        }),
      })
      return
    }

    if (pathname === '/api/hermes/kanban/capabilities') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ capabilities: { source: 'hermes-cli', supports: {}, missing: [] } }),
      })
      return
    }

    if (pathname === '/api/hermes/kanban/stats') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          stats: {
            by_status: { todo: tasks.length },
            by_assignee: { research: tasks.length },
            total: tasks.length,
          },
        }),
      })
      return
    }

    if (pathname === '/api/hermes/kanban/assignees') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ assignees: [{ name: 'research', on_disk: true, counts: { todo: tasks.length } }] }),
      })
      return
    }

    if (/^\/api\/hermes\/kanban\/task-\d+\/attachments$/.test(pathname)) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ attachments: [] }),
      })
      return
    }

    if (taskMatch) {
      const task = tasks.find(item => item.id === taskMatch[1])
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          task,
          latest_summary: null,
          comments: [],
          events: [],
          runs: [],
          parents: [],
          children: [],
        }),
      })
      return
    }

    if (pathname === '/api/hermes/kanban') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ tasks }),
      })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `Unexpected Kanban route: ${request.method()} ${pathname}` }),
    })
  })

  await page.goto('/#/hermes/kanban')

  const taskList = page.locator('.status-todo .task-list')
  await expect(taskList).toBeVisible()
  const dimensions = await taskList.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)

  await taskList.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => taskList.evaluate(element => element.scrollTop)).toBeGreaterThan(0)

  const taskCard = page.getByRole('button', { name: 'Canvas task 12' })
  expect(await taskCard.evaluate(element => element.draggable)).toBe(false)
  await taskCard.click()
  await expect(page.locator('.n-drawer').getByText('Canvas task 12', { exact: true })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})
