import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, TEST_MODEL_GROUP } from './fixtures'

const LOCAL_CREDENTIAL = 'e2e-server-issued-local-credential'
type DesktopPlatform = 'darwin' | 'win32'

const baseRooms = [
  { id: 'room-alpha', name: 'Alpha Room', inviteCode: 'ALPHA1', canManage: true, workspace: '/tmp/alpha', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 123 },
  { id: 'room-beta', name: 'Beta Room', inviteCode: 'BETA22', canManage: true, workspace: '/tmp/beta', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 456 },
  { id: 'room-readonly', name: 'Read Only Room', inviteCode: null, canManage: false, workspace: '/tmp/readonly', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 0 },
]

const groupWorkspaceDiff = {
  kind: 'workspace_diff',
  version: 1,
  room_id: 'room-alpha',
  parent_message_id: 'alpha-file',
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

const baseAgentsByRoom: Record<string, any[]> = {
  'room-alpha': [
    {
      id: 'agent-row-1',
      roomId: 'room-alpha',
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      description: 'Group agent',
      invited: 1,
      runtime: 'hermes',
      codingAgentId: '',
      mode: 'scoped',
      provider: 'test-provider',
      model: 'test-model',
      apiMode: 'chat_completions',
      reasoningEffort: '',
      avatar: null,
    },
  ],
  'room-readonly': [
    {
      id: 'agent-row-readonly',
      roomId: 'room-readonly',
      agentId: 'agent-readonly',
      profile: 'default',
      name: 'Observer',
      description: 'Read-only room agent',
      invited: 1,
      runtime: 'hermes',
      codingAgentId: '',
      mode: 'scoped',
      provider: 'test-provider',
      model: 'test-model',
      apiMode: 'chat_completions',
      reasoningEffort: '',
      avatar: null,
    },
  ],
}

const agentsByRoom: Record<string, any[]> = structuredClone(baseAgentsByRoom)

function resetAgentsByRoom() {
  for (const key of Object.keys(agentsByRoom)) delete agentsByRoom[key]
  Object.assign(agentsByRoom, structuredClone(baseAgentsByRoom))
}

async function mockGroupChatApi(page: Page) {
  const rooms = baseRooms.map(room => ({ ...room }))
  const inviteCodeUpdates: Array<{ roomId: string, body: unknown }> = []

  await page.route('**/*', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (!(pathname === '/health' || pathname.startsWith('/api/'))) {
      await route.fallback()
      return
    }

    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (pathname.startsWith('/api/hermes/group-chat/')) {
      const localCredential = request.headers()['x-group-chat-local-credential']
      if (localCredential !== LOCAL_CREDENTIAL) {
        return json({ error: 'Group chat local identity required' }, 401)
      }
    }

    if (pathname === '/health') return json({ status: 'ok' })
    if (pathname === '/api/auth/status') return json({ hasPasswordLogin: false, username: null })
    if (pathname === '/api/hermes/profiles') return json({ profiles: [{ name: 'default', active: true, model: 'test-model', gateway: 'test' }] })
    if (pathname === '/api/hermes/available-models') {
      const group = { ...TEST_MODEL_GROUP, models: ['test-model', 'test-model-2'], available_models: ['test-model', 'test-model-2'] }
      return json({
        default: 'test-model',
        default_provider: 'test-provider',
        groups: [group],
        allProviders: [group],
        profiles: [{ profile: 'default', default: 'test-model', default_provider: 'test-provider', groups: [group] }],
        model_aliases: {},
        model_visibility: {},
      })
    }
    if (pathname === '/api/hermes/group-chat/rooms') return json({ rooms })

    const participantMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/agents\/([^/]+)$/)
    if (participantMatch && request.method() === 'PATCH') {
      const roomId = decodeURIComponent(participantMatch[1])
      const agentId = decodeURIComponent(participantMatch[2])
      const body = JSON.parse(request.postData() || '{}')
      const agent = (agentsByRoom[roomId] || []).find(candidate => candidate.agentId === agentId)
      if (!agent) return json({ error: 'Agent not found' }, 404)
      Object.assign(agent, body)
      return json({ agent })
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
        ? json({ room, messages: messagesByRoom[roomId] || [], agents: agentsByRoom[roomId] || [], members: [{ id: 'member-1', userId: 'user-1', name: 'User One', description: '', joinedAt: 1_790_000_000 }] })
        : json({ error: 'Room not found' }, 404)
    }

    return json({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404)
  })

  return { inviteCodeUpdates }
}

