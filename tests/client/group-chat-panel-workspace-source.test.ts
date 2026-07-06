import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('GroupChatPanel workspace save handling', () => {
  it('coerces null picker values before trimming so clearing the input saves an empty workspace', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("String(workspaceValue.value || '').trim()")
    expect(source).not.toContain('workspaceValue.value.trim()')
  })

  it('gates workspace mutation controls to rooms the server marks manageable', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain('const currentRoomCanManage = computed(() => canManageRoom(currentRoom.value))')
    expect(source).toContain('const visibleApproval = computed(() => currentRoomCanManage.value ? store.activePendingApproval : null)')
    expect(source).toContain('v-if="currentRoomCanManage" class="workspace-chip"')
    expect(source).toContain('v-if="currentRoomCanManage" class="context-stop-btn"')
    expect(source).toContain('if (!currentRoomCanManage.value) return')
  })
})
