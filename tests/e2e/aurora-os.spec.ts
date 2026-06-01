import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, mockTerminalWebSocket, TEST_ACCESS_KEY } from './fixtures'

const launcherInputPlaceholder = 'What would you like to build or do today?'
const standardInputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'
const inputPlaceholder = /^(What would you like to build or do today\?|Type a message\.\.\. \(Enter to send, Shift\+Enter for new line\))$/

function getOmniInput(page: Page) {
  return page.getByPlaceholder(inputPlaceholder)
}

async function openAurora(page: Page, options: { sessions?: unknown[]; resumes?: Record<string, unknown> } = {}) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  if (options.resumes) {
    await page.addInitScript((resumes) => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = resumes
    }, options.resumes)
  }
  const api = await mockHermesApi(page, { sessions: options.sessions })
  await mockChatSocket(page)
  await mockTerminalWebSocket(page)
  await page.goto('/#/hermes/chat')
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  return api
}

async function sendOmniIntent(page: Page, message: string) {
  const input = getOmniInput(page)
  await expect(input).toBeVisible()
  await input.fill(message)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function waitForRun(page: Page, index = 0) {
  const handle = await page.waitForFunction((runIndex) => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const runs = state?.emitted?.filter((item: any) => item.event === 'run') || []
    const run = runs[runIndex]
    return run
      ? {
          run: run.payload,
          emitted: state.emitted,
        }
      : null
  }, index)
  return handle.jsonValue() as Promise<any>
}

function makeSession(id: string, title: string, lastActive: number) {
  return {
    id,
    source: 'api_server',
    model: 'test-model',
    provider: 'test-provider',
    title,
    preview: title,
    started_at: lastActive - 120,
    ended_at: null,
    last_active: lastActive,
    message_count: 0,
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
    workspace: null,
  }
}

test('retires the legacy Advanced Console from the Aurora default surface', async ({ page }) => {
  const api = await openAurora(page)

  await expect(page.getByRole('button', { name: 'Advanced Console', exact: true })).toHaveCount(0)
  await expect(page.locator('.advanced-console-toggle')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Aurora System', exact: true }).click()
  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('System Status')
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByLabel('Aurora Tools Dock')).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps the retired legacy console closed after reload and App Mode close cycles', async ({ page }) => {
  const api = await openAurora(page)

  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  await expect(page.getByLabel('Aurora Tools Dock')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.reload()
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  await expect(page.getByLabel('Aurora Tools Dock')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await sendOmniIntent(page, 'open quant paper trading')
  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('Quant Lab')
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)
  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await sendOmniIntent(page, '打開 LIFE OS')
  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('LifeOS')
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)
  await page.locator('.close-app-button').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('Aurora idle exposes core Hermes controls through the top bar and OmniBar palettes', async ({ page }) => {
  const api = await openAurora(page)

  await expect(page.getByLabel('Model Selector')).toBeVisible()
  await expect(page.getByRole('button', { name: 'System Status', exact: true })).toBeVisible()
  await expect(page.getByLabel('User Menu')).toBeVisible()
  const toolsDock = page.getByLabel('Aurora Tools Dock')
  await expect(toolsDock).toBeVisible()
  await expect(toolsDock).toContainText('Files')
  await expect(toolsDock).toContainText('Calendar')
  await expect(toolsDock).toContainText('Mail')
  await expect(toolsDock).toContainText('Memory')
  await expect(toolsDock).toContainText('Chart')
  await expect(toolsDock).toContainText('Sandbox')
  await expect(toolsDock).not.toContainText('LifeOS')
  await expect(toolsDock).not.toContainText('Quant')
  await expect(page.getByRole('complementary', { name: 'Neural Memory' })).toBeVisible()
  await expect(page.getByLabel('Return to Aurora Desktop')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.getByLabel('Model Selector').click()
  await expect(page.getByText('Test Provider')).toBeVisible()

  await page.getByLabel('User Menu').click()
  const userMenu = page.locator('.user-menu')
  await expect(userMenu.getByRole('button', { name: 'Settings Preferences' })).toBeVisible()
  await expect(userMenu.getByRole('button', { name: 'Gateways Providers' })).toBeVisible()
  await expect(userMenu.getByRole('button', { name: 'Logout Clear access key' })).toBeVisible()
  await expect(userMenu).not.toContainText('Hub')
  await expect(userMenu).not.toContainText('中轉站')

  await page.getByLabel('Aurora App Menu').click()
  const appMenu = page.getByLabel('Aurora App Menu List')
  await expect(appMenu).toBeVisible()
  await expect(appMenu.getByRole('button', { name: 'Unpin LifeOS' })).toBeVisible()
  await appMenu.getByRole('button', { name: 'Pin Memory' }).click()
  await expect(appMenu.getByRole('button', { name: 'Unpin Memory' })).toBeVisible()
  await expect(appMenu).toContainText('Pinned')
  const pinnedApps = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('aurora.launcher.pinned-apps.v2.research') || '[]'),
  )
  expect(pinnedApps).toContain('memory')

  const desktopDownloadPromise = page.waitForEvent('download')
  await appMenu.getByRole('button', { name: 'Export' }).click()
  const desktopDownload = await desktopDownloadPromise
  expect(desktopDownload.suggestedFilename()).toContain('aurora-desktop-research')

  await appMenu.locator('input[type="file"]').setInputFiles({
    name: 'aurora-desktop-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      source: 'Aurora OS Desktop Config',
      schemaVersion: 1,
      pinnedApps: ['memory', 'logs'],
    })),
  })
  await expect(appMenu).toContainText('Imported 2 pinned apps for research.')
  await expect(appMenu.getByRole('button', { name: 'Unpin Logs' })).toBeVisible()
  const importedPinnedApps = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('aurora.launcher.pinned-apps.v2.research') || '[]'),
  )
  expect(importedPinnedApps).toEqual(['memory', 'logs'])

  const presets = appMenu.getByLabel('Aurora Desktop Presets')
  await presets.getByRole('button', { name: 'Apply Market desktop preset' }).click()
  await expect(appMenu).toContainText('Applied Market desktop preset.')
  const presetPinnedApps = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('aurora.launcher.pinned-apps.v2.research') || '[]'),
  )
  expect(presetPinnedApps).toEqual(['quant-lab', 'mirofish', 'logs'])
  expect(api.requests.some(request =>
    request.pathname === '/api/hermes/profiles/research/aurora-preferences' && request.method === 'GET',
  )).toBe(true)
  expect(api.requests.some(request =>
    request.pathname === '/api/hermes/profiles/research/aurora-preferences' && request.method === 'PUT',
  )).toBe(true)

  const input = getOmniInput(page)
  await input.fill('@')
  await expect(page.getByLabel('Agent Summon Palette')).toBeVisible()
  await page.getByText('@quant Quant Lab').click()
  await expect(input).toHaveValue('@quant ')

  await input.fill('/')
  const slashPalette = page.getByLabel('Skills and Plugins Palette')
  await expect(slashPalette).toBeVisible()
  await expect(slashPalette).toContainText('/skill:aurora-memory-governance')
  await expect(slashPalette).toContainText('/plugin:aurora-sandbox')
  await expect(slashPalette).not.toContainText('hub-hidden-skill')
  await slashPalette.getByText('/skill:aurora-memory-governance').click()
  await expect(input).toHaveValue('/skill:aurora-memory-governance ')
  expect(api.unexpectedRequests).toEqual([])
})

