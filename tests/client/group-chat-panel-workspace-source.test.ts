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
    expect(source).toContain('const currentRoomCanApprove = computed(() => canApproveRoom(currentRoom.value))')
    expect(source).toContain('const visibleApproval = computed(() => currentRoomCanApprove.value ? store.activePendingApproval : null)')
    expect(source).not.toContain('currentRoomCanManage.value ? store.activePendingApproval')
    expect(source).toContain('if (!currentRoomCanApprove.value) return')
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

  it('places the group workspace panel control beside settings in the upper-right toolbar', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const headerInfo = source.slice(
      source.indexOf('<div class="header-info">'),
      source.indexOf('<NPopconfirm v-if="currentRoomCanManage" @positive-click="handleClearRoomContext">'),
    )

    expect(headerInfo).toContain('class="icon-btn workspace-panel-toggle"')
    expect(headerInfo).toContain('class="icon-btn compression-settings-button"')
    expect(headerInfo).toContain('@click="toggleWorkspacePanel"')
    expect(headerInfo.indexOf('workspace-panel-toggle')).toBeLessThan(headerInfo.indexOf('compression-settings-button'))
    expect(source).not.toContain('class="page-sidebar-menu-btn workspace-sidebar-button"')
  })

  it('wires invite-code rotation into the manageable room settings modal', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("const inviteCodeDraft = ref('')")
    expect(source).toContain('const canUpdateInviteCode = computed(() => {')
    expect(source).toContain('await store.setRoomInviteCode(store.currentRoomId, nextCode)')
    expect(source).toContain('async function handleCopyInviteCode()')
    expect(source).toContain('const code = inviteCodeDraft.value')
    expect(source).toContain('const ok = await copyToClipboard(code)')
    expect(source).toContain("<h3>{{ t('groupChat.roomSettings') }}</h3>")
    expect(source).toContain("<h4>{{ t('groupChat.inviteCodeSettings') }}</h4>")
    expect(source).toContain('v-model:value="inviteCodeDraft"')
    expect(source).toContain(":title=\"t('groupChat.copyInviteCode')\"")
    expect(source).toContain('@click="handleCopyInviteCode"')
    expect(source).toContain('@click="handleSaveInviteCode"')
    expect(source).toContain(":title=\"t('groupChat.roomSettings')\"")
  })

  it('renders a localized leave-room action in the marked room-list action area', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain('const leavingRoomIds = ref<Set<string>>(new Set())')
    expect(source).toContain('async function handleLeaveRoom(roomId: string)')
    expect(source).toContain('await store.leaveRoom(roomId)')
    expect(source).toContain('message.success(t(\'groupChat.roomLeft\'))')
    expect(source).toContain('<NPopconfirm v-if="room.canLeave !== false" @positive-click="handleLeaveRoom(room.id)">')
    expect(source).toContain('class="room-action-btn leave"')
    expect(source).toContain(":title=\"t('groupChat.leaveRoom')\"")
    expect(source).toContain(":aria-label=\"t('groupChat.leaveRoom')\"")
    expect(source).toContain("{{ t('groupChat.leaveRoomConfirm') }}")
  })

  it('exposes invite-code joining in the room sidebar', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("const joinInviteCode = ref('')")
    expect(source).toContain('const canJoinByInviteCode = computed(() => !!joinInviteCode.value.trim() && !isJoiningByInviteCode.value)')
    expect(source).toContain('async function handleJoinByInviteCode()')
    expect(source).toContain('const code = joinInviteCode.value')
    expect(source).toContain('const room = await store.joinByCode(code)')
    expect(source).toContain('await router.push({ name: \'hermes.groupChatRoom\', params: { roomId: room.id } })')
    expect(source).toContain('<form class="invite-join-form" @submit.prevent="handleJoinByInviteCode">')
    expect(source).toContain('v-model:value="joinInviteCode"')
    expect(source).toContain(':placeholder="t(\'groupChat.enterCode\')"')
    expect(source).toContain('attr-type="submit"')
    expect(source).toContain("{{ t('groupChat.joinByCode') }}")
  })
})
