import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, TEST_MODEL_GROUP } from './fixtures'

type DesktopPlatform = 'darwin' | 'win32'

const baseRooms = [
  { id: 'room-alpha', name: 'Alpha Room', inviteCode: 'ALPHA1', canManage: true, workspace: '/tmp/alpha', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 123, allowGuestAgents: 1, maxGuestAgentsPerMember: 1, allowRemoteWorkspaceAccess: 0, agentHandoffEnabled: 1, agentHandoffMaxDepth: 4, agentHandoffUnlimited: 0, createdAt: 1_790_000_000, lastActiveAt: 1_790_000_001 },
  { id: 'room-beta', name: 'Beta Room', inviteCode: 'BETA22', canManage: true, workspace: '/tmp/beta', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 456, allowGuestAgents: 1, maxGuestAgentsPerMember: 1, allowRemoteWorkspaceAccess: 0, createdAt: 1_790_000_000, lastActiveAt: 1_790_000_100 },
  { id: 'room-readonly', name: 'Read Only Room', inviteCode: null, canManage: false, workspace: '/tmp/readonly', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 0, createdAt: 1_789_999_999, lastActiveAt: 1_789_999_999 },
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
    { id: 'alpha-reasoning', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: 'Reasoning is available on demand.', reasoning: 'Inspecting several possible approaches.', isStreaming: true, timestamp: 1_790_000_003, role: 'assistant' },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `alpha-live-tool-${index + 1}`,
      roomId: 'room-alpha',
      senderId: 'agent-1',
      senderName: 'Worker',
      content: JSON.stringify({ result: `live-${index + 1}` }),
      timestamp: 1_790_000_010 + index,
      role: 'tool',
      run_id: 'run-live-tools',
      tool_name: `live_tool_${index + 1}`,
      tool_call_id: `live-call-${index + 1}`,
      ...(index === 11 ? { isStreaming: true } : {}),
    })),
    { id: 'alpha-live-answer', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: 'Live run remains in progress.', timestamp: 1_790_000_030, role: 'assistant', run_id: 'run-live-tools', isStreaming: true },
    { id: 'alpha-history-tool', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: '{"result":"history"}', timestamp: 1_790_000_040, role: 'tool', run_id: 'run-history-tools', tool_name: 'historical_tool', tool_call_id: 'history-call' },
    { id: 'alpha-history-answer', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: 'Historical run finished.', timestamp: 1_790_000_041, role: 'assistant', run_id: 'run-history-tools' },
  ],
  'room-beta': [
    { id: 'beta-msg', roomId: 'room-beta', senderId: 'user-1', senderName: 'Bob', content: 'Beta room message', timestamp: 1_790_000_100, role: 'user' },
  ],
}

const agentsByRoom: Record<string, unknown[]> = {
  'room-alpha': [
    {
      id: 'agent-row-1',
      roomId: 'room-alpha',
      agentId: 'agent-1',
      agent: 'hermes',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      apiMode: '',
      reasoningEffort: '',
      name: 'Worker',
      description: 'Group agent',
      avatar: '',
      invited: 1,
    },
  ],
  'room-beta': [
    {
      id: 'agent-row-runtime',
      roomId: 'room-beta',
      agentId: 'agent-runtime',
      agent: 'hermes',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      apiMode: '',
      reasoningEffort: '',
      name: 'Runtime Worker',
      description: 'Runtime group agent',
      avatar: '',
      invited: 1,
    },
  ],
}

