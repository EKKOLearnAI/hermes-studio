import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, TEST_MODEL_GROUP } from './fixtures'

const baseRooms = [
  { id: 'room-alpha', name: 'Alpha Room', inviteCode: 'ALPHA1', canManage: true, workspace: '/tmp/alpha', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, maxAgentMentionDepth: 4 as number | null, handoffMode: 'mentions' as 'mentions' | 'fixed', handoffOrderJson: '[]', handoffOrder: [] as string[], totalTokens: 123 },
  { id: 'room-beta', name: 'Beta Room', inviteCode: 'BETA22', canManage: true, workspace: '/tmp/beta', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, maxAgentMentionDepth: 4 as number | null, handoffMode: 'mentions' as 'mentions' | 'fixed', handoffOrderJson: '[]', handoffOrder: [] as string[], totalTokens: 456 },
  { id: 'room-readonly', name: 'Read Only Room', inviteCode: null, canManage: false, workspace: '/tmp/readonly', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, maxAgentMentionDepth: 4 as number | null, handoffMode: 'mentions' as 'mentions' | 'fixed', handoffOrderJson: '[]', handoffOrder: [] as string[], totalTokens: 0 },
]

const mixedRuntimeParticipants = [
  { id: 'row-hermes-a', roomId: 'room-alpha', agentId: 'participant-hermes-a', profile: 'default', name: 'Hermes A', description: 'planner', invited: 1, runtime: 'hermes', codingAgentId: '', sessionId: 'gc_room-alpha_participant-hermes-a_0', sessionGeneration: 0, mode: 'scoped', provider: 'test-provider', model: 'test-model', apiMode: '', reasoningEffort: 'medium' },
  { id: 'row-hermes-b', roomId: 'room-alpha', agentId: 'participant-hermes-b', profile: 'default', name: 'Hermes B', description: 'reviewer', invited: 1, runtime: 'hermes', codingAgentId: '', sessionId: 'gc_room-alpha_participant-hermes-b_0', sessionGeneration: 0, mode: 'scoped', provider: 'test-provider', model: 'test-model', apiMode: '', reasoningEffort: 'high' },
  { id: 'row-codex-a', roomId: 'room-alpha', agentId: 'participant-codex-a', profile: 'default', name: 'Codex A', description: 'builder', invited: 1, runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'gc_room-alpha_participant-codex-a_0', sessionGeneration: 0, mode: 'scoped', provider: 'test-provider', model: 'test-model', apiMode: 'codex_responses', reasoningEffort: 'high' },
  { id: 'row-codex-b', roomId: 'room-alpha', agentId: 'participant-codex-b', profile: 'default', name: 'Codex B', description: 'tester', invited: 1, runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'gc_room-alpha_participant-codex-b_0', sessionGeneration: 0, mode: 'scoped', provider: 'test-provider', model: 'test-model', apiMode: 'codex_responses', reasoningEffort: 'medium' },
  { id: 'row-claude-a', roomId: 'room-alpha', agentId: 'participant-claude-a', profile: 'default', name: 'Claude A', description: 'architect', invited: 1, runtime: 'coding_agent', codingAgentId: 'claude-code', sessionId: 'gc_room-alpha_participant-claude-a_0', sessionGeneration: 0, mode: 'scoped', provider: 'test-provider', model: 'test-model', apiMode: 'anthropic_messages', reasoningEffort: 'high' },
  { id: 'row-claude-b', roomId: 'room-alpha', agentId: 'participant-claude-b', profile: 'default', name: 'Claude B', description: 'auditor', invited: 1, runtime: 'coding_agent', codingAgentId: 'claude-code', sessionId: 'gc_room-alpha_participant-claude-b_0', sessionGeneration: 0, mode: 'scoped', provider: 'test-provider', model: 'test-model', apiMode: 'anthropic_messages', reasoningEffort: 'medium' },
]

const groupWorkspaceDiff = {
  kind: 'workspace_diff',
  version: 1,
  room_id: 'room-alpha',
  workspace: '/tmp/alpha',
  files_changed: 1,
  additions: 1,
  deletions: 1,
  truncated: false,
  files: [{
    id: 1,
    path: 'src/example.ts',
    change_type: 'modified',
    additions: 1,
    deletions: 1,
    binary: false,
    truncated: false,
    patch: 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
  }],
}

