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
    expect(source).toContain('v-if="currentRoomCanManage"')
    expect(source).toContain('class="agent-avatar-stop"')
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

  it('renders room agents as an avatar-only rail on the left of the chat surface', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const headerInfo = source.slice(
      source.indexOf('<div class="header-info">'),
      source.indexOf('</div>', source.indexOf('<div class="header-info">')),
    )
    const rail = source.slice(
      source.indexOf('class="agent-avatar-rail"'),
      source.indexOf('<div class="group-chat-surface">'),
    )

    expect(headerInfo).not.toContain('avatar-stack-trigger')
    expect(rail).toContain('v-for="member in railMembers"')
    expect(rail).toContain('v-for="agent in store.agents"')
    expect(rail).toContain('class="agent-avatar-rail-item"')
    expect(rail).toContain(':avatar="memberAvatarFor(member)"')
    expect(rail).toContain('@click="handleRoomMemberClick(member)"')
    expect(rail).toContain('@click="handleEditAgent(agent)"')
    expect(rail).toContain('class="agent-avatar-rail-add"')
    expect(rail).not.toContain('avatar-stack-more')
    expect(source).not.toContain('transform: translateY(-1px)')
    expect(source).toContain('const participantCount = computed(() => railMembers.value.length + store.agents.length)')
    expect(source).toContain('const showMemberRail = ref(true)')
    expect(source).toContain('@click="showMemberRail = !showMemberRail"')
    expect(source).toContain('overflow-y: auto')
  })

  it('moves active agent status and interruption from the input status bar to the avatar rail', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("function agentContextStatus(agent: RoomAgent)")
    expect(source).toContain("'agent-avatar-rail-active': !!agentContextStatus(agent)")
    expect(source).toContain(':disabled="!agentContextStatus(agent)"')
    expect(source).toContain('@click.stop="handleInterruptAgent(agent.name)"')
    expect(source).toContain('animation: agent-avatar-rainbow-glow 4s linear infinite')
    expect(source).toContain('@keyframes agent-avatar-rainbow-glow')
    expect(source).toContain('0 0 0 2px #ff6b6b')
    expect(source).toContain('0 0 0 2px #48dbfb')
    expect(source).toContain('0 0 0 2px #5f27cd')
    expect(source).toContain('flex: 0 0 72px')
    expect(source).toContain('width: 72px')
    expect(source).not.toContain('class="status-bar"')
    expect(source).not.toContain(':title="`${agent.name}\\n${agentRuntimeLabel(agent)}`"')
  })

  it('wires invite-code rotation into the manageable room settings modal', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("const inviteCodeDraft = ref('')")
    expect(source).toContain('const canUpdateInviteCode = computed(() => {')
    expect(source).toContain('await store.setRoomInviteCode(store.currentRoomId, nextCode)')
    expect(source).toContain("<h3>{{ t('groupChat.roomSettings') }}</h3>")
    expect(source).toContain("<h4>{{ t('groupChat.inviteCodeSettings') }}</h4>")
    expect(source).toContain('v-model:value="inviteCodeDraft"')
    expect(source).toContain('@click="handleSaveInviteCode"')
    expect(source).toContain(":title=\"t('groupChat.roomSettings')\"")
  })

  it('creates room agents with the single-chat api mode rules and keeps Hermes profile-owned', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("const selectedAgentProvider = ref('')")
    expect(source).toContain("const selectedAgentModel = ref('')")
    expect(source).toContain("const selectedAgentApiMode = ref<CodingAgentApiMode>('codex_responses')")
    expect(source).toContain("const selectedAgentReasoningEffort = ref('')")
    expect(source).toContain('provider: selectedAgentProvider.value')
    expect(source).toContain('model: selectedAgentModel.value')
    expect(source).toContain("apiMode: selectedAgentType.value === 'hermes' ? undefined : selectedAgentApiMode.value")
    expect(source).toContain('reasoningEffort: selectedAgentReasoningEffort.value')
    expect(source).toContain('inferCodingAgentApiMode(')
    expect(source).toContain('normalizeCodingAgentApiMode(')
    expect(source).toContain("v-if=\"selectedAgentType !== 'hermes'\"")
    expect(source).toContain('agent: selectedAgentType.value')
    expect(source).toContain("{ label: 'Hermes', value: 'hermes' }")
    expect(source).toContain("{ label: 'Claude Code', value: 'claude' }")
    expect(source).toContain("{ label: 'Codex', value: 'codex' }")
    expect(source).toContain("{ label: 'Ekko Agent', value: 'ekko' }")
    expect(source).toContain('v-model:value="agentName"')
    expect(source).toContain('v-model:value="agentDescription"')
    expect(source).toContain('avatar: agentAvatar.value ? JSON.stringify(agentAvatar.value)')
    expect(source).toContain('@click="handleRandomAgentAvatar"')
    expect(source).toContain('@change="handleAgentAvatarFileChange"')
    expect(source).toContain(':avatar="groupAgentAvatar(agent)"')
  })
})
