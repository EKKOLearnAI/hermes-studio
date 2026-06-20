import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate } from './fixtures'

const rooms = [
  { id: 'room-alpha', name: 'Alpha Room', inviteCode: 'ALPHA1', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 123 },
  { id: 'room-beta', name: 'Beta Room', inviteCode: 'BETA22', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 456 },
]

const messagesByRoom: Record<string, unknown[]> = {
  'room-alpha': [
    { id: 'alpha-msg', roomId: 'room-alpha', senderId: 'user-1', senderName: 'Alice', content: 'Alpha room message', timestamp: 1_790_000_000, role: 'user' },
  ],
  'room-beta': [
    { id: 'beta-msg', roomId: 'room-beta', senderId: 'user-1', senderName: 'Bob', content: 'Beta room message', timestamp: 1_790_000_100, role: 'user' },
  ],
}

async function mockGroupChatApi(page: Page) {
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
    if (pathname === '/api/hermes/group-chat/rooms') return json({ rooms })

    const detailMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)$/)
    if (detailMatch) {
      const roomId = decodeURIComponent(detailMatch[1])
      const room = rooms.find(r => r.id === roomId)
      return room
        ? json({ room, messages: messagesByRoom[roomId] || [], agents: [], members: [{ id: 'member-1', userId: 'user-1', name: 'User One', description: '', joinedAt: 1_790_000_000 }] })
        : json({ error: 'Room not found' }, 404)
    }

    return json({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404)
  })
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
        setTimeout(() => ack({ roomId, roomName: roomId, members: [], messages: roomMessages[roomId] || [], agents: [], rooms: [], typingUsers: [], contextStatuses: [] }), 0)
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
  await mockGroupChatApi(page)
  await page.goto(path)
}

test.describe('group chat room deep links', () => {
  test('route room id opens selected room', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-beta')

    await expect(page.locator('.room-title-text', { hasText: 'Beta Room' })).toBeVisible()
    await expect(page.getByText('Beta room message')).toBeVisible()
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
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