const messagesByRoom: Record<string, unknown[]> = {
  'room-alpha': [
    { id: 'alpha-msg', roomId: 'room-alpha', senderId: 'user-1', senderName: 'Alice', content: 'Alpha room message', timestamp: 1_790_000_000, role: 'user' },
    { id: 'alpha-file', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: '[package.json](/tmp/alpha/package.json)', timestamp: 1_790_000_001, role: 'assistant' },
    { id: 'alpha-diff', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: JSON.stringify(groupWorkspaceDiff), timestamp: 1_790_000_002, role: 'tool', tool_name: 'workspace_diff', tool_call_id: 'workspace_diff:alpha' },
  ],
  'room-beta': [
    { id: 'beta-msg', roomId: 'room-beta', senderId: 'user-1', senderName: 'Bob', content: 'Beta room message', timestamp: 1_790_000_100, role: 'user' },
  ],
}

async function mockGroupChatApi(page: Page) {
  const rooms = baseRooms.map(room => ({ ...room }))
  const inviteCodeUpdates: Array<{ roomId: string, body: unknown }> = []
  const roomConfigUpdates: Array<{ roomId: string, body: Record<string, unknown> }> = []
  const handoffJobs = [{
    id: 'job-failed-1', roomId: 'room-alpha', chainId: 'chain-1', sourceMessageId: 'alpha-msg',
    targetAgentId: 'participant-codex-a', targetSessionId: 'gc_room-alpha_participant-codex-a_0',
    depth: 1, kind: 'fixed', status: 'failed', attemptCount: 1,
    lastError: 'runner unavailable', createdAt: 1, updatedAt: 2, completedAt: 2,
  }]

  await page.route('**/*', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (!(pathname === '/health' || pathname.startsWith('/api/'))) {
      await route.continue()
      return
    }

    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (pathname === '/health') return json({ status: 'ok' })
    if (pathname === '/api/auth/status') return json({ hasPasswordLogin: false, username: null })
    if (pathname === '/api/hermes/profiles') return json({ profiles: [{ name: 'default', active: true, model: 'test-model', gateway: 'test' }] })
    if (pathname === '/api/hermes/available-models') {
      return json({
        default: 'test-model',
        default_provider: 'test-provider',
        groups: [TEST_MODEL_GROUP],
        allProviders: [TEST_MODEL_GROUP],
        model_aliases: {},
        model_visibility: {},
      })
    }
    if (pathname === '/api/hermes/group-chat/rooms') return json({ rooms })

    const participantListMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/agents$/)
    if (participantListMatch && request.method() === 'GET') {
      const roomId = decodeURIComponent(participantListMatch[1])
      return json({ agents: roomId === 'room-alpha' ? mixedRuntimeParticipants : [] })
    }

    const inviteCodeMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/invite-code$/)
    if (inviteCodeMatch && request.method() === 'PUT') {
      const roomId = decodeURIComponent(inviteCodeMatch[1])
      const body = JSON.parse(request.postData() || '{}')
      inviteCodeUpdates.push({ roomId, body })
      const room = rooms.find(r => r.id === roomId)
      if (!room || !room.canManage) return json({ error: 'Forbidden' }, 403)
      if (body.inviteCode === 'FAILCODE') return json({ error: 'duplicate invite code' }, 409)
      room.inviteCode = body.inviteCode
      return json({ success: true })
    }

    const roomConfigMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/config$/)
    if (roomConfigMatch && request.method() === 'PUT') {
      const roomId = decodeURIComponent(roomConfigMatch[1])
      const body = JSON.parse(request.postData() || '{}') as Record<string, unknown>
      roomConfigUpdates.push({ roomId, body: { ...body } })
      const room = rooms.find(r => r.id === roomId)
      if (!room || !room.canManage) return json({ error: 'Forbidden' }, 403)
      if (Array.isArray(body.handoffOrder)) {
        room.handoffOrder = body.handoffOrder.map(String)
        room.handoffOrderJson = JSON.stringify(body.handoffOrder)
        delete body.handoffOrder
      }
      Object.assign(room, body)
      return json({ room })
    }

    const handoffsMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/handoffs$/)
    if (handoffsMatch && request.method() === 'GET') {
      const roomId = decodeURIComponent(handoffsMatch[1])
      return json({ jobs: roomId === 'room-alpha' ? handoffJobs : [] })
    }

    const workspaceListMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/workspace-files\/list$/)
    if (workspaceListMatch) {
      return json({
        entries: [{ name: 'package.json', path: 'package.json', absolutePath: '/tmp/alpha/package.json', isDir: false, size: 25, modTime: '2026-07-17T00:00:00.000Z' }],
        path: '',
        absolutePath: '/tmp/alpha',
      })
    }

    const contentMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/workspace-file\/content$/)
    if (contentMatch) {
      return route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: '{"name":"group-preview"}\n',
      })
    }

    const detailMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)$/)
    if (detailMatch) {
      const roomId = decodeURIComponent(detailMatch[1])
      const room = rooms.find(r => r.id === roomId)
      return room
        ? json({ room, messages: messagesByRoom[roomId] || [], agents: roomId === 'room-alpha' ? mixedRuntimeParticipants : [], members: [{ id: 'member-1', userId: 'user-1', name: 'User One', description: '', joinedAt: 1_790_000_000 }] })
        : json({ error: 'Room not found' }, 404)
    }

    return json({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404)
  })

  return { inviteCodeUpdates, roomConfigUpdates }
}

