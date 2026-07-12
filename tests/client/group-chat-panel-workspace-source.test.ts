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
    expect(source).toContain('if (!currentRoomCanManage.value) return')
    expect(source).toContain('if (!canManageRoom(room)) return')
    expect(source).toContain("options.push({ label: t('chat.setWorkspace'), key: 'set-workspace' })")
    expect(source).toContain('v-if="currentRoomCanManage" class="context-stop-btn"')
  })

  it('renders the active room workspace badge beside the room title like single chat', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain('<div class="header-left">')
    expect(source).toContain('class="workspace-badge"')
    expect(source).toContain('v-if="currentRoom?.workspace"')
    expect(source).toContain(':title="currentRoom.workspace"')
    expect(source).not.toContain('class="workspace-chip"')
    expect(source).not.toContain("currentWorkspaceLabel || t('chat.setWorkspace')")
  })
})