async function mockGroupChatApi(page: Page, offlinePresence = false) {
  const rooms = baseRooms.map(room => ({ ...room }))
  let roomMessages = structuredClone(messagesByRoom)
  const roomDetailRequests: Array<{ roomId: string, offset: number, limit: number }> = []
  const roomDetailFailures = new Map<string, number>()
  const inviteCodeUpdates: Array<{ roomId: string, body: unknown }> = []
  const guestAgentPolicyUpdates: Array<{ roomId: string, body: any }> = []
  const roomConfigUpdates: Array<{ roomId: string, body: any }> = []
  const handoffChains = [{
    chainId: 'handoff:alpha-msg',
    roomId: 'room-alpha',
    sourceMessageId: 'alpha-msg',
    currentDepth: 4,
    maxDepth: 4,
    unlimited: 0,
    targetAgentId: 'agent-1',
    status: 'stopped',
    stopReason: 'max_depth',
    continueUsed: 0,
    createdAt: 1_790_000_002,
    updatedAt: 1_790_000_002,
  }]

  await page.route('**/*', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (!(pathname === '/health' || pathname.startsWith('/api/'))) {
      await route.fallback()
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

    const handoffContinueMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/handoffs\/([^/]+)\/continue$/)
    if (handoffContinueMatch && request.method() === 'POST') {
      const chain = handoffChains.find(item => item.roomId === decodeURIComponent(handoffContinueMatch[1])
        && item.chainId === decodeURIComponent(handoffContinueMatch[2]))
      if (!chain) return json({ error: 'Handoff chain not found' }, 404)
      Object.assign(chain, {
        status: 'claimed',
        attemptId: 'attempt-1',
        updatedAt: chain.updatedAt + 1,
      })
      return json({ success: true, attemptId: chain.attemptId, status: 'continuing', chain }, 202)
    }

    const handoffListMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/handoffs$/)
    if (handoffListMatch && request.method() === 'GET') {
      const roomId = decodeURIComponent(handoffListMatch[1])
      const room = rooms.find(item => item.id === roomId)
      return json({
        chains: handoffChains.filter(item => item.roomId === roomId
          && item.status === 'stopped'
          && !item.continueUsed
          && Number(room?.agentHandoffEnabled ?? 1) === 1
          && Number(room?.agentHandoffUnlimited ?? 0) === 0
          && item.maxDepth === Number(room?.agentHandoffMaxDepth ?? 4)),
      })
    }

    const configMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/config$/)
    if (configMatch && request.method() === 'PUT') {
      const roomId = decodeURIComponent(configMatch[1])
      const body = JSON.parse(request.postData() || '{}')
      const room = rooms.find(r => r.id === roomId)
      if (!room || !room.canManage) return json({ error: 'Forbidden' }, 403)
      roomConfigUpdates.push({ roomId, body })
      Object.assign(room, {
        ...(typeof body.agentHandoffEnabled === 'boolean' ? { agentHandoffEnabled: body.agentHandoffEnabled ? 1 : 0 } : {}),
        ...(body.agentHandoffMaxDepth !== undefined ? { agentHandoffMaxDepth: body.agentHandoffMaxDepth } : {}),
        ...(typeof body.agentHandoffUnlimited === 'boolean' ? { agentHandoffUnlimited: body.agentHandoffUnlimited ? 1 : 0 } : {}),
      })
      return json({ room })
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

    const guestAgentPolicyMatch = pathname.match(/^\/api\/hermes\/group-chat\/rooms\/([^/]+)\/guest-agent-policy$/)
    if (guestAgentPolicyMatch && request.method() === 'PUT') {
      const roomId = decodeURIComponent(guestAgentPolicyMatch[1])
      const body = JSON.parse(request.postData() || '{}')
      guestAgentPolicyUpdates.push({ roomId, body })
      const room = rooms.find(r => r.id === roomId)
      if (!room || !room.canManage) return json({ error: 'Forbidden' }, 403)
      const policy = {
        allowGuestAgents: body.allowGuestAgents ? 1 : 0,
        guestAgentApproval: 'owner',
        maxGuestAgentsPerMember: body.maxGuestAgentsPerMember,
        allowRemoteWorkspaceAccess: body.allowGuestAgents && body.allowRemoteWorkspaceAccess ? 1 : 0,
      }
      Object.assign(room, policy)
      return json({ policy })
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
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
      const limit = Math.max(1, Number(url.searchParams.get('limit')) || 150)
      roomDetailRequests.push({ roomId, offset, limit })
      const failureKey = `${roomId}:${offset}`
      const remainingFailures = roomDetailFailures.get(failureKey) || 0
      if (remainingFailures > 0) {
        roomDetailFailures.set(failureKey, remainingFailures - 1)
        return json({ error: 'Temporary history failure' }, 500)
      }
      const agents = (agentsByRoom[roomId] || []).map(agent => (
        offlinePresence ? { ...(agent as object), connectionStatus: 'offline' } : agent
      ))
      const members = offlinePresence
        ? [{ id: 'member-offline', userId: 'user-offline', name: 'Offline Member', description: '', joinedAt: 1_790_000_000, connectionStatus: 'offline' }]
        : [{ id: 'member-1', userId: 'user-1', name: 'User One', description: '', joinedAt: 1_790_000_000 }]
      const allMessages = roomMessages[roomId] || []
      const end = Math.max(0, allMessages.length - offset)
      const start = Math.max(0, end - limit)
      const messages = allMessages.slice(start, end)
      return room
        ? json({
            room,
            messages,
            agents,
            members,
            handoffChains: handoffChains.filter(item => item.roomId === roomId),
            total: allMessages.length,
            offset,
            limit,
            hasMore: offset + messages.length < allMessages.length,
          })
        : json({ error: 'Room not found' }, 404)
    }

    return json({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404)
  })

  return {
    inviteCodeUpdates,
    guestAgentPolicyUpdates,
    roomConfigUpdates,
    roomDetailRequests,
    failRoomDetail(roomId: string, offset: number, times = 1) {
      roomDetailFailures.set(`${roomId}:${offset}`, times)
    },
    setRoomMessages(messages: Record<string, unknown[]>) {
      roomMessages = structuredClone(messages)
    },
  }
}