test('Aurora status panel exposes the command coverage matrix', async ({ page }) => {
  const api = await openAurora(page)

  await page.getByRole('button', { name: 'System Status', exact: true }).click()
  const matrix = page.getByLabel('Aurora Command Coverage Matrix')
  await expect(matrix).toBeVisible()
  await expect(matrix).toContainText('Command Coverage')
  await expect(matrix).toContainText('16/17 Aurora ready')
  await expect(matrix).toContainText('LifeOS')
  await expect(matrix).toContainText('Quant Lab')
  await expect(matrix).toContainText('MiroFish')
  await expect(matrix).toContainText('Agents / Channels')
  await expect(matrix).toContainText('Group Chat App Mode')
  await expect(matrix).toContainText('Task Widget + Kanban App')
  await expect(matrix).toContainText('Hub / Proxy')
  await expect(matrix).toContainText('Retired from Aurora surface')
  await expect(matrix).toContainText('Legacy')

  await matrix.getByRole('button', { name: 'Open Agents / Channels coverage app' }).click()
  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('Group Chat')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('Group Chat command center')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('Aurora Review Room')
  await expect(page.locator('.group-chat-panel')).toContainText('Aurora Review Room')
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('Aurora golden path wires Browser context, Neural Events, MiroFish, and cancellable Build Mode', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'open https://example.com')
  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('Aurora Web Sandbox')
  await expect(page.getByText('OpenClaw context')).toBeVisible()
  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)

  await page.getByRole('button', { name: 'System Status', exact: true }).click()
  const neuralPanel = page.getByLabel('Aurora Neural Events')
  await expect(neuralPanel).toBeVisible()
  await expect(neuralPanel).toContainText('Neural Events')
  await expect(neuralPanel).toContainText('APP_OPENED')
  await expect(neuralPanel).toContainText('PAGE_ANALYZED')
  await expect(neuralPanel).toContainText('example.com')
  await neuralPanel.getByRole('button', { name: 'Context Lock On' }).click()
  await expect(neuralPanel).toContainText('Context RAM paused')
  await neuralPanel.getByRole('button', { name: 'Clear Context' }).click()
  await expect(neuralPanel).toContainText('No active on-screen context captured yet.')
  await page.getByRole('button', { name: 'Close' }).click()

  await sendOmniIntent(page, '推演 NVDA')
  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.getByText('MiroFish Grand Merge')).toBeVisible()
  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)

  await page.getByRole('tab', { name: 'Build' }).click()
  await getOmniInput(page).fill('Build a cancel-safe widget')
  await page.getByRole('button', { name: 'Build' }).click()
  await expect(page.getByText('Vibe Coding Pipeline')).toBeVisible()
  await expect(page.getByText('Security Alert: Agent requests Terminal execution.')).toBeVisible({ timeout: 9000 })
  await page.getByRole('button', { name: 'Reject' }).click()
  await expect(page.getByText('Vibe Coding Pipeline')).toHaveCount(0, { timeout: 4000 })

  expect(api.requests.some(request => request.pathname === '/api/aurora/vibe-build')).toBe(true)
  expect(api.requests.some(request => request.pathname === '/api/hermes/quant-lab/run-mirofish')).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('CmdK history palette loads recent sessions from the OmniBar', async ({ page }) => {
  const sessions = [
    makeSession('history-newer', 'Newer Aurora Session', 1779940000),
    makeSession('history-older', 'Older Quant Session', 1779930000),
  ]
  const api = await openAurora(page, {
    sessions,
    resumes: {
      'history-newer': { session_id: 'history-newer', isWorking: false, messages: [], inputTokens: 0, outputTokens: 0 },
      'history-older': { session_id: 'history-older', isWorking: false, messages: [], inputTokens: 0, outputTokens: 0 },
    },
  })

  await page.keyboard.press('Control+K')
  const palette = page.getByLabel('Chat History Palette')
  await expect(palette).toBeVisible()
  await expect(palette).toContainText('Newer Aurora Session')
  await expect(palette).toContainText('Older Quant Session')

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const emitted = (window as any).__PW_CHAT_SOCKET__?.emitted || []
    return emitted.some((item: any) => item.event === 'resume' && item.payload?.session_id === 'history-older')
  })
  expect(api.unexpectedRequests).toEqual([])
})

test('falls back to the standard Hermes chat stream when no Aurora tool matches', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'general fallback smoke')
  const { run } = await waitForRun(page)

  expect(run.input).toBe('general fallback smoke')
  await expect(page.getByText('Aurora Legacy Bridge')).toHaveCount(0)
  await expect(page.locator('p').filter({ hasText: /^general fallback smoke$/ })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('renders L4 terminal approvals above the shell and writes rejection back to context', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'standard chat before terminal approval')
  const { run } = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('approval.requested', {
      event: 'approval.requested',
      session_id: sid,
      approval_id: 'approval-terminal-smoke',
      command: 'bash -lc "cat ~/.ssh/config"',
      description: 'Security smoke test for L4 terminal interception.',
      choices: ['once', 'deny'],
      tool: 'terminal',
      security_level: 'L4_Locked',
    })
  }, run.session_id)

  const approvalConfirm = page.getByRole('dialog', { name: 'Security Alert: Agent requests Terminal execution.' })
  await expect(approvalConfirm).toBeVisible()
  await expect(approvalConfirm).toContainText('bash -lc "cat ~/.ssh/config"')

  const zIndex = await page.locator('.security-confirm-backdrop').evaluate((el) => getComputedStyle(el).zIndex)
  expect(Number(zIndex)).toBeGreaterThanOrEqual(5100)

  await approvalConfirm.getByRole('button', { name: 'Reject' }).click()
  await expect(page.getByText('System: Tool execution rejected by user.')).toBeVisible()

  await page.getByRole('button', { name: 'System Status', exact: true }).click()
  const audit = page.getByLabel('Intent Audit Log')
  await expect(audit).toBeVisible()
  await expect(audit).toContainText('bash -lc "cat ~/.ssh/config"')
  await expect(audit).toContainText('rejected')
  await audit.getByRole('button', { name: /Open audit event bash -lc "cat ~\/\.ssh\/config"/ }).first().click()
  const auditDetail = page.getByLabel('Intent Audit Event Detail')
  await expect(auditDetail).toBeVisible()
  await auditDetail.getByRole('button', { name: 'Replay Intent' }).click()
  const replayConfirm = page.getByRole('dialog', { name: 'Confirm high-risk replay' })
  await expect(replayConfirm).toBeVisible()
  await expect(replayConfirm).toContainText('bash -lc "cat ~/.ssh/config"')
  await expect(replayConfirm.getByRole('button', { name: 'Confirm Replay' })).toBeVisible()
  await replayConfirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(replayConfirm).toHaveCount(0)
  await auditDetail.getByRole('button', { name: 'Close' }).click()

  const emitted = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted)
  expect(emitted).toContainEqual({
    event: 'approval.respond',
    payload: {
      session_id: run.session_id,
      approval_id: 'approval-terminal-smoke',
      choice: 'deny',
    },
  })
  expect(api.unexpectedRequests).toEqual([])
})