async function mockGroupChatSocket(page: Page) {
  await page.route('**/node_modules/.vite/deps/socket__io-client.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
const state = window.__PW_GROUP_SOCKET__ || (window.__PW_GROUP_SOCKET__ = { sockets: [], emitted: [] })
const roomMessages = ${JSON.stringify(messagesByRoom)}
const roomNames = ${JSON.stringify(Object.fromEntries(baseRooms.map(room => [room.id, room.name])))}
const localCredential = ${JSON.stringify(LOCAL_CREDENTIAL)}
const localUserId = ${JSON.stringify(`local-user:${'c'.repeat(64)}`)}
const roomAgents = ${JSON.stringify(agentsByRoom)}
function makeSocket(url, options) {
  const listeners = new Map()
  const dispatch = (event, payload) => {
    for (const handler of listeners.get(event) || []) handler(payload)
  }
  const socket = {
    connected: false,
    id: 'pw-group-socket-' + (state.sockets.length + 1),
    auth: { ...(options && options.auth) },
    url,
    options,
    on(event, handler) {
      const handlers = listeners.get(event) || []
      handlers.push(handler)
      listeners.set(event, handlers)
      return this
    },
    once(event, handler) {
      const wrapped = (payload) => {
        this.off(event, wrapped)
        handler(payload)
      }
      return this.on(event, wrapped)
    },
    off(event, handler) {
      if (!listeners.has(event)) return this
      if (!handler) {
        listeners.delete(event)
        return this
      }
      listeners.set(event, (listeners.get(event) || []).filter(candidate => candidate !== handler))
      return this
    },
    emit(event, payload, ack) {
      state.emitted.push({ event, payload })
      if (event === 'join' && typeof ack === 'function') {
        const roomId = payload && payload.roomId
        setTimeout(() => ack({ roomId, roomName: roomNames[roomId] || roomId, currentUserId: localUserId, members: [{ id: 'member-local', userId: localUserId, name: 'User One', description: '', joinedAt: 1_790_000_000 }], messages: roomMessages[roomId] || [], agents: roomAgents[roomId] || [], rooms: [], typingUsers: [], contextStatuses: [] }), 0)
      }
      if (event === 'message' && typeof ack === 'function') {
        setTimeout(() => ack({ id: payload && payload.id }), 0)
      }
      return this
    },
    connect() {
      if (this.connected) return this
      setTimeout(() => {
        this.connected = true
        dispatch('connect')
        setTimeout(() => dispatch('local_identity', { localCredential, userId: localUserId }), 0)
      }, 0)
      return this
    },
    removeAllListeners() {
      listeners.clear()
      return this
    },
    disconnect() {
      this.connected = false
      dispatch('disconnect', 'client disconnect')
      return this
    },
    __trigger(event, payload) {
      dispatch(event, payload)
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

async function installDesktopBridge(page: Page, platform: DesktopPlatform) {
  await page.addInitScript((desktopPlatform) => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        isDesktop: true,
        platform: desktopPlatform,
        getWindowState: async () => ({ isMaximized: false }),
        windowControl: async () => ({ isMaximized: false }),
      },
    })
  }, platform)
}

async function setup(page: Page, path: string, platform?: DesktopPlatform) {
  resetAgentsByRoom()
  if (platform) await installDesktopBridge(page, platform)
  await authenticate(page)
  await mockGroupChatSocket(page)
  const api = await mockGroupChatApi(page)
  await page.goto(path)
  await expect(page.getByText('Alpha Room', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
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

  test('keeps the workspace drawer seam and resize direction aligned in LTR and RTL', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await page.locator('.markdown-file-card', { hasText: 'package.json' }).click()

    const wrapper = page.locator('.group-chat-content-wrapper')
    const panel = page.locator('.group-workspace-panel')
    const handle = page.locator('.group-workspace-resize-handle')
    await expect(panel).toBeVisible()

    const geometry = async () => {
      const [wrapperBox, panelBox, handleBox] = await Promise.all([
        wrapper.boundingBox(),
        panel.boundingBox(),
        handle.boundingBox(),
      ])
      if (!wrapperBox || !panelBox || !handleBox) throw new Error('group drawer geometry unavailable')
      return {
        wrapperLeft: wrapperBox.x,
        wrapperRight: wrapperBox.x + wrapperBox.width,
        panelLeft: panelBox.x,
        panelRight: panelBox.x + panelBox.width,
        panelWidth: panelBox.width,
        handleCenter: handleBox.x + handleBox.width / 2,
        handleY: handleBox.y + handleBox.height / 2,
      }
    }

    const ltr = await geometry()
    expect(Math.abs(ltr.panelRight - ltr.wrapperRight)).toBeLessThanOrEqual(1)
    expect(Math.abs(ltr.handleCenter - ltr.panelLeft)).toBeLessThanOrEqual(1)
    await page.mouse.move(ltr.handleCenter, ltr.handleY)
    await page.mouse.down()
    await page.mouse.move(ltr.handleCenter + 32, ltr.handleY)
    await page.mouse.up()
    await expect.poll(async () => (await geometry()).panelWidth).toBeLessThan(ltr.panelWidth)

    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'))
    await expect.poll(async () => {
      const current = await geometry()
      return Math.abs(current.panelLeft - current.wrapperLeft) <= 1
    }).toBe(true)
    const rtl = await geometry()
    expect(Math.abs(rtl.handleCenter - rtl.panelRight)).toBeLessThanOrEqual(1)
    await page.mouse.move(rtl.handleCenter, rtl.handleY)
    await page.mouse.down()
    await page.mouse.move(rtl.handleCenter - 32, rtl.handleY)
    await page.mouse.up()
    await expect.poll(async () => (await geometry()).panelWidth).toBeLessThan(rtl.panelWidth)
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

  for (const platform of ['darwin', 'win32'] as const) {
    test(`opens the Agent list from the ${platform} desktop drag header`, async ({ page }) => {
      await setup(page, '/#/hermes/group-chat/room/room-alpha', platform)

      const trigger = page.getByRole('button', { name: 'Agents (1)' })
      await expect(trigger).toBeVisible()
      await expect(trigger).toHaveCSS('-webkit-app-region', 'no-drag')
      await trigger.click()

      const popover = page.locator('.n-popover .agent-popover')
      await expect(popover).toBeVisible()
      await expect(popover.locator('.agent-popover-name', { hasText: 'Worker' })).toBeVisible()
    })
  }

  test('participant avatar opens direct model, API mode, reasoning, and structured mention controls', async ({ page }, testInfo) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await page.getByRole('button', { name: 'Agents (1)' }).click()

    const avatar = page.getByRole('button', { name: 'Participant settings: Worker' })
    await expect(avatar).toBeVisible()
    await avatar.click()

    const quick = page.locator('.agent-popover .participant-quick-settings')
    await expect(quick).toBeVisible()
    await expect(quick.locator('.participant-reasoning-slider')).toBeVisible()
    await expect(quick.getByText('Changes apply to this participant\'s next run.')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('participant-avatar-controls.png'), fullPage: true })

    const selects = quick.locator('.n-select')
    await expect(selects).toHaveCount(2)
    await selects.nth(0).click()
    await page.getByText('test-model-2').click()
    await expect.poll(async () => agentsByRoom['room-alpha'][0].model).toBe('test-model-2')

    await selects.nth(1).click()
    await page.getByText('Anthropic Messages').click()
    await expect.poll(async () => agentsByRoom['room-alpha'][0].apiMode).toBe('anthropic_messages')

    const thumb = quick.locator('.participant-reasoning-slider [role="slider"]')
    await expect(thumb).toBeVisible()
    await thumb.focus()
    await thumb.press('Home')
    for (let index = 0; index < 5; index += 1) await thumb.press('ArrowRight')
    await expect.poll(async () => agentsByRoom['room-alpha'][0].reasoningEffort).toBe('high')

    const mentionButton = quick.getByRole('button', { name: '@ Worker' })
    await mentionButton.click()
    const composer = page.locator('.input-textarea')
    await expect(composer).toHaveValue('@Worker ')
    await composer.type('inspect this')
    const sent = page.waitForFunction(() => (window as any).__PW_GROUP_SOCKET__?.emitted?.some((entry: any) => (
      entry.event === 'message'
      && entry.payload?.content === '@Worker inspect this'
      && entry.payload?.mentions?.[0]?.participantId === 'agent-1'
    )))
    await composer.press('Enter')
    await sent
  })

  test('read-only members can mention a participant without seeing runtime configuration controls', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-readonly')
    await page.getByRole('button', { name: 'Agents (1)' }).click()
    await page.getByRole('button', { name: 'Participant settings: Observer' }).click()

    const quick = page.locator('.agent-popover .participant-quick-settings')
    await expect(quick).toBeVisible()
    await expect(quick.locator('.n-select')).toHaveCount(0)
    await expect(quick.locator('.participant-reasoning-slider')).toHaveCount(0)
    await expect(quick.getByRole('button', { name: '@ Observer' })).toBeVisible()
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
    expect(api.inviteCodeUpdates.at(-1)).toEqual({ roomId: 'room-alpha', body: { inviteCode: ' NEW456 ' } })
    await expect(inviteInput).toHaveValue(' NEW456 ')
    await expect(updateButton).toBeDisabled()

    await inviteInput.fill('FAILCODE')
    const failureResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/api/hermes/group-chat/rooms/room-alpha/invite-code'))
    await updateButton.click()
    await expect((await failureResponse).status()).toBe(409)

    await modal.getByRole('button', { name: 'Cancel' }).click()
    await settingsButton.click()
    await expect(modal.getByPlaceholder('Enter a new invite code')).toHaveValue(' NEW456 ')
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
