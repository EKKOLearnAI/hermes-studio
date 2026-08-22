import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const router = readFileSync('packages/client/src/router/index.ts', 'utf8')
const historyView = readFileSync('packages/client/src/views/hermes/HistoryView.vue', 'utf8')
const messageList = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageList.vue', 'utf8')

describe('Group Chat has one history surface', () => {
  it('redirects both legacy history URLs to the live room', () => {
    expect(router).toMatch(/path: '\/hermes\/history\/group-chat\/:roomId'[\s\S]*?name: 'hermes\.groupChatRoom'/)
    expect(router).toMatch(/path: '\/hermes\/group-chat\/history\/:roomId'[\s\S]*?name: 'hermes\.groupChatRoom'/)
    expect(router).not.toContain("name: 'hermes.groupChatHistory'")
  })

  it('removes the GROUP section and dedicated history pane', () => {
    expect(historyView).not.toContain('GroupChatHistoryPane')
    expect(historyView).not.toContain('groupRooms')
    expect(historyView).not.toContain('>GROUP<')
    expect(existsSync('packages/client/src/components/hermes/group-chat/GroupChatHistoryPane.vue')).toBe(false)
  })

  it('removes the complete-history escape hatch from the live transcript', () => {
    expect(messageList).not.toContain('HistoryArchiveLink')
    expect(messageList).not.toContain('viewCompleteHistory')
    expect(messageList).not.toContain('hasReachedMessageDisplayLimit')
  })
})
