import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

test('browses, creates, and deletes profile-scoped skill bundles', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    bundles: [
      {
        name: 'PR Review Team',
        commandName: 'pr-review-team',
        description: 'Review pull requests from several angles',
        skills: ['github-pr-review', 'security-review'],
      },
    ],
    skills: {
      categories: [
        {
          name: 'review',
          description: '',
          skills: [
            { name: 'github-pr-review', description: 'Review pull requests', enabled: true },
            { name: 'security-review', description: 'Review security risks', enabled: true },
          ],
        },
      ],
      archived: [],
    },
  })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')

  const input = page.getByPlaceholder(inputPlaceholder)
  await input.fill('/bundles')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByText('/bundles pr-review-team', { exact: true })).toBeVisible()
  await expect(page.getByText(/github-pr-review, security-review/)).toBeVisible()

  await page.getByRole('button', { name: 'Create Bundle' }).click()
  const creator = page.locator('.n-modal').filter({ hasText: 'Create Skill Bundle' })
  await expect(creator).toBeVisible()
  const nameInput = creator.locator('.n-form-item').filter({ hasText: /^Name/ }).locator('input')
  await nameInput.fill('代码审查')
  await expect(nameInput).toHaveValue('')
  await nameInput.fill('Release Team')

  const skillsField = creator.locator('.n-form-item').filter({ hasText: /^Skills/ })
  await skillsField.locator('.n-base-selection').click()
  const githubOption = page.locator('.n-base-select-option:visible').filter({ hasText: /^github-pr-review$/ })
  await expect(githubOption).toBeVisible()
  await githubOption.click({ force: true })
  await skillsField.locator('.n-base-selection').click()
  const securityOption = page.locator('.n-base-select-option:visible').filter({ hasText: /^security-review$/ })
  await expect(securityOption).toBeVisible()
  await securityOption.click({ force: true })
  await page.keyboard.press('Escape')
  await creator.getByRole('button', { name: 'Create', exact: true }).click()

  await expect(input).toHaveValue('/bundles release-team ')
  expect(api.requests.some(request =>
    request.method === 'POST' &&
    request.pathname === '/api/hermes/bundles' &&
    request.search === '?profile=research' &&
    JSON.parse(request.postData || '{}').skills.length === 2,
  )).toBe(true)

  await input.fill('/bundles')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByRole('button', { name: 'Delete PR Review Team', exact: true }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(page.getByText('/bundles pr-review-team', { exact: true })).toHaveCount(0)
  expect(api.requests.some(request =>
    request.method === 'DELETE' &&
    request.pathname === '/api/hermes/bundles/pr-review-team' &&
    request.search === '?profile=research',
  )).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})