async function mockGroupChatSocket(page: Page) {
  await page.route('**/node_modules/.vite/deps/socket__io-client.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
const state = window.__PW_GROUP_SOCKET__ || (window.__PW_GROUP_SOCKET__ = { sockets: [], emitted: [] })
const roomMessages = ${JSON.stringify(messagesByRoom)}
const roomAgents = ${JSON.stringify(agentsByRoom)}
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
        setTimeout(() => ack({ roomId, roomName: roomId, members: [], messages: roomMessages[roomId] || [], agents: roomAgents[roomId] || [], rooms: [], typingUsers: [], contextStatuses: [] }), 0)
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
      return this
    },
    __trigger(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload)
    },
  }
  state.sockets.push(socket)
  if (String(url).endsWith('/group-chat')) state.latest = socket
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

async function setup(page: Page, path: string, platform?: DesktopPlatform, offlinePresence = false) {
  if (platform) await installDesktopBridge(page, platform)
  await page.addInitScript(() => {
    window.localStorage.setItem('hermes.groupChat.refactorNotice.v1.acknowledged', '1')
  })
  await authenticate(page)
  await mockGroupChatSocket(page)
  const api = await mockGroupChatApi(page, offlinePresence)
  await page.goto(path)
  return api
}

async function triggerGroupSocket(page: Page, event: string, payload: unknown) {
  await page.evaluate(({ event, payload }) => {
    const socket = (window as any).__PW_GROUP_SOCKET__?.latest
    if (!socket) throw new Error('Group chat socket is not connected')
    socket.__trigger(event, payload)
  }, { event, payload })
}