test('opens Aurora apps from the compact top bar during active chat', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'general fallback smoke')
  await waitForRun(page)
  await expect(page.getByPlaceholder(standardInputPlaceholder)).toBeVisible()

  await page.getByLabel('Aurora App Menu').click()
  const appMenu = page.getByLabel('Aurora App Menu List')
  await expect(appMenu).toBeVisible()
  await appMenu.getByRole('button', { name: 'Open LifeOS from Top Bar' }).click()

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('LifeOS')
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('Vibe Build mode halts at Step 08 until explicit approval or rejection', async ({ page }) => {
  const api = await openAurora(page)

  await page.getByRole('tab', { name: 'Build' }).click()
  await getOmniInput(page).fill('build a tiny Aurora polish patch')
  await page.getByRole('button', { name: 'Build' }).click()

  await expect(page.getByText('Vibe Coding Pipeline')).toBeVisible()
  await expect(page.getByText('A glassmorphic Pomodoro widget with focus, break, and progress states.')).toBeVisible()
  await expect(page.getByText('No blocked patterns found. Security report is empty.')).toBeVisible()
  await expect(page.getByText('Security Alert: Agent requests Terminal execution.')).toBeVisible({ timeout: 9000 })
  await expect(page.getByRole('button', { name: 'Working' })).toBeDisabled()

  await page.getByRole('button', { name: 'Reject' }).click()
  await expect(page.locator('p').filter({ hasText: /^System: Tool execution rejected by user\.$/ })).toBeVisible()
  await expect(page.getByText('Vibe Coding Pipeline')).toHaveCount(0, { timeout: 4000 })
  expect(api.requests.some(request => request.pathname === '/api/aurora/vibe-build')).toBe(true)
  expect(api.requests.some(request => request.pathname === '/api/aurora/vibe-apply')).toBe(false)
  expect(api.unexpectedRequests).toEqual([])
})

test('Vibe Build approval applies the generated widget through the safe endpoint', async ({ page }) => {
  const api = await openAurora(page)

  await page.getByRole('tab', { name: 'Build' }).click()
  await getOmniInput(page).fill('Build a Pomodoro widget')
  await page.getByRole('button', { name: 'Build' }).click()

  await expect(page.locator('.patch-preview-badge')).toContainText(
    'packages/client/src/components/generated/PomodoroGlassWidget.vue',
  )
  await expect(page.getByText('Security Alert: Agent requests Terminal execution.')).toBeVisible({ timeout: 9000 })

  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('Vibe Coding Pipeline')).toHaveCount(0, { timeout: 4000 })
  expect(api.requests.some(request => request.pathname === '/api/aurora/vibe-build')).toBe(true)
  expect(api.requests.some(request => request.pathname === '/api/aurora/vibe-apply')).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('loads generated widgets through the Aurora dynamic component loader', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'open PomodoroGlassWidget')

  await expect(page.getByLabel('Aurora generated widget')).toBeVisible()
  await expect(page.getByLabel('Pomodoro Glass Widget')).toBeVisible()
  await expect(page.getByText('Pomodoro Focus')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start focus' })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('shows a clean generated widget failure card for missing widgets', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'open DefinitelyMissingWidget')

  await expect(page.getByLabel('Aurora generated widget')).toBeVisible()
  await expect(page.getByText('Widget rendering failed or not found')).toBeVisible()
  await expect(page.getByText('Available: PomodoroGlassWidget')).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('lists generated widgets and opens one from the library', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'show generated widgets')

  const library = page.getByLabel('Aurora generated widget library')
  await expect(library).toBeVisible()
  await expect(library).toContainText('PomodoroGlassWidget')
  await expect(library).toContainText('packages/client/src/components/generated/PomodoroGlassWidget.vue')
  await expect(library).toContainText('A glassmorphic Pomodoro widget with focus, break, and progress states.')
  await expect(library).toContainText('passed')
  await expect(library).toContainText('Loadable')
  await expect(library).toContainText('No network')
  await expect(library).toContainText('No context')

  await library.getByRole('button', { name: 'Open' }).click()
  await expect(page.getByLabel('Pomodoro Glass Widget')).toBeVisible()
  await expect(page.getByText('Pomodoro Focus')).toBeVisible()
  expect(api.requests.some(request => request.pathname === '/api/aurora/generated-widgets')).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('Memory Governance queues proposed memories without writing the legacy memory API', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'remember memory Aurora smoke memories require human approval')

  await expect(page.getByText('Candidate Memory Queued')).toBeVisible()
  await expect(page.getByText('Review Queue')).toBeVisible()
  await expect(
    page.getByLabel('Memory Review Queue').getByText('Aurora smoke memories require human approval', { exact: true }),
  ).toBeVisible()

  const legacyMemoryWrites = api.requests.filter(request =>
    request.pathname === '/api/hermes/memory' && request.method !== 'GET',
  )
  expect(legacyMemoryWrites).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})

test('renders legacy Kanban tasks as an Aurora task widget', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'What are my tasks for today?')

  const widget = page.getByLabel('Aurora task widget')
  await expect(widget).toBeVisible()
  await expect(widget.getByRole('heading', { name: 'Task Widget' })).toBeVisible()
  await expect(widget).toContainText('Ship Aurora widgetization')
  await expect(widget).toContainText('running')
  await expect(widget).toContainText('High')
  await expect(widget.getByRole('checkbox', { name: /Ship Aurora widgetization/ })).toBeVisible()
  await expect(page.locator('.result-json-box')).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('routes L3 Aurora tool approval through the Governance confirmation dialog', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'create task Review Governance approvals')

  const approval = page.getByRole('dialog', { name: 'CreateTaskTool requires approval' })
  await expect(approval).toBeVisible()
  await expect(approval).toContainText('Review Governance approvals')
  await expect(approval).toContainText('Aurora wants to bridge into a write-capable legacy module.')

  const bridge = page.getByLabel('Aurora legacy tool result')
  await expect(bridge).toContainText('Review this request in the Aurora Governance confirmation dialog.')
  await expect(bridge.getByRole('button', { name: 'Approve' })).toHaveCount(0)

  await approval.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('Task Created')).toBeVisible()
  await expect(page.getByText('Review Governance approvals was created in Kanban.')).toBeVisible()
  await page.getByRole('button', { name: 'System Status', exact: true }).click()
  const audit = page.getByLabel('Intent Audit Log')
  await expect(audit).toBeVisible()
  await audit.getByRole('button', { name: /^Governance/ }).click()
  await expect(audit).toContainText('Review Governance approvals')
  await expect(audit).toContainText('approval queued')
  await expect(audit).toContainText('approval approved')
  await audit.getByRole('button', { name: /Open audit event create task Review Governance approvals/ }).first().click()
  const auditDetail = page.getByLabel('Intent Audit Event Detail')
  await expect(auditDetail).toBeVisible()
  await expect(auditDetail).toContainText('Governance Payload')
  await expect(auditDetail).toContainText('CreateTaskTool Approval')
  await expect(auditDetail).toContainText('Full Payload JSON')
  await auditDetail.getByText('Full Payload JSON').click()
  await expect(auditDetail).toContainText('governanceId')
  await auditDetail.getByRole('button', { name: 'Close' }).click()
  expect(api.requests.some(request =>
    request.pathname === '/api/hermes/kanban' && request.method === 'POST',
  )).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('cancels stale L3 approval when the Aurora result overlay is dismissed', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'create task Stale approval cleanup')

  const approval = page.getByRole('dialog', { name: 'CreateTaskTool requires approval' })
  await expect(approval).toBeVisible()
  await page.getByRole('button', { name: 'Dismiss Result' }).evaluate((button: HTMLButtonElement) => {
    button.click()
  })

  await expect(approval).toHaveCount(0)
  await expect(page.getByLabel('Aurora legacy tool result')).toHaveCount(0)
  await page.getByRole('button', { name: 'System Status', exact: true }).click()
  const audit = page.getByLabel('Intent Audit Log')
  await expect(audit).toBeVisible()
  await audit.getByRole('button', { name: /^Governance/ }).click()
  await expect(audit).toContainText('Stale approval cleanup')
  await expect(audit).toContainText('approval expired')
  expect(api.requests.some(request =>
    request.pathname === '/api/hermes/kanban' && request.method === 'POST',
  )).toBe(false)
  expect(api.unexpectedRequests).toEqual([])
})

