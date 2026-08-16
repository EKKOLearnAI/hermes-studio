import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const historyView = readFileSync('packages/client/src/views/hermes/HistoryView.vue', 'utf8')

describe('History GROUP collapse contract', () => {
  it('uses the existing collapsed-groups persistence store for GROUP', () => {
    expect(historyView).toContain("const HISTORY_GROUP_COLLAPSE_KEY = 'group-chat'")
    expect(historyView).toContain('collapsedGroups.value.has(HISTORY_GROUP_COLLAPSE_KEY)')
    expect(historyView).toContain("localStorage.setItem('hermes_collapsed_groups'")
  })

  it('exposes the GROUP header as an accessible keyboard toggle', () => {
    expect(historyView).toContain(':aria-expanded="!isGroupRoomsCollapsed"')
    expect(historyView).toContain('@keydown.enter.self.prevent="toggleGroupRooms"')
    expect(historyView).toContain('@keydown.space.self.prevent="toggleGroupRooms"')
  })

  it('hides the room list and pagination control without clearing room data', () => {
    expect(historyView).toContain('<template v-if="!isGroupRoomsCollapsed">')
    expect(historyView).toContain('v-if="groupRoomsHasMore && !isGroupRoomsCollapsed"')
    expect(historyView).not.toContain('groupRooms.value = []')
  })

  it('allows active rooms to stay collapsed after the initial route transition', () => {
    expect(historyView).toContain('function ensureGroupRoomsExpanded()')
    expect(historyView).not.toContain('if (routeGroupRoomId.value) {')
    expect(historyView).not.toContain('if (routeGroupRoomId.value) ensureGroupRoomsExpanded()')
    expect(historyView).toContain('if (!previousGroupRoomId) ensureGroupRoomsExpanded()')
  })
})
