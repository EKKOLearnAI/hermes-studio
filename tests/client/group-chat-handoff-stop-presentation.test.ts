import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Group Chat handoff stop UI placement', () => {
  it('keeps runtime stop history out of the Room settings form', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const start = panel.indexOf("t('groupChat.agentHandoffTitle')")
    const end = panel.indexOf('</section>', start)
    const settings = panel.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(settings).not.toContain('stoppedHandoffChains')
    expect(settings).not.toContain('handleContinueHandoff')
  })

  it('filters message-adjacent cards through the presentability predicate', () => {
    const list = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageList.vue', 'utf8')
    expect(list).toContain('isPresentableHandoffChain(chain)')
  })

  it('shows management actions only to Room managers', () => {
    const list = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageList.vue', 'utf8')
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(list).toContain('canManageHandoff?: boolean')
    expect(list).toContain('props.canManageHandoff && handoffChainFor(msg)!.status')
    expect(panel).toContain(':can-manage-handoff="currentRoomCanManage"')
  })

  it('binds a policy save and its stop refresh to the originating Room', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const start = panel.indexOf('async function handleSaveHandoffConfig()')
    const end = panel.indexOf('async function handleContinueHandoff', start)
    const handler = panel.slice(start, end)

    expect(handler).toContain('const roomId = store.currentRoomId')
    expect(handler).toContain('updateRoomConfig(roomId, {')
    expect(handler).toContain('listStoppedRoomAgentHandoffs(roomId)')
    expect(handler).toContain('if (store.currentRoomId === roomId)')
  })

  it('localizes continuation action failures instead of exposing backend messages', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const start = panel.indexOf('async function handleContinueHandoff')
    const end = panel.indexOf('async function handleSaveRoomSummary', start)
    const handler = panel.slice(start, end)

    expect(handler).toContain('handoffErrorTranslationKey(err?.message)')
    expect(handler).not.toContain("message.error(err?.message")
  })
})