test('opens Quant Lab intent directly in Aurora App Mode', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'Quant Lab today top 10')

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.getByLabel('Aurora App Brief')).toContainText('Quant Lab command center')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('NVDA')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('2/2')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('Updated')
  const quantRefreshPromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/hermes/quant-lab/snapshot',
  )
  await page.getByLabel('Aurora App Brief').getByRole('button', { name: 'Refresh' }).click()
  await quantRefreshPromise
  expect(api.requests.filter(request => request.pathname === '/api/hermes/quant-lab/snapshot').length).toBeGreaterThanOrEqual(2)
  await expect(page.getByText('Quant Lab').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.getByRole('button', { name: '前十' }).click()
  const bridgeRequestPromise = page.waitForRequest(request =>
    new URL(request.url()).pathname === '/api/hermes/quant-lab/run-mirofish' &&
    request.method() === 'POST',
  )
  await page.getByRole('button', { name: 'Run MiroFish risk bridge for MSFT' }).click()
  const bridgeRequest = await bridgeRequestPromise
  expect(JSON.parse(bridgeRequest.postData() || '{}')).toMatchObject({
    submitBackend: false,
    targetTicker: 'MSFT',
  })
  await expect(page.locator('.app-window-title strong')).toContainText('MiroFish Arena')
  const bridge = page.getByLabel('Quant Risk Bridge')
  await expect(bridge).toContainText('MSFT')
  await expect(bridge).toContainText('87.2')
  await expect(bridge).toContainText('WATCH')
  await expect(page.getByLabel('MiroFish Debate Arena')).toContainText('Top pick MSFT')
  expect(api.unexpectedRequests).toEqual([])
})

test('runs Quant Lab Top picks through MiroFish batch risk bridge', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'Quant Lab today top 10')

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await page.getByRole('button', { name: '前十' }).click()
  await expect(page.getByLabel('Quant Risk Bridge Batch Controls')).toContainText('Top 2 sandbox')
  await page.getByRole('button', { name: 'Run MiroFish batch risk bridge' }).click()

  await expect(page.locator('.app-window-title strong')).toContainText('MiroFish Arena')
  const batch = page.getByLabel('Quant Risk Bridge Batch')
  await expect(batch).toContainText('Batch Sandbox')
  await expect(batch).toContainText('NVDA')
  await expect(batch).toContainText('MSFT')
  await expect(batch).toContainText('complete')
  const markdownExportResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/hermes/quant-lab/save-report' &&
    response.request().method() === 'POST',
  )
  await batch.getByRole('button', { name: 'Export MiroFish batch Markdown' }).click()
  expect((await markdownExportResponse).status()).toBe(200)
  await expect(batch).toContainText('Markdown exported')
  await expect(batch).toContainText('trading-journal')
  const csvExportResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/hermes/quant-lab/save-report' &&
    response.request().method() === 'POST',
  )
  await batch.getByRole('button', { name: 'Export MiroFish batch CSV' }).click()
  expect((await csvExportResponse).status()).toBe(200)
  await expect(batch).toContainText('CSV exported')
  await expect(page.getByLabel('MiroFish Debate Arena')).toContainText('Top pick MSFT')

  await expect.poll(() =>
    api.requests.filter(request =>
      request.pathname === '/api/hermes/quant-lab/run-mirofish' &&
      request.method === 'POST',
    ).length,
  ).toBeGreaterThanOrEqual(2)
  const payloads = api.requests
    .filter(request => request.pathname === '/api/hermes/quant-lab/run-mirofish' && request.method === 'POST')
    .map(request => JSON.parse(request.postData || '{}'))
  expect(payloads).toEqual(expect.arrayContaining([
    expect.objectContaining({ submitBackend: false, targetTicker: 'NVDA' }),
    expect.objectContaining({ submitBackend: false, targetTicker: 'MSFT' }),
  ]))
  const exportPayloads = api.requests
    .filter(request => request.pathname === '/api/hermes/quant-lab/save-report' && request.method === 'POST')
    .map(request => JSON.parse(request.postData || '{}'))
  const markdownPayload = exportPayloads.find(payload => String(payload.fileName || '').endsWith('.md'))
  const csvPayload = exportPayloads.find(payload => String(payload.fileName || '').endsWith('.csv'))
  expect(markdownPayload?.fileName).toMatch(/^mirofish-batch-\d+-base\.md$/)
  expect(markdownPayload?.content).toContain('MiroFish Batch Risk Bridge')
  expect(markdownPayload?.content).toContain('| NVDA |')
  expect(markdownPayload?.content).toContain('Submit backend: false')
  expect(csvPayload?.fileName).toMatch(/^mirofish-batch-\d+-base\.csv$/)
  expect(csvPayload?.content).toContain('"ticker","action","score","risk","confidence","risk_multiplier","status","summary"')
  expect(csvPayload?.content).toContain('"NVDA"')
  expect(api.unexpectedRequests).toEqual([])
})

test('closes Quant Lab App Mode back to the pristine Aurora launcher', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'open quant paper trading')

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.getByText('Quant Lab').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  await expect(page.getByLabel('Aurora Tools Dock')).toBeVisible()
  await page.getByLabel('Aurora App Menu').click()
  await expect(page.getByLabel('Aurora App Menu List')).toContainText('Quant')
  expect(api.unexpectedRequests).toEqual([])
})

