import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('disables and re-enables a skill with a long title from the skills list', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const skill = {
    name: 'review-a-very-long-skill-name-that-overflows-the-sidebar',
    description: 'A long title must leave the enable switch visible.',
    enabled: true,
    source: 'local',
  }
  const api = await mockHermesApi(page, {
    skills: { categories: [{ name: 'tools', description: '', skills: [skill] }], archived: [] },
  })
  const updates: boolean[] = []
  await page.route('**/api/hermes/write-gate/pending', route => route.fulfill({
    json: { supported: false, records: [] },
  }))
  await page.route('**/api/hermes/skills/tools/**', route => route.fulfill({
    json: route.request().url().endsWith('/files') ? { files: [] } : { content: '# Test skill' },
  }))
  await page.route('**/api/hermes/skills/toggle', async route => {
    expect(route.request().method()).toBe('PUT')
    const body = route.request().postDataJSON()
    expect(body.name).toBe(skill.name)
    skill.enabled = body.enabled
    updates.push(body.enabled)
    await route.fulfill({ json: { ok: true } })
  })

  await page.goto('/#/hermes/skills')
  const toggle = page.locator('.skill-item').filter({ hasText: skill.name }).getByRole('switch')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(updates).toEqual([false, true])
  expect(api.unexpectedRequests).toEqual([])
})