async function mockGroupChatSocket(page: Page) {
  await page.route('**/node_modules/.vite/deps/socket__io-client.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
const state = window.__PW_GROUP_SOCKET__ || (window.__PW_GROUP_SOCKET__ = { sockets: [], emitted: [] })
const roomMessages = ${JSON.stringify(messagesByRoom)}
function makeSocket(url, options) {
  const listeners = new Map()
  const socket = {
    connected: true,
    url,
    options,
    on(event, handler) {
      const handlers = listeners.get(event) || []
      handlers.push(handler)
      listeners.set(event, handlers)
      return this
    },
    emit(event, payload, ack) {
      state.emitted.push({ event, payload })
      if (event === 'join' && typeof ack === 'function') {
        const roomId = payload && payload.roomId
        const agents = roomId === 'room-alpha' ? ${JSON.stringify(mixedRuntimeParticipants)} : []
        setTimeout(() => ack({ roomId, roomName: roomId, members: [], messages: roomMessages[roomId] || [], agents, rooms: [], typingUsers: [], contextStatuses: [] }), 0)
      }
      if (event === 'message' && typeof ack === 'function') {
        setTimeout(() => ack({ id: payload && payload.id }), 0)
      }
      return this
    },
    removeAllListeners() {
      listeners.clear()
      return this
    },
    disconnect() {
      this.connected = false
      return this
    },
    __trigger(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload)
    },
  }
  state.sockets.push(socket)
  state.latest = socket
  return socket
}
export function io(url, options) {
  return makeSocket(url, options)
}
export default { io }
`,
    })
  })
}

async function setup(page: Page, path: string) {
  await authenticate(page)
  await mockGroupChatSocket(page)
  const api = await mockGroupChatApi(page)
  await page.goto(path)
  return api
}

test.describe('group chat room deep links', () => {
  // This file already covers multi-tab behavior explicitly; keeping the deep-link/socket fixture serial
  // avoids local fullyParallel races where early tests see the room list before route-room selection settles.
  test.describe.configure({ mode: 'serial' })

  test('route room id opens selected room', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-beta')

    await expect(page.locator('.room-title-text', { hasText: 'Beta Room' })).toBeVisible()
    await expect(page.getByText('Beta room message')).toBeVisible()
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
  })

  test('renders two Hermes, two Codex, and two Claude Code participants with stable generations', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    await page.locator('.avatar-stack-inner').first().click()
    const popover = page.locator('.agent-popover')
    for (const name of ['Hermes A', 'Hermes B', 'Codex A', 'Codex B', 'Claude A', 'Claude B']) {
      await expect(popover.getByText(name, { exact: true })).toBeVisible()
    }
    await expect(popover.getByText(/Hermes · default · generation 0/)).toHaveCount(2)
    await expect(popover.getByText(/Codex · default · generation 0/)).toHaveCount(2)
    await expect(popover.getByText(/Claude Code · default · generation 0/)).toHaveCount(2)
  })

  test('previewable room files open in the group workspace panel instead of downloading', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    const fileCard = page.locator('.markdown-file-card', { hasText: 'package.json' })
    await expect(fileCard).toBeVisible()
    await fileCard.click()

    const panel = page.locator('.group-workspace-panel')
    await expect(panel.locator('.file-preview')).toBeVisible()
    await expect(panel.locator('.preview-code')).toContainText('group-preview')
    await expect(panel.locator('.preview-filename')).toHaveText('package.json')
  })

  test('workspace control sits beside the upper-right settings control and toggles the group workspace panel', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const toolbar = page.locator('.chat-header .header-info')
    const workspaceButton = toolbar.locator('.workspace-panel-toggle')
    const settingsButton = toolbar.locator('.compression-settings-button')
    await expect(workspaceButton).toBeVisible()
    await expect(settingsButton).toBeVisible()
    expect(await workspaceButton.evaluate(element => element.nextElementSibling?.classList.contains('compression-settings-button'))).toBe(true)

    await workspaceButton.click()
    await expect(page.locator('.group-workspace-panel')).toBeVisible()
    await expect(workspaceButton).toHaveAttribute('aria-pressed', 'true')

    await workspaceButton.click()
    await expect(page.locator('.group-workspace-panel')).toHaveCount(0)
  })

  test('room settings rotate invite codes only after the update API succeeds', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const settingsButton = page.locator('.chat-header .header-info .compression-settings-button')
    await settingsButton.click()

    const modal = page.locator('.room-settings-modal')
    await expect(modal.getByRole('heading', { name: 'Room Settings' })).toBeVisible()
    const inviteInput = modal.getByPlaceholder('Enter a new invite code')
    const updateButton = modal.getByRole('button', { name: 'Update' })

    await expect(inviteInput).toHaveValue('ALPHA1')
    await expect(updateButton).toBeDisabled()

    await inviteInput.fill('   ')
    await expect(updateButton).toBeDisabled()

    await inviteInput.fill(' NEW456 ')
    const successResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/api/hermes/group-chat/rooms/room-alpha/invite-code'))
    await updateButton.click()
    await expect((await successResponse).status()).toBe(200)
    expect(api.inviteCodeUpdates.at(-1)).toEqual({ roomId: 'room-alpha', body: { inviteCode: 'NEW456' } })
    await expect(inviteInput).toHaveValue('NEW456')
    await expect(updateButton).toBeDisabled()

    await inviteInput.fill('FAILCODE')
    const failureResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/api/hermes/group-chat/rooms/room-alpha/invite-code'))
    await updateButton.click()
    await expect((await failureResponse).status()).toBe(409)

    await modal.getByRole('button', { name: 'Cancel' }).click()
    await settingsButton.click()
    await expect(modal.getByPlaceholder('Enter a new invite code')).toHaveValue('NEW456')
  })

  test('room settings persist custom and unlimited automatic handoff limits', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')
    const settingsButton = page.locator('.chat-header .header-info .compression-settings-button')
    await settingsButton.click()

    const modal = page.locator('.room-settings-modal')
    const handoffSection = modal.locator('.settings-section', { hasText: 'Automatic Handoffs' })
    const handoffInput = handoffSection.locator('.n-input-number input')
    const unlimited = handoffSection.getByRole('checkbox', { name: 'Unlimited' })
    const saveSettings = modal.getByRole('button', { name: 'Save settings' })

    await expect(handoffInput).toHaveValue('4')
    await expect(unlimited).not.toBeChecked()
    await handoffInput.fill('12')
    const finiteResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/api/hermes/group-chat/rooms/room-alpha/config'))
    await saveSettings.click()
    await expect((await finiteResponse).status()).toBe(200)
    expect(api.roomConfigUpdates.at(-1)?.body.maxAgentMentionDepth).toBe(12)

    await settingsButton.click()
    const reopenedHandoffSection = page.locator('.room-settings-modal .settings-section', { hasText: 'Automatic Handoffs' })
    await expect(reopenedHandoffSection.locator('.n-input-number input')).toHaveValue('12')
    await reopenedHandoffSection.getByRole('checkbox', { name: 'Unlimited' }).check()
    await expect(reopenedHandoffSection.locator('.n-input-number input')).toBeDisabled()
    const unlimitedResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/api/hermes/group-chat/rooms/room-alpha/config'))
    await page.locator('.room-settings-modal').getByRole('button', { name: 'Save settings' }).click()
    await expect((await unlimitedResponse).status()).toBe(200)
    expect(api.roomConfigUpdates.at(-1)?.body.maxAgentMentionDepth).toBeNull()

    await settingsButton.click()
    const unlimitedSection = page.locator('.room-settings-modal .settings-section', { hasText: 'Automatic Handoffs' })
    await expect(unlimitedSection.getByRole('checkbox', { name: 'Unlimited' })).toBeChecked()
    await expect(unlimitedSection.locator('.n-input-number input')).toBeDisabled()
  })

  test('room settings persist fixed participant order and show durable failures', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await expect(page.locator('.handoff-status-row--failed')).toContainText('Handoff failed')
    await expect(page.locator('.handoff-status-row--failed')).toContainText('Codex A')
    await expect(page.locator('.handoff-status-row--failed')).toContainText('runner unavailable')

    const settingsButton = page.locator('.chat-header .header-info .compression-settings-button')
    await settingsButton.click()
    const modal = page.locator('.room-settings-modal')
    const section = modal.locator('.settings-section', { hasText: 'Automatic Handoffs' })
    await section.getByText('Mentions from Agent output', { exact: true }).click()
    await page.getByText('Fixed participant order', { exact: true }).click()

    const participantSelect = section.locator('.n-select').nth(1)
    await participantSelect.click()
    await page.getByText('Hermes A', { exact: true }).click()
    await participantSelect.click()
    await page.getByText('Codex A', { exact: true }).click()
    await participantSelect.click()
    await page.keyboard.press('Escape')

    const orderRows = section.locator('.handoff-order-item')
    await expect(orderRows).toHaveCount(2)
    await expect(orderRows.nth(0)).toContainText('Hermes A')
    await expect(orderRows.nth(1)).toContainText('Codex A')
    await orderRows.nth(1).getByRole('button', { name: 'Move up' }).click()
    await expect(orderRows.nth(0)).toContainText('Codex A')

    const response = page.waitForResponse(res => res.request().method() === 'PUT' && res.url().endsWith('/api/hermes/group-chat/rooms/room-alpha/config'))
    await modal.getByRole('button', { name: 'Save settings' }).click()
    await expect((await response).status()).toBe(200)
    expect(api.roomConfigUpdates.at(-1)?.body).toMatchObject({
      handoffMode: 'fixed',
      handoffOrder: ['participant-codex-a', 'participant-hermes-a'],
    })

    await settingsButton.click()
    const reopened = page.locator('.room-settings-modal .settings-section', { hasText: 'Automatic Handoffs' })
    await expect(reopened.getByText('Fixed participant order', { exact: true })).toBeVisible()
    await expect(reopened.locator('.handoff-order-item').nth(0)).toContainText('Codex A')
    await expect(reopened.locator('.handoff-order-item').nth(1)).toContainText('Hermes A')
  })

  test('read-only room members cannot open room settings', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-readonly')

    await expect(page.locator('.room-title-text', { hasText: 'Read Only Room' })).toBeVisible()
    await expect(page.locator('.room-item', { hasText: 'Read Only Room' }).locator('.room-code')).toHaveCount(0)
    await expect(page.locator('.chat-header .header-info .compression-settings-button')).toHaveCount(0)
  })

  test('group workspace diffs use the single-chat card and shared diff panel', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const card = page.locator('.tool-change-card')
    await expect(card).toBeVisible()
    expect((await card.boundingBox())?.width).toBeLessThan(500)
    await card.locator('.tool-change-card-header').click()
    await expect(card.locator('.tool-change-file-row')).toContainText('example.ts')
    await card.locator('.tool-change-file-row').click()

    const panel = page.locator('.group-workspace-panel')
    await expect(panel.locator('.workspace-diff-preview')).toBeVisible()
    await expect(panel.locator('.diff-file-name')).toHaveText('example.ts')
    await expect(panel.locator('.diff-code')).toContainText('new')
    await expect(panel.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  })

  test('clicking another room updates URL and reload preserves it', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await expect(page.getByText('Alpha room message')).toBeVisible()

    await page.getByText('Beta Room').click()
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
    await expect(page.getByText('Beta room message')).toBeVisible()

    await page.reload()
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
    await expect(page.getByText('Beta room message')).toBeVisible()
  })

  test('two tabs can show different rooms', async ({ context }) => {
    const first = await context.newPage()
    const second = await context.newPage()

    await setup(first, '/#/hermes/group-chat/room/room-alpha')
    await setup(second, '/#/hermes/group-chat/room/room-beta')

    await expect(first.getByText('Alpha room message')).toBeVisible()
    await expect(first.getByText('Beta room message')).toHaveCount(0)
    await expect(second.getByText('Beta room message')).toBeVisible()
    await expect(second.getByText('Alpha room message')).toHaveCount(0)
  })

  test('unknown route room id falls back to the first available room', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/missing-room')

    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-alpha$/)
    await expect(page.locator('.room-title-text', { hasText: 'Alpha Room' })).toBeVisible()
  })
})