test('opens MiroFish debate arena from a risk simulation intent', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, '風險推演 NVDA')

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.getByLabel('MiroFish Debate Arena')).toBeVisible()
  await expect(page.getByLabel('MiroFish Debate Arena')).toContainText('Debate Arena')
  await expect(page.getByLabel('MiroFish Debate Arena')).toContainText('Bull agent')
  await expect(page.getByLabel('MiroFish Debate Arena')).toContainText('Bear agent')
  await expect(page.locator('.app-window-content .mirofish-arena')).toHaveCount(1)
  const arenaGlassStyles = await page.locator('.agent-card').first().evaluate(() => {
    const grid = document.querySelector('.agent-grid') as HTMLElement
    const macro = document.querySelector('.agent-card.macro') as HTMLElement
    const bull = document.querySelector('.agent-card.bull') as HTMLElement
    const bear = document.querySelector('.agent-card.bear') as HTMLElement
    const cardStyle = getComputedStyle(macro)
    return {
      gridColumnCount: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      background: cardStyle.backgroundColor,
      borderColor: cardStyle.borderTopColor,
      backdropFilter: cardStyle.backdropFilter || (cardStyle as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter,
      transition: cardStyle.transition,
      macroGlow: getComputedStyle(macro).boxShadow,
      bullGlow: getComputedStyle(bull).boxShadow,
      bearGlow: getComputedStyle(bear).boxShadow,
    }
  })
  expect(arenaGlassStyles.gridColumnCount).toBe(3)
  expect(arenaGlassStyles.background).toBe('rgba(255, 255, 255, 0.05)')
  expect(arenaGlassStyles.borderColor).toBe('rgba(255, 255, 255, 0.15)')
  expect(arenaGlassStyles.backdropFilter).toContain('blur(24px)')
  expect(arenaGlassStyles.transition).toContain('0.3s')
  expect(arenaGlassStyles.transition).toContain('cubic-bezier(0.4, 0, 0.2, 1)')
  expect(arenaGlassStyles.macroGlow).toContain('rgba(99, 102, 241, 0.05)')
  expect(arenaGlassStyles.bullGlow).toContain('rgba(16, 185, 129, 0.05)')
  expect(arenaGlassStyles.bearGlow).toContain('rgba(244, 63, 94, 0.05)')
  await expect(page.getByLabel('MiroFish Evidence Timeline')).toContainText('推演歷史時間軸')
  await expect(page.getByLabel('MiroFish Evidence Timeline')).toContainText('Fixture Past Debate: NVDA risk-on')
  await page.getByRole('button', { name: 'Open MiroFish archive Fixture Past Debate: MSFT chop' }).click()
  await expect(page.getByLabel('MiroFish Evidence Timeline')).toContainText('Past fixture debate held MSFT in watch mode')
  await expect(page.getByLabel('MiroFish Archive Replay')).toContainText('Macro Replay')
  await expect(page.getByLabel('MiroFish Archive Replay')).toContainText('Bull Replay')
  await expect(page.getByLabel('MiroFish Archive Replay')).toContainText('Bear Replay')
  await expect(page.getByLabel('MiroFish Archive Replay')).toContainText('Synthesizer Replay')
  await expect(page.getByLabel('MiroFish Archive Replay')).toContainText('Durable enterprise demand supported the base case.')
  await expect(page.getByLabel('MiroFish Archive Replay')).toContainText('Neutral market breadth argued against aggressive sizing.')
  await expect(page.getByLabel('MiroFish Current Archive Compare')).toContainText('本次推演對照')
  await expect(page.getByLabel('MiroFish Current Archive Compare')).toContainText('BUY NVDA')
  await expect(page.getByLabel('MiroFish Current Archive Compare')).toContainText('WATCH')
  await expect(page.getByLabel('MiroFish Current Archive Compare')).toContainText('0.82x')
  await expect(page.getByLabel('MiroFish Current Archive Compare')).toContainText('Local graph fallback')
  await expect(page.getByLabel('MiroFish Current Archive Compare')).toContainText('MSFT degree 3')
  await expect(page.getByLabel('MiroFish Decision Timeline')).toContainText('決策演進時間線')
  await expect(page.getByLabel('MiroFish Decision Timeline')).toContainText('BUY NVDA')
  await expect(page.getByLabel('MiroFish Decision Timeline')).toContainText('Archive WATCH')
  await expect(page.getByLabel('MiroFish Decision Timeline')).toContainText('Risk 0.82x')
  await expect(page.getByLabel('MiroFish Decision Timeline')).toContainText('Fixture Past Debate: MSFT chop')
  await page.getByLabel('MiroFish Decision Timeline').getByRole('button', { name: /Pin decision BUY NVDA/ }).first().click()
  const pinnedBaseline = page.getByLabel('MiroFish Pinned Decision Baseline')
  await expect(pinnedBaseline).toContainText('Pinned Baseline')
  await expect(pinnedBaseline).toContainText('BUY NVDA')
  await expect(pinnedBaseline).toContainText('Baseline BUY')
  await expect(pinnedBaseline).toContainText('Archive WATCH')
  await expect(pinnedBaseline).toContainText('Risk 0.82x')
  await expect(pinnedBaseline).toContainText('Current')
  await expect(pinnedBaseline).toContainText('Baseline')
  const driftAlerts = page.getByLabel('MiroFish Baseline Drift Alerts')
  await expect(driftAlerts).toContainText('Baseline aligned')
  const driftScore = page.getByLabel('MiroFish Baseline Drift Score')
  await expect(driftScore).toContainText('0 / 100')
  await expect(driftScore).toContainText('Low drift')
  await expect(driftScore).toContainText('No weighted drift signals detected.')
  await driftScore.click()
  const driftBreakdown = page.getByLabel('MiroFish Baseline Drift Score Breakdown')
  await expect(driftBreakdown).toContainText('Action')
  await expect(driftBreakdown).toContainText('Confidence')
  await expect(driftBreakdown).toContainText('Risk Multiplier')
  await expect(driftBreakdown).toContainText('Top Signal')
  await expect(driftBreakdown).toContainText('+0')
  await expect(driftBreakdown).toContainText('matches the pinned baseline')
  await expect(page.getByLabel('MiroFish Decision Timeline')).toContainText('Drift 0/100 Low')
  await expect(driftAlerts).toContainText('No material drift from pinned decision.')
  await expect(driftAlerts).toContainText('Action, risk, confidence, and top signal remain aligned')
  await expect(page.getByLabel('MiroFish Decision Timeline').getByRole('button', { name: /Unpin decision BUY NVDA/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('aurora.mirofish.pinned-decision.v1'))).toMatch(/^intent-/)
  await expect(page.getByLabel('Hermes Synthesizer Final Verdict')).toContainText('BUY')
  await expect(page.getByLabel('Hermes Synthesizer Final Verdict')).toContainText('0.82x')
  expect(api.requests.some(request =>
    request.pathname === '/api/hermes/quant-lab/run-mirofish' && request.method === 'POST',
  )).toBe(true)
  expect(api.requests.some(request =>
    request.pathname === '/api/hermes/quant-lab/mirofish-evidence-archives',
  )).toBe(true)
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  await page.getByRole('button', { name: 'System Status', exact: true }).click()
  const audit = page.getByLabel('Intent Audit Log')
  await expect(audit).toBeVisible()
  await expect(audit).toContainText('MiroFish decision audit: BUY NVDA vs Fixture Past Debate: MSFT chop')
  await audit.getByRole('button', { name: /Open audit event MiroFish decision audit: BUY NVDA vs Fixture Past Debate: MSFT chop/ }).click()
  const auditDetail = page.getByLabel('Intent Audit Event Detail')
  await expect(auditDetail).toContainText('Decision delta: BUY NVDA vs WATCH')
  await expect(auditDetail).toContainText('mirofish-current-archive-compare')
  await expect(auditDetail).toContainText('baselineDrift')
  await expect(auditDetail).toContainText('mirofish-pinned-baseline')
  await expect(auditDetail).toContainText('"score": 0')
  await expect(auditDetail).toContainText('matches the pinned baseline')
  await expect(auditDetail).toContainText('MSFT degree 3')
  await auditDetail.getByRole('button', { name: 'Replay Arena' }).click()
  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  const replay = page.getByLabel('MiroFish Audit Replay')
  await expect(replay).toContainText('Audit Replay')
  await expect(replay).toContainText('Base')
  await expect(replay).toContainText('Fixture Past Debate: MSFT chop')
  await expect(replay).toContainText('Drift 0/100 Low')
  await expect(replay).toContainText('matches the pinned baseline')
  const exportResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/hermes/quant-lab/save-report' &&
    response.request().method() === 'POST',
  )
  await replay.getByRole('button', { name: 'Export MiroFish audit snapshot' }).click()
  const snapshotResponse = await exportResponse
  expect(snapshotResponse.status()).toBe(200)
  await expect(replay).toContainText('Snapshot exported')
  await expect(replay).toContainText('trading-journal')
  const exportRequest = api.requests.find(request =>
    request.pathname === '/api/hermes/quant-lab/save-report' && request.method === 'POST',
  )
  expect(exportRequest).toBeTruthy()
  const exportPayload = JSON.parse(exportRequest?.postData || '{}')
  expect(exportPayload.fileName).toMatch(/^mirofish-audit-\d+-buy-nvda\.md$/)
  expect(exportPayload.content).toContain('MiroFish Audit Snapshot')
  expect(exportPayload.content).toContain('Decision delta: BUY NVDA vs WATCH')
  expect(exportPayload.content).toContain('Drift Contributions')
  expect(exportPayload.content).toContain('Scenario Matrix')
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)
  expect(api.requests.some(request =>
    request.pathname === '/api/aurora/intent-audit' && request.method === 'POST',
  )).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('runs MiroFish scenario presets without submitting real trades', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'simulate mirofish NVDA')

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  const advancedSettings = page.getByLabel('MiroFish Advanced Settings')
  await expect(advancedSettings).toBeVisible()
  await expect(page.locator('section[aria-label="MiroFish Scenario Presets"]')).toBeHidden()
  await advancedSettings.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
  const advancedSettingsToggle = advancedSettings.getByRole('button', { name: /Advanced Settings/ })
  await advancedSettingsToggle.dispatchEvent('click')
  await expect(advancedSettingsToggle).toHaveAttribute('aria-expanded', 'true')
  const presets = page.getByLabel('MiroFish Scenario Presets')
  await expect(presets).toBeVisible()
  await expect(presets).toContainText('Base')
  await expect(presets).toContainText('Bull Shock')
  await expect(presets).toContainText('Bear Shock')
  await expect(presets).toContainText('Macro Stress')
  const matrix = page.getByLabel('MiroFish Scenario Comparison Matrix')
  await expect(matrix).toContainText('四情境決策矩陣')
  await expect(matrix).toContainText('Base')
  await expect(matrix).toContainText('Bull Shock')
  await expect(matrix).toContainText('Bear Shock')
  await expect(matrix).toContainText('Macro Stress')
  await expect(matrix).toContainText('0.82x')
  await expect(matrix).toContainText('1.17x')
  await expect(matrix).toContainText('SELL')
  const galleryResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/hermes/quant-lab/audit-snapshots',
  )
  await page.getByRole('button', { name: 'Open MiroFish Audit Snapshot Gallery' }).click()
  expect((await galleryResponse).status()).toBe(200)
  const gallery = page.getByRole('region', { name: 'MiroFish Audit Snapshot Gallery' })
  await expect(gallery).toContainText('Markdown Replay Vault')
  await expect(gallery).toContainText('BUY NVDA')
  await expect(gallery).toContainText('Batch Markdown')
  await expect(gallery).toContainText('Batch CSV')
  await expect(gallery).toContainText('Compare Report')
  await expect(gallery).toContainText('MiroFish Snapshot Compare - BUY NVDA vs WATCH MSFT')
  await expect(gallery).toContainText('Decision delta: BUY NVDA vs WATCH')
  await expect(gallery).toContainText('Scenario Matrix')
  const gallerySearch = gallery.getByLabel('Search MiroFish gallery entries')
  const galleryPreview = gallery.locator('.audit-gallery-preview')
  await gallery.focus()
  await page.keyboard.press('ArrowDown')
  await expect(galleryPreview).toContainText('MiroFish Audit Snapshot - WATCH MSFT')
  await page.keyboard.press('Home')
  await expect(galleryPreview).toContainText('MiroFish Audit Snapshot - BUY NVDA')
  const actionFilter = gallery.getByLabel('Filter MiroFish gallery by action')
  const driftFilter = gallery.getByLabel('Filter MiroFish gallery by drift')
  await actionFilter.selectOption('watch')
  await expect(gallery).toContainText('WATCH MSFT')
  await expect(gallery).toContainText('MiroFish Batch Risk Bridge - Base')
  await expect.poll(() =>
    page.evaluate(() => JSON.parse(window.localStorage.getItem('aurora.mirofish.audit-gallery-state.v1') || '{}').action),
  ).toBe('watch')
  await actionFilter.selectOption('all')
  await driftFilter.selectOption('high')
  await expect(gallery.getByRole('button', { name: 'Open audit snapshot MiroFish Audit Snapshot - WATCH MSFT' })).toBeVisible()
  await expect(gallery.getByRole('button', { name: 'Open audit snapshot MiroFish Audit Snapshot - BUY NVDA' })).toHaveCount(0)
  await driftFilter.selectOption('all')
  await gallery.getByRole('button', { name: 'Show batch export gallery entries' }).click()
  await expect(gallery).toContainText('MiroFish Batch Risk Bridge - Base')
  await expect(gallery).toContainText('Batch CSV export with 2 candidates')
  await expect(gallery.getByRole('button', { name: /Compare audit snapshot MiroFish Audit Snapshot - WATCH MSFT/ })).toHaveCount(0)
  await gallerySearch.fill('csv')
  await expect(gallery).toContainText('mirofish-batch-20260528123000-base.csv')
  await gallery.getByRole('button', { name: 'Open audit snapshot mirofish-batch-20260528123000-base.csv' }).click()
  await expect.poll(() =>
    page.evaluate(() => JSON.parse(window.localStorage.getItem('aurora.mirofish.audit-gallery-state.v1') || '{}').selectedFile),
  ).toBe('mirofish-batch-20260528123000-base.csv')
  const csvPreview = gallery.getByLabel('MiroFish Batch CSV Preview Table')
  await expect(csvPreview).toContainText('ticker')
  await expect(csvPreview).toContainText('NVDA')
  await expect(csvPreview).toContainText('MSFT')
  const csvRows = csvPreview.locator('tbody tr')
  await expect(csvRows.first()).toContainText('NVDA')
  await csvPreview.getByRole('button', { name: 'Sort MiroFish CSV preview by ticker' }).click()
  await expect(csvRows.first()).toContainText('MSFT')
  await csvPreview.getByRole('button', { name: 'Sort MiroFish CSV preview by ticker' }).click()
  await expect(csvRows.first()).toContainText('NVDA')
  await csvPreview.getByRole('button', { name: 'Sort MiroFish CSV preview by score' }).click()
  await expect(csvRows.first()).toContainText('MSFT')
  await csvPreview.getByRole('button', { name: 'Sort MiroFish CSV preview by score' }).click()
  await expect(csvRows.first()).toContainText('NVDA')
  await expect(gallery.getByRole('button', { name: /Open audit snapshot MiroFish Batch Risk Bridge - Base/ })).toHaveCount(0)
  await gallerySearch.fill('')
  await gallery.getByRole('button', { name: 'Show compare report gallery entries' }).click()
  await expect(gallery).toContainText('MiroFish Snapshot Compare - BUY NVDA vs WATCH MSFT')
  await expect(gallery).toContainText('Paper trading research only; no backend trade submission.')
  await gallery.getByRole('button', { name: 'Open audit snapshot MiroFish Snapshot Compare - BUY NVDA vs WATCH MSFT' }).click()
  await expect(galleryPreview).toContainText('MiroFish Snapshot Compare')
  await expect(gallery.getByRole('button', { name: /Compare audit snapshot MiroFish Snapshot Compare/ })).toHaveCount(0)
  await expect(gallery.getByRole('button', { name: 'Replay MiroFish audit snapshot from gallery' })).toHaveCount(0)
  await gallery.getByRole('button', { name: 'Hide gallery entry MiroFish Snapshot Compare - BUY NVDA vs WATCH MSFT' }).click()
  await expect(gallery).toContainText('No gallery entries match the current search or category.')
  await expect.poll(() =>
    page.evaluate(() => JSON.parse(window.localStorage.getItem('aurora.mirofish.hidden-gallery-entries.v1') || '[]')),
  ).toContain('mirofish-compare-20260528124500-buy-nvda-vs-watch-msft.md')
  await gallery.getByRole('button', { name: 'Restore hidden MiroFish gallery entries' }).click()
  await expect(gallery).toContainText('MiroFish Snapshot Compare - BUY NVDA vs WATCH MSFT')
  await expect.poll(() =>
    page.evaluate(() => window.localStorage.getItem('aurora.mirofish.hidden-gallery-entries.v1')),
  ).toBeNull()
  await gallery.getByRole('button', { name: 'Open MiroFish gallery state sync' }).click()
  const gallerySync = gallery.getByRole('region', { name: 'MiroFish Gallery State Sync' })
  await expect(gallerySync).toContainText('Portable State')
  await gallerySync.getByRole('textbox', { name: 'MiroFish gallery state JSON' }).fill(JSON.stringify({
    version: 1,
    query: '',
    category: 'audit',
    action: 'watch',
    drift: 'all',
    date: 'all',
    selectedFile: 'mirofish-audit-20260527170000-watch-msft.md',
    hiddenFiles: [],
    pinnedFile: 'mirofish-audit-20260527170000-watch-msft.md',
  }, null, 2))
  await gallerySync.getByRole('button', { name: 'Apply MiroFish gallery state' }).click()
  await expect(gallerySync).toContainText('Portable state applied')
  await expect(actionFilter).toHaveValue('watch')
  await expect(gallery).toContainText('WATCH MSFT')
  await expect.poll(() =>
    page.evaluate(() => window.localStorage.getItem('aurora.mirofish.pinned-audit-snapshot.v1')),
  ).toBe('mirofish-audit-20260527170000-watch-msft.md')
  await actionFilter.selectOption('all')
  await gallerySearch.fill('')
  await gallery.getByRole('button', { name: 'Show all gallery entries' }).click()
  await gallery.getByRole('button', { name: 'Open audit snapshot MiroFish Audit Snapshot - BUY NVDA' }).click()
  const requestCountBeforeReplay = api.requests
    .filter(request => request.pathname === '/api/hermes/quant-lab/run-mirofish' && request.method === 'POST')
    .length
  await gallery.getByRole('button', { name: 'Replay MiroFish audit snapshot from gallery' }).click()
  const galleryReplay = page.getByLabel('MiroFish Audit Replay')
  await expect(galleryReplay).toContainText('Audit Replay')
  await expect(galleryReplay).toContainText('Decision delta: BUY NVDA vs WATCH')
  await expect(galleryReplay).toContainText('Drift 0/100 Low')
  await expect(galleryReplay).toContainText('Snapshot baseline WATCH')
  await expect(galleryReplay).toContainText('Replay source mirofish-audit-20260528120000-buy-nvda.md')
  const replayDeltaBadges = page.getByLabel('MiroFish Replay Delta Badges')
  await expect(replayDeltaBadges).toContainText('Action BUY -> WATCH')
  await expect(replayDeltaBadges).toContainText('Drift 0 -> 12')
  expect(api.requests
    .filter(request => request.pathname === '/api/hermes/quant-lab/run-mirofish' && request.method === 'POST')
    .length).toBe(requestCountBeforeReplay)
  const requestCountBeforeCompare = requestCountBeforeReplay
  await gallery.getByRole('button', { name: 'Compare audit snapshot MiroFish Audit Snapshot - WATCH MSFT' }).click()
  const snapshotCompare = page.getByRole('region', { name: 'MiroFish Audit Snapshot Compare' })
  await expect(snapshotCompare).toContainText('Pinned Baseline Compare')
  await expect(snapshotCompare).toContainText('BUY NVDA vs WATCH MSFT')
  await expect(snapshotCompare).toContainText('BUY -> WATCH')
  await expect(snapshotCompare).toContainText('0 -> 12')
  const compareExportResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/hermes/quant-lab/save-report' &&
    response.request().method() === 'POST',
  )
  await snapshotCompare.getByRole('button', { name: 'Export MiroFish audit snapshot compare' }).click()
  expect((await compareExportResponse).status()).toBe(200)
  await expect(snapshotCompare).toContainText('Compare exported')
  await expect(snapshotCompare).toContainText('trading-journal')
  const compareExportPayload = JSON.parse(api.requests
    .filter(request => request.pathname === '/api/hermes/quant-lab/save-report' && request.method === 'POST')
    .at(-1)?.postData || '{}')
  expect(compareExportPayload.fileName).toMatch(/^mirofish-compare-\d+-buy-nvda-vs-watch-msft\.md$/)
  expect(compareExportPayload.content).toContain('MiroFish Snapshot Compare')
  expect(compareExportPayload.content).toContain('| Signal | BUY NVDA | WATCH MSFT |')
  await gallery.getByRole('button', { name: 'Pin audit snapshot baseline MiroFish Audit Snapshot - WATCH MSFT' }).click()
  const pinnedSnapshot = page.getByRole('region', { name: 'MiroFish Pinned Audit Snapshot Baseline' })
  await expect(pinnedSnapshot).toContainText('Pinned Snapshot Baseline')
  await expect(pinnedSnapshot).toContainText('WATCH MSFT')
  await expect(snapshotCompare).toContainText('Pinned Baseline Compare')
  await expect.poll(() =>
    page.evaluate(() => window.localStorage.getItem('aurora.mirofish.pinned-audit-snapshot.v1')),
  ).toBe('mirofish-audit-20260527170000-watch-msft.md')
  expect(api.requests
    .filter(request => request.pathname === '/api/hermes/quant-lab/run-mirofish' && request.method === 'POST')
    .length).toBe(requestCountBeforeCompare)
  await gallery.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect.poll(() => api.requests
    .filter(request => request.pathname === '/api/hermes/quant-lab/audit-snapshots' && request.method === 'GET')
    .length).toBeGreaterThanOrEqual(2)
  const requestCountBeforeDrilldown = api.requests
    .filter(request => request.pathname === '/api/hermes/quant-lab/run-mirofish' && request.method === 'POST')
    .length
  await matrix.getByRole('button', { name: 'Inspect MiroFish scenario Bull Shock' }).dispatchEvent('click')
  const drilldown = page.getByLabel('MiroFish Scenario Drilldown')
  await expect(drilldown).toContainText('Bull Shock Agent Delta')
  await expect(drilldown).toContainText('Macro')
  await expect(drilldown).toContainText('Bull')
  await expect(drilldown).toContainText('Bear')
  await expect(drilldown).toContainText('-0.12x')
  await expect(drilldown).toContainText('+12 pts')
  expect(api.requests
    .filter(request => request.pathname === '/api/hermes/quant-lab/run-mirofish' && request.method === 'POST')
    .length).toBe(requestCountBeforeDrilldown)

  await page.getByRole('button', { name: 'Run MiroFish scenario Bear Shock' }).dispatchEvent('click')
  await expect(presets).toContainText('Bear Shock')
  await expect(matrix.locator('.scenario-matrix-row.active')).toContainText('Bear Shock')
  await expect(drilldown).toContainText('Bear Shock Agent Delta')
  await expect(drilldown).toContainText('+0.35x')
  await expect(drilldown).toContainText('+20 pts')
  await expect(page.getByLabel('MiroFish Debate Arena')).toContainText('Scenario lens: Bear Shock')
  await expect(page.getByLabel('Hermes Synthesizer Final Verdict')).toContainText('SELL')
  await expect(page.getByLabel('Hermes Synthesizer Final Verdict')).toContainText('1.17x')

  const mirofishPayloads = api.requests
    .filter(request => request.pathname === '/api/hermes/quant-lab/run-mirofish' && request.method === 'POST')
    .map(request => JSON.parse(request.postData || '{}'))
  expect(mirofishPayloads).toEqual(expect.arrayContaining([
    expect.objectContaining({
      scenario: 'bear-shock',
      submitBackend: false,
    }),
  ]))
  expect(api.unexpectedRequests).toEqual([])
})