test.describe('group chat room deep links', () => {
  // This file already covers multi-tab behavior explicitly; keeping the deep-link/socket fixture serial
  // avoids local fullyParallel races where early tests see the room list before route-room selection settles.
  test.describe.configure({ mode: 'serial' })

  test('route room id opens selected room', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-beta')

    await expect(page.locator('.room-title-text', { hasText: 'Beta Room' })).toBeVisible()
    await expect(page.getByText('Beta room message')).toBeVisible()
    expect((await page.locator('.run-card').first().boundingBox())?.width).toBeGreaterThanOrEqual(259)
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
  })

  test('keeps streaming Agent reasoning collapsed until explicitly expanded', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const message = page.locator('.group-message', { hasText: 'Reasoning is available on demand.' })
    await expect(message.locator('.thinking-block')).toBeVisible()
    await expect(message.locator('.thinking-body')).toHaveCount(0)
    await message.locator('.thinking-header').click()
    await expect(message.locator('.thinking-body')).toContainText('Inspecting several possible approaches.')
  })

  test('keeps the active Agent run tool list bounded and independently scrollable', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const panel = page.locator('.run-tool-list[data-agent-id="agent-1"][data-run-id="run-live-tools"]')
    const outer = page.locator('.group-message-list .virtual-message-list')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.tool-message')).toHaveCount(12)
    const historicalPanel = page.locator('.run-tool-list[data-run-id="run-history-tools"]')
    await expect(historicalPanel).toBeVisible()
    await expect(historicalPanel.locator('.tool-name')).toHaveText('historical_tool')
    await expect.poll(() => page.locator('.group-agent-run[data-run-id="run-history-tools"] .run-card').evaluate(
      element => Array.from(element.children, child => child.className),
    )).toEqual(['run-transcript', 'run-tool-list'])

    const dimensions = await panel.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }))
    expect(dimensions.clientHeight).toBeLessThan(dimensions.scrollHeight)
    expect(dimensions.clientHeight).toBeLessThanOrEqual(180)

    await panel.hover()
    await expect.poll(async () => {
      const first = await outer.evaluate(element => element.scrollTop)
      await page.waitForTimeout(100)
      const second = await outer.evaluate(element => element.scrollTop)
      return second - first
    }).toBe(0)
    const outerBefore = await outer.evaluate(element => element.scrollTop)
    await page.mouse.wheel(0, 120)
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await outer.evaluate(element => element.scrollTop)).toBe(outerBefore)

    await panel.focus()
    await expect(panel).toBeFocused()

    const toolNames = await panel.locator('.tool-name').allTextContents()
    expect(toolNames[0]).toBe('live_tool_12')
    expect(toolNames.at(-1)).toBe('live_tool_1')
  })

  test('loads older group messages from an upward gesture at the top and anchors the visible transcript', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')
    api.setRoomMessages({
      ...messagesByRoom,
      'room-alpha': Array.from({ length: 700 }, (_, index) => ({
        id: `history-${index + 1}`,
        roomId: 'room-alpha',
        senderId: 'user-1',
        senderName: 'Alice',
        content: `History message ${index + 1}`,
        timestamp: 1_790_000_000 + index,
        role: 'user',
      })),
    })
    await page.reload()

    const transcript = page.locator('.group-message-list .virtual-message-list')
    await expect(page.getByText('History message 700')).toBeVisible()
    await transcript.evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    const anchorOffset = () => transcript.evaluate((scroller, messageId) => {
      const anchor = scroller.querySelector(`[data-group-message-id="${messageId}"]`)
      if (!anchor) return Number.POSITIVE_INFINITY
      return anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    }, 'history-551')
    const anchorBefore = await anchorOffset()
    await expect.poll(() => api.roomDetailRequests.some(request => request.offset === 150)).toBe(true)
    await expect(page.getByText('History message 401')).toBeVisible()
    await expect.poll(async () => {
      const anchorAfter = await anchorOffset()
      return Math.abs(anchorAfter - anchorBefore)
    }).toBeLessThanOrEqual(2)
  })

  test('shows a retry action after older group history fails and links to the complete read-only history at the cap', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')
    api.setRoomMessages({
      ...messagesByRoom,
      'room-alpha': Array.from({ length: 700 }, (_, index) => ({
        id: `archive-${index + 1}`,
        roomId: 'room-alpha',
        senderId: 'user-1',
        senderName: 'Alice',
        content: `Archive message ${index + 1}`,
        timestamp: 1_790_100_000 + index,
        role: 'user',
      })),
    })
    api.failRoomDetail('room-alpha', 150)
    await page.reload()

    const transcript = page.locator('.group-message-list .virtual-message-list')
    await transcript.evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })

    const retry = page.getByRole('button', { name: 'Retry loading earlier messages' })
    await expect(retry).toBeVisible()
    await retry.click()
    await expect(page.getByText('Archive message 401')).toBeVisible()

    for (const expectedOffset of [300, 450]) {
      await transcript.evaluate(element => {
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
      })
      await expect.poll(() => api.roomDetailRequests.some(request => request.offset === expectedOffset)).toBe(true)
    }

    const historyLink = page.getByRole('link', { name: 'View complete group chat history' })
    await expect(historyLink).toBeVisible()
    await expect(historyLink).toHaveAttribute('href', '#/hermes/group-chat/history/room-alpha')
    await historyLink.click()
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/history\/room-alpha$/)
    await expect(page.getByRole('heading', { name: 'Alpha Room' })).toBeVisible()
    await expect(page.getByText('Archive message 1', { exact: true })).toBeVisible()
    await expect(page.getByText('Archive message 700', { exact: true })).toBeVisible()
    await expect(page.locator('textarea')).toHaveCount(0)
  })

  test('keeps runtime Tools bounded, newest-first, and stable after completion and refresh', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-beta')
    await expect(page.getByText('Beta room message')).toBeVisible()

    const runtimeMessage = (overrides: Record<string, unknown>) => ({
      id: 'run-runtime-tools_part_0',
      roomId: 'room-beta',
      senderId: 'agent-runtime',
      senderAgentRecordId: 'agent-row-runtime',
      senderName: 'Runtime Worker',
      content: '',
      timestamp: 1_790_000_200,
      role: 'assistant',
      run_id: 'run-runtime-tools',
      ...overrides,
    })

    await triggerGroupSocket(page, 'context_status', {
      roomId: 'room-beta',
      agentName: 'Runtime Worker',
      status: 'replying',
    })
    await triggerGroupSocket(page, 'message_stream_start', runtimeMessage({
      senderId: 'transport-socket-id',
      finish_reason: 'streaming',
    }))
    await triggerGroupSocket(page, 'message_stream_end', {
      roomId: 'room-beta',
      id: 'run-runtime-tools_part_0',
    })
    for (const [index, toolName] of ['read_file', 'terminal'].entries()) {
      const callId = `runtime-call-${index + 1}`
      await triggerGroupSocket(page, 'message', runtimeMessage({
        id: `run-runtime-tools_part_0_toolcall_${callId}`,
        timestamp: 1_790_000_201 + index * 2,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify({ index }) },
        }],
        finish_reason: 'tool_calls',
      }))
      await triggerGroupSocket(page, 'message', runtimeMessage({
        id: `run-runtime-tools_part_0_toolresult_${callId}`,
        timestamp: 1_790_000_202 + index * 2,
        role: 'tool',
        tool_call_id: callId,
        tool_name: toolName,
        content: `result-${index + 1}`,
      }))
    }
    await triggerGroupSocket(page, 'message_stream_start', runtimeMessage({
      id: 'run-runtime-tools_part_1',
      timestamp: 1_790_000_206,
      finish_reason: 'streaming',
    }))
    await triggerGroupSocket(page, 'message_reasoning_delta', {
      roomId: 'room-beta',
      id: 'run-runtime-tools_part_1',
      delta: 'Checking the Tool results.',
    })

    const runCard = page.locator('.group-agent-run[data-run-id="run-runtime-tools"]')
    const panel = page.locator('.run-tool-list[data-agent-id="agent-row-runtime"][data-run-id="run-runtime-tools"]')
    await expect(runCard).toHaveCount(1)
    await expect(panel).toBeVisible()
    await expect(panel.locator('.tool-name')).toHaveText(['terminal', 'read_file'])
    await expect(panel.locator('.tool-message')).toHaveCount(2)

    await triggerGroupSocket(page, 'context_status', {
      roomId: 'room-beta',
      agentName: 'Runtime Worker',
      status: 'ready',
    })

    await expect(panel).toBeVisible()
    await expect(panel.locator('.tool-name')).toHaveText(['terminal', 'read_file'])
    await expect(runCard.locator('.tool-message')).toHaveCount(2)
    await expect.poll(() => runCard.locator('.run-card').evaluate(
      element => Array.from(element.children, child => child.className),
    )).toEqual(['run-transcript', 'run-tool-list'])

    api.setRoomMessages({
      ...messagesByRoom,
      'room-beta': [
        ...messagesByRoom['room-beta'],
        runtimeMessage({
          id: 'run-runtime-tools_part_0_toolresult_runtime-call-1',
          timestamp: 1_790_000_202,
          role: 'tool',
          tool_call_id: 'runtime-call-1',
          tool_name: 'read_file',
          content: 'result-1',
        }),
        runtimeMessage({
          id: 'run-runtime-tools_part_0_toolresult_runtime-call-2',
          timestamp: 1_790_000_204,
          role: 'tool',
          tool_call_id: 'runtime-call-2',
          tool_name: 'terminal',
          content: 'result-2',
        }),
        runtimeMessage({
          id: 'run-runtime-tools_part_2',
          timestamp: 1_790_000_207,
          content: 'Finished.',
        }),
      ],
    })
    await page.reload()

    const refreshedRunCard = page.locator('.group-agent-run[data-run-id="run-runtime-tools"]')
    const refreshedPanel = page.locator('.run-tool-list[data-agent-id="agent-row-runtime"][data-run-id="run-runtime-tools"]')
    await expect(refreshedRunCard).toHaveCount(1)
    await expect(refreshedPanel).toBeVisible()
    await expect(refreshedPanel.locator('.tool-name')).toHaveText(['terminal', 'read_file'])
    await expect(refreshedRunCard.locator('.tool-message')).toHaveCount(2)
    await expect(page.locator('.group-message-list > .tool-message')).toHaveCount(0)
    await expect.poll(() => refreshedRunCard.locator('.run-card').evaluate(
      element => Array.from(element.children, child => child.className),
    )).toEqual(['run-transcript', 'run-tool-list'])
  })

  test('shows a selected room link when browser clipboard APIs cannot copy', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'isSecureContext', {
        configurable: true,
        value: false,
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: undefined,
      })
      Object.defineProperty(Document.prototype, 'execCommand', {
        configurable: true,
        value: () => false,
      })
    })
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    await page.locator('.room-item', { hasText: 'Alpha Room' }).click({ button: 'right' })
    await page.getByText('Copy Room Link', { exact: true }).click()

    const dialog = page.getByRole('dialog', { name: 'Copy Room Link' })
    const input = dialog.getByRole('textbox', { name: 'Copy Room Link' })
    const origin = await page.evaluate(() => window.location.origin)
    const expectedLink = `${origin}/#/share/group-chat/ALPHA1`

    await expect(dialog).toContainText('The browser could not copy automatically')
    await expect(input).toHaveValue(expectedLink)
    await expect.poll(async () => input.evaluate((element: HTMLInputElement) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
    }))).toEqual({ start: 0, end: expectedLink.length })
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
    await expect(panel).not.toHaveClass(/tool-panel-enter-active/)

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
    test(`opens Agent settings from the ${platform} avatar rail`, async ({ page }) => {
      await setup(page, '/#/hermes/group-chat/room/room-alpha', platform)

      const trigger = page.getByRole('button', { name: 'Worker' })
      await expect(trigger).toBeVisible()
      await expect(trigger).toHaveCSS('-webkit-app-region', 'no-drag')
      await trigger.click()

      const modal = page.locator('.modal').filter({ hasText: 'Edit Worker' })
      await expect(modal).toBeVisible()
      await expect(modal.getByText('Avatar', { exact: true })).toBeVisible()
      await expect(modal.getByText('Agent Name', { exact: true })).toBeVisible()
    })
  }

  test('member count collapses the default-open scrollable avatar rail', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const rail = page.locator('.agent-avatar-rail')
    const memberToggle = page.locator('.member-count-toggle')
    await expect(rail).toBeVisible()
    await expect(memberToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(rail.locator('.agent-avatar-rail-trigger')).toHaveCSS('overflow-y', 'auto')

    await memberToggle.click()
    await expect(rail).toHaveCount(0)
    await expect(memberToggle).toHaveAttribute('aria-expanded', 'false')

    await memberToggle.click()
    await expect(rail).toBeVisible()
    await page.getByRole('button', { name: 'Your Name' }).click()
    await expect(page.locator('.n-modal').filter({ hasText: 'Your Name' })).toBeVisible()
  })

  test('renders offline people and Agents in gray', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha', undefined, true)

    const offlineMember = page.getByRole('button', { name: 'Offline Member' })
    const offlineAgent = page.getByRole('button', { name: 'Worker' })
    await expect(offlineMember).toHaveClass(/agent-avatar-rail-offline/)
    await expect(offlineAgent).toHaveClass(/agent-avatar-rail-offline/)
    await expect(offlineMember.locator('.agent-avatar')).toHaveCSS('filter', 'grayscale(1)')
    await expect(offlineAgent.locator('.agent-avatar')).toHaveCSS('opacity', '0.42')
  })

  test('room settings rotate invite codes only after the update API succeeds', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const settingsButton = page.locator('.chat-header .header-info .compression-settings-button')
    await settingsButton.click()

    const drawer = page.locator('.n-drawer').filter({ has: page.locator('.room-settings-drawer') })
    await expect(drawer.getByText('Room Settings', { exact: true })).toBeVisible()
    const inviteInput = drawer.getByPlaceholder('Enter a new invite code')
    const updateButton = drawer.getByRole('button', { name: 'Update' }).nth(1)

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

    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await settingsButton.click()
    await expect(drawer.getByPlaceholder('Enter a new invite code')).toHaveValue('NEW456')
  })

  test('room owner can explicitly enable remote Agent workspace access', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')

    await page.locator('.chat-header .header-info .compression-settings-button').click()
    const drawer = page.locator('.n-drawer').filter({ has: page.locator('.room-settings-drawer') })
    const section = drawer.locator('.settings-section').filter({ hasText: 'Guest Agent connections' })
    const accessRow = section.locator('.guest-agent-policy-row').filter({
      hasText: 'Allow remote Agents to read and write the group workspace',
    })
    await expect(accessRow).toBeVisible()
    await accessRow.locator('.n-switch').click()

    const response = page.waitForResponse(item =>
      item.request().method() === 'PUT'
      && item.url().includes('/api/hermes/group-chat/rooms/room-alpha/guest-agent-policy'))
    await section.getByRole('button', { name: 'Save' }).click()
    await expect((await response).status()).toBe(200)
    expect(api.guestAgentPolicyUpdates.at(-1)).toEqual({
      roomId: 'room-alpha',
      body: {
        allowGuestAgents: true,
        maxGuestAgentsPerMember: 1,
        allowRemoteWorkspaceAccess: true,
      },
    })
  })

  test('removes stale stopped chains after changing room handoff settings', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const stopCard = page.locator('[data-handoff-chain-id="handoff:alpha-msg"]')
    await expect(stopCard).toContainText('Depth: 4 / 4')
    await expect(stopCard).toContainText('Target Agent: Worker')

    await page.locator('.chat-header .header-info .compression-settings-button').click()
    const drawer = page.locator('.n-drawer').filter({ has: page.locator('.room-settings-drawer') })
    const section = drawer.locator('.settings-section').filter({ hasText: 'Agent handoff' })
    await expect(section).toContainText('Recommended depth: 4')
    await section.locator('.n-input-number input').fill('6')
    const configResponse = page.waitForResponse(response =>
      response.request().method() === 'PUT'
      && response.url().includes('/api/hermes/group-chat/rooms/room-alpha/config'))
    await section.getByRole('button', { name: 'Save' }).click()
    await expect((await configResponse).status()).toBe(200)
    expect(api.roomConfigUpdates.at(-1)).toMatchObject({
      roomId: 'room-alpha',
      body: {
        agentHandoffEnabled: true,
        agentHandoffMaxDepth: 6,
        agentHandoffUnlimited: false,
      },
    })

    await expect(stopCard).toHaveCount(0)
  })

  test('continues one stopped chain without changing room handoff settings', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')
    const stopCard = page.locator('[data-handoff-chain-id="handoff:alpha-msg"]')
    await expect(stopCard).toContainText('Depth: 4 / 4')

    const continueResponse = page.waitForResponse(response =>
      response.request().method() === 'POST'
      && response.url().includes('/handoffs/handoff%3Aalpha-msg/continue'))
    await stopCard.getByRole('button', { name: 'Continue this handoff once' }).click()
    await expect((await continueResponse).status()).toBe(202)
    await expect(stopCard).toHaveCount(0)
    expect(api.roomConfigUpdates).toHaveLength(0)
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

    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
    await expect(page.locator('.room-title-text', { hasText: 'Beta Room' })).toBeVisible()
  })
})
