import { expect, test, type Page, type Route } from '@playwright/test'

const sharedRoom = {
  id: 'room-shared',
  name: 'Shared Planning Room',
  inviteCode: null,
  canManage: false,
  summaryProfile: 'default',
  summaryProvider: 'test-provider',
  summaryModel: 'test-model',
  summaryApiMode: 'chat_completions',
  summaryEveryTurns: 20,
  totalTokens: 10,
  workspace: '',
}

const previewPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nZQAAAAASUVORK5CYII=',
  'base64',
)

async function mockInviteSocket(page: Page, joinFailure: { code: string, error: string } | null = null) {
  const joinFailureJson = JSON.stringify(joinFailure)
  await page.route('**/node_modules/.vite/deps/socket__io-client.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
const state = window.__PW_SHARED_GROUP_SOCKET__ || (window.__PW_SHARED_GROUP_SOCKET__ = { options: null, emitted: [] })
const joinFailure = ${joinFailureJson}
export function io(url, options) {
  state.options = options
  const listeners = new Map()
  const socket = {
    id: 'shared-socket-1',
    connected: true,
    on(event, handler) {
      const handlers = listeners.get(event) || []
      handlers.push(handler)
      listeners.set(event, handlers)
      return this
    },
    once(event, handler) {
      const wrapped = (...args) => {
        this.off(event, wrapped)
        handler(...args)
      }
      return this.on(event, wrapped)
    },
    off(event, handler) {
      if (!handler) listeners.delete(event)
      else listeners.set(event, (listeners.get(event) || []).filter(item => item !== handler))
      return this
    },
    emit(event, payload, ack) {
      state.emitted.push({ event, payload })
      if (event === 'join' && typeof ack === 'function') {
        if (joinFailure) {
          ack(joinFailure)
          return this
        }
        ack({
          roomId: 'room-shared',
          roomName: 'Shared Planning Room',
          members: [{ id: 'member-1', userId: 'guest-1', name: 'Guest', description: '', joinedAt: 1 }],
          messages: [{
            id: 'shared-message-1',
            roomId: 'room-shared',
            senderId: 'member-owner',
            senderName: 'Owner',
            content: 'Welcome to the shared room',
            timestamp: 1,
            role: 'user',
          }, {
            id: 'shared-message-2',
            roomId: 'room-shared',
            senderId: 'agent-worker',
            senderName: 'Worker',
            content: 'How can I help?',
            timestamp: 2,
            role: 'assistant',
          }],
          agents: [{
            id: 'room-agent-worker',
            roomId: 'room-shared',
            agentId: 'agent-worker',
            agent: 'hermes',
            profile: 'default',
            provider: 'test-provider',
            model: 'test-model',
            apiMode: 'chat_completions',
            reasoningEffort: '',
            name: 'Worker',
            description: '',
            avatar: '',
            invited: 1,
          }],
          rooms: ['room-shared'],
          total: 2,
          offset: 0,
          limit: 2,
          hasMore: false,
          typingUsers: [],
          contextStatuses: [],
        })
      }
      if (event === 'message' && typeof ack === 'function') ack({ id: payload && payload.id })
      return this
    },
    disconnect() {
      this.connected = false
      return this
    },
  }
  state.socket = socket
  return socket
}
export default { io }
`,
    })
  })
}

async function mockInviteApi(page: Page, valid = true, delayMs = 0) {
  const protectedRequests: string[] = []
  await page.route('**/*', async (route: Route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.startsWith('/api/')) {
      await route.fallback()
      return
    }

    if (url.pathname === '/api/studio/group-chat/rooms/join/ROOM1') {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      await route.fulfill({
        status: valid ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(valid ? { room: sharedRoom } : { error: 'Room not found' }),
      })
      return
    }

    if (
      route.request().method() === 'POST' &&
      url.pathname === '/api/studio/group-chat/invites/ROOM1/attachments'
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          files: [{
            name: 'visitor-image.png',
            path: '0123456789abcdef0123456789abcdef.png',
          }],
        }),
      })
      return
    }

    if (
      route.request().method() === 'GET' &&
      url.pathname === '/api/studio/group-chat/invites/ROOM1/attachments/0123456789abcdef0123456789abcdef.png'
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: previewPng,
      })
      return
    }

    protectedRequests.push(url.pathname)
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unauthorized' }),
    })
  })
  return protectedRequests
}

test.describe('invite-only group chat share page', () => {
  test('joins one room without login, app sidebar, room list, or protected API calls', async ({ page }) => {
    await mockInviteSocket(page)
    const protectedRequests = await mockInviteApi(page, true, 300)

    await page.goto('/#/share/group-chat/ROOM1')

    await expect(page.locator('#group-chat-guest-name input')).toBeVisible()
    await expect(page.locator('.guest-avatar-editor')).toBeVisible()
    await page.locator('.guest-avatar-file').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: previewPng,
    })
    await page.locator('#group-chat-guest-name input').fill('Visitor')
    await page.getByRole('button', { name: 'Enter room' }).click()
    await expect(page.locator('.invite-loading')).toBeVisible()
    await expect(page.locator('.invite-card')).toHaveCount(0)
    await expect(page.locator('.room-title-text')).toHaveText('Shared Planning Room')
    await expect(page.getByText('Welcome to the shared room')).toBeVisible()
    await expect(page.locator('.room-sidebar')).toHaveCount(0)
    await expect(page.locator('.header-sidebar-toggle')).toHaveCount(0)
    await expect(page.locator('.app-layout > .sidebar')).toHaveCount(0)
    await expect(page.locator('.file-input-hidden')).toHaveCount(1)
    await expect(page.locator('.input-settings-button')).toHaveCount(0)
    await expect(page.locator('.speech-bubble-btn')).toHaveCount(0)
    await page.locator('.agent-avatar-rail-item[aria-label="Worker"]').click()
    await expect(page.locator('.input-textarea')).toHaveValue('@Worker ')
    await page.locator('.input-textarea').fill('')
    await page.locator('.file-input-hidden').setInputFiles({
      name: 'visitor-image.png',
      mimeType: 'image/png',
      buffer: previewPng,
    })
    await expect(page.locator('.attachment-preview.image')).toBeVisible()
    await page.locator('.send-button').click()
    await expect(page.locator('.msg-attachment-thumb')).toBeVisible()
    await expect(page.locator('.msg-attachment-thumb')).toHaveAttribute(
      'src',
      /\/api\/studio\/group-chat\/invites\/ROOM1\/attachments\/0123456789abcdef0123456789abcdef\.png/,
    )
    expect(protectedRequests).toEqual([])

    const socketState = await page.evaluate(() => (window as any).__PW_SHARED_GROUP_SOCKET__)
    const socketAuth = socketState?.options?.auth
    expect(socketAuth).toMatchObject({ inviteCode: 'ROOM1' })
    expect(socketAuth.token).toBeUndefined()
    const joinEvent = socketState?.emitted?.find((event: any) => event.event === 'join')
    expect(JSON.parse(joinEvent?.payload?.avatar || '{}')).toMatchObject({ type: 'image' })
    const messageEvent = socketState?.emitted?.find((event: any) => event.event === 'message')
    expect(messageEvent?.payload?.content).toEqual([
      expect.objectContaining({
        type: 'image',
        path: '0123456789abcdef0123456789abcdef.png',
      }),
    ])
  })

  test('shows an invite error without redirecting to account login', async ({ page }) => {
    await mockInviteSocket(page)
    await mockInviteApi(page, false)

    await page.goto('/#/share/group-chat/ROOM1')

    await page.locator('#group-chat-guest-name input').fill('Visitor')
    await page.getByRole('button', { name: 'Enter room' }).click()
    await expect(page.locator('.invite-error')).toBeVisible()
    await expect(page).toHaveURL(/#\/share\/group-chat\/ROOM1$/)
    await expect(page.locator('.invite-card')).toBeVisible()
  })

  test('keeps the name step open when another participant already uses that name', async ({ page }) => {
    await mockInviteSocket(page, {
      code: 'ROOM_PARTICIPANT_NAME_CONFLICT',
      error: 'Name is already in use in this room',
    })
    await mockInviteApi(page)

    await page.goto('/#/share/group-chat/ROOM1')
    await page.locator('#group-chat-guest-name input').fill('Worker')
    await page.getByRole('button', { name: 'Enter room' }).click()

    await expect(page.locator('.invite-error')).toHaveText(/already in use/i)
    await expect(page.locator('#group-chat-guest-name input')).toHaveValue('Worker')
    await expect(page.locator('.group-chat-panel')).toHaveCount(0)
  })
})