test('opens LifeOS intent directly in Aurora App Mode', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, '打開 LIFE OS')

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.getByLabel('Aurora App Brief')).toContainText('LifeOS financial cockpit')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('717,876')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('23.9%')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('Updated')
  await expect(page.getByText('LifeOS').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.locator('.close-app-button').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('opens apps from the Aurora Tools Dock without showing the legacy sidebar', async ({ page }) => {
  const api = await openAurora(page)

  const launcher = page.getByLabel('Aurora Tools Dock')
  await expect(launcher).toBeVisible()
  await launcher.getByRole('button', { name: 'Open Memory' }).click()

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('Memory')
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  await expect(page.getByLabel('Aurora Tools Dock')).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('opens legacy Kanban from the OmniBar inside Aurora App Mode', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, '打開看板')

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('Kanban')
  await page.getByText('Running (1)').click()
  await expect(page.getByText('Ship Aurora widgetization')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('opens legacy Models from the OmniBar without showing the Advanced Console', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'open models')

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('Models')
  await expect(page.getByText('Test Provider').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.locator('.close-app-button').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('opens Group Chat from the OmniBar inside Aurora App Mode', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'open group chat')

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('Group Chat')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('Group Chat command center')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('Rooms')
  await expect(page.getByLabel('Aurora App Brief')).toContainText('Aurora Review Room')
  await expect(page.locator('.group-chat-panel')).toContainText('Aurora Review Room')
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('opens Channels from the OmniBar with an Aurora native bridge brief', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'open channels')

  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.locator('.app-window-title strong')).toContainText('Channels')
  const brief = page.getByLabel('Aurora App Brief')
  await expect(brief).toContainText('Platform Bridge control rail')
  await expect(brief).toContainText('2/10')
  await expect(brief).toContainText('Telegram')
  await expect(brief).toContainText('Mention Safe')
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveCount(0)

  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByPlaceholder(launcherInputPlaceholder)).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps Hub/Proxy excluded from Aurora App Mode and falls back to Hermes chat', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'open hub')
  const { run } = await waitForRun(page)

  expect(run.input).toBe('open hub')
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  await expect(page.getByText('Aurora Legacy Bridge')).toHaveCount(0)

  await page.getByRole('button', { name: 'System Status', exact: true }).click()
  const audit = page.getByLabel('Intent Audit Log')
  await expect(audit).toBeVisible()
  await expect(audit).toContainText('open hub')
  await expect(audit).toContainText('fallback')

  await page.reload()
  await expect(page.getByRole('button', { name: 'System Status', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'System Status', exact: true }).click()
  const persistedAudit = page.getByLabel('Intent Audit Log')
  await expect(persistedAudit).toBeVisible()
  await expect(persistedAudit).toContainText('open hub')
  await expect(persistedAudit).toContainText('fallback')

  await page.getByLabel('Search Intent Audit').fill('hub')
  await expect(persistedAudit).toContainText('open hub')
  await page.getByLabel('Search Intent Audit').fill('terminal')
  await expect(persistedAudit).toContainText('No audit events match this search.')
  await page.getByLabel('Search Intent Audit').fill('')

  const downloadPromise = page.waitForEvent('download')
  await persistedAudit.getByRole('button', { name: 'Export' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toContain('aurora-intent-audit')

  await persistedAudit.locator('input[type="file"]').setInputFiles({
    name: 'audit-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      records: [
        {
          id: 'intent-imported-smoke',
          input: 'imported quant audit',
          status: 'app_opened',
          appKind: 'quant-lab',
          timestamp: '2026-05-28T12:10:00.000Z',
          summary: 'Imported by Playwright.',
          payload: {
            app: 'quant-lab',
            source: 'import-fixture',
          },
        },
      ],
    })),
  })
  await expect(persistedAudit).toContainText('Imported 1 audit events.')
  await expect(persistedAudit).toContainText('imported quant audit')
  await persistedAudit.getByRole('button', { name: 'Open audit event imported quant audit' }).click()
  const auditDetail = page.getByLabel('Intent Audit Event Detail')
  await expect(auditDetail).toBeVisible()
  await expect(auditDetail).toContainText('Opened App Mode')
  await expect(auditDetail).toContainText('quant-lab')
  await expect(auditDetail).toContainText('import-fixture')
  await auditDetail.getByRole('button', { name: 'Replay Intent' }).click()
  await expect(page.getByLabel('Aurora App Window')).toBeVisible()
  await expect(page.getByLabel('Aurora App Brief')).toContainText('Quant Lab command center')
  await page.locator('.traffic.close').click()
  await expect(page.getByLabel('Aurora App Window')).toHaveCount(0)
  expect(api.requests.some(request =>
    request.pathname === '/api/aurora/intent-audit' && request.method === 'POST',
  )).toBe(true)
  expect(api.requests.some(request =>
    request.pathname === '/api/aurora/intent-audit' && request.method === 'GET',
  )).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('renders legacy Memory search as an Aurora memory widget', async ({ page }) => {
  const api = await openAurora(page)

  await sendOmniIntent(page, 'search memory Aurora')

  const widget = page.getByLabel('Aurora memory widget')
  await expect(widget).toBeVisible()
  await expect(widget.getByRole('heading', { name: 'Memory Widget' })).toBeVisible()
  await expect(widget).toContainText('Source: memory')
  await expect(widget).toContainText('Confidence: 95%')
  await expect(widget).toContainText('Aurora prefers glassmorphic widgets')
  await expect(page.locator('.result-json-box')).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})
