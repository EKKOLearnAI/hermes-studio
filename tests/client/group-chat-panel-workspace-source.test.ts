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

    expect(source).toContain('const currentRoomCanManage = computed(() => !props.standalone && canManageRoom(currentRoom.value))')
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

  it('shows rolling-summary progress above the input like a single-chat tool call', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const headerLeft = source.slice(
      source.indexOf('<div class="header-left">'),
      source.indexOf('<div class="header-info">'),
    )
    const inlineStatus = source.slice(
      source.indexOf('<Transition name="summary-inline">'),
      source.indexOf('<GroupChatInput'),
    )

    expect(headerLeft).not.toContain('room-summary-header-status')
    expect(inlineStatus).toContain('class="group-summary-inline-status"')
    expect(inlineStatus).toContain("inlineSummaryStatus.status === 'summarizing'")
    expect(inlineStatus).toContain('class="group-summary-inline-spinner"')
    expect(inlineStatus).toContain("inlineSummaryStatus.status === 'success'")
    expect(inlineStatus).toContain('class="group-summary-inline-success-icon"')
    expect(inlineStatus).toContain('class="group-summary-inline-error-icon"')
    expect(inlineStatus).not.toContain('group-summary-inline-type-icon')
    expect(source.indexOf('<Transition name="summary-inline">')).toBeLessThan(source.indexOf('<GroupChatInput'))
    expect(source).not.toContain("message.loading(roomSummaryStatusLabel('summarizing')")
    expect(source).not.toContain("message.success(roomSummaryStatusLabel('success'))")
  })

  it('keeps agent actions visible while human message actions remain hover-only on desktop', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageItem.vue', 'utf8')

    expect(source).toMatch(/\.message-meta\s*\{[^}]*opacity: 1;/s)
    expect(source).toContain('.group-message:not(.agent)')
    expect(source).toMatch(/\.group-message:not\(\.agent\)[\s\S]*?\.message-meta\s*\{[^}]*opacity: 0;/)
    expect(source).toContain('&:hover .message-meta')
    expect(source).toContain('&:focus-within .message-meta')
    expect(source).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.group-message:not\(\.agent\) \.message-meta\s*\{[^}]*opacity: 1;/)
  })

  it('matches the single-chat bubble radius without an outer agent run border', () => {
    const groupRunCard = readFileSync('packages/client/src/components/hermes/group-chat/GroupAgentRunCard.vue', 'utf8')
    const singleMessage = readFileSync('packages/client/src/components/hermes/chat/MessageItem.vue', 'utf8')
    const runCardStyles = groupRunCard.slice(
      groupRunCard.indexOf('.run-card {'),
      groupRunCard.indexOf('.run-time {'),
    )

    expect(singleMessage).toMatch(/\.message-bubble\s*\{[^}]*border-radius: 10px;/s)
    expect(runCardStyles).toContain('border: none;')
    expect(runCardStyles).toContain('border-radius: 10px;')
    expect(runCardStyles).not.toContain('border-color:')
  })

  it('opens summary settings and preserves the draft when a legacy room has no summarizer', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const input = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatInput.vue', 'utf8')

    expect(panel).toContain('const currentRoomNeedsSummaryConfiguration = computed(() => {')
    expect(panel).toContain("!String(room.summaryProvider || '').trim()")
    expect(panel).toContain("!String(room.summaryModel || '').trim()")
    expect(panel).toContain(':send-blocked="currentRoomNeedsSummaryConfiguration"')
    expect(panel).toContain('@send-blocked="handleSummaryConfigurationRequired"')
    expect(panel).toContain("message.warning(t('groupChat.summaryConfigurationRequired'))")
    expect(panel).toContain('void handleOpenRoomSettings()')
    expect(panel).toContain('summarySettingsSectionRef.value?.scrollIntoView')
    expect(input).toContain("emit('send-blocked')")
    expect(input.indexOf("emit('send-blocked')")).toBeLessThan(input.indexOf("inputText.value = ''"))
  })

  it('places the group files, terminal, and browser drawer control beside settings', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const headerInfo = source.slice(
      source.indexOf('<div class="header-info">'),
      source.indexOf('<NPopconfirm v-if="currentRoomCanManage" @positive-click="handleClearRoomContext">'),
    )

    expect(headerInfo).toContain('class="icon-btn workspace-panel-toggle"')
    expect(headerInfo).toContain('class="icon-btn compression-settings-button"')
    expect(headerInfo).toContain('@click="toggleWorkspacePanel"')
    expect(source).toContain("const activeWorkspacePanel = ref<'files' | 'terminal' | 'browser'>('files')")
    expect(source).toContain("selectWorkspacePanel('terminal')")
    expect(source).toContain('<TerminalPanel')
    expect(source).toContain("t('drawer.terminal')")
    expect(source).toContain("t('browser.title')")
    expect(source).toContain('class="group-tool-tabs"')
    expect(source).toContain('class="group-tool-content"')
    expect(source).toContain('class="group-workspace-empty"')
    expect(source).not.toContain(':disabled="!currentRoom?.workspace"')
    expect(source).toContain('flex-direction: row')
    expect(source).toContain('order: 2')
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
    expect(rail).toContain(':key="member.userId"')
    expect(rail).toContain('v-for="agent in store.agents"')
    expect(rail).toContain('class="agent-avatar-rail-item"')
    expect(rail).toContain(':avatar="memberAvatarFor(member)"')
    expect(rail).toContain("'agent-avatar-rail-typing': member.userId !== store.userId && store.isUserTyping(member.userId)")
    expect(rail).toContain('@click="handleRoomMemberClick(member)"')
    expect(rail).toContain('@click="handleAgentRailClick(agent)"')
    expect(rail).not.toContain(':disabled="!currentRoomCanManage"')
    expect(rail).toContain('class="agent-avatar-rail-add"')
    expect(rail).not.toContain('avatar-stack-more')
    expect(source).not.toContain('transform: translateY(-1px)')
    expect(source).toContain('const participantCount = computed(() => railMembers.value.length + store.agents.length)')
    expect(source).toContain('const showMemberRail = ref(true)')
    expect(source).toContain('@click="showMemberRail = !showMemberRail"')
    expect(source).toContain('overflow-y: auto')
    expect(source).toContain('animation: member-avatar-typing-breathe 1.6s ease-in-out infinite')
    expect(source).toContain('@keyframes member-avatar-typing-breathe')
  })

  it('keeps invite-only chat free of settings and speech controls', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const input = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatInput.vue', 'utf8')
    const message = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageItem.vue', 'utf8')

    expect(panel).toContain(':show-settings="!props.standalone"')
    expect(panel).toContain(':allow-speech="!props.standalone"')
    expect(input).toContain('v-if="props.showSettings"')
    expect(input).toContain('store.setAutoPlaySpeech(false)')
    expect(message).toContain('if (!props.allowSpeech) return false')
    expect(message).toContain('v-if="canPlaySpeech"')
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

  it('shows agent runtime details when hovering message avatars and can insert a mention into the group input', () => {
    const panelSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const avatarSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupAgentMessageAvatar.vue', 'utf8')
    const itemSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageItem.vue', 'utf8')
    const runCardSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupAgentRunCard.vue', 'utf8')

    expect(avatarSource).toContain('class="message-agent-popover"')
    expect(avatarSource).toContain("t('workflow.profile')")
    expect(avatarSource).toContain("t('profiles.provider')")
    expect(avatarSource).toContain("t('profiles.model')")
    expect(avatarSource).toContain('class="message-agent-mention"')
    expect(avatarSource).toContain("@click.stop=\"emit('mention', agent)\"")
    expect(itemSource).toContain('<GroupAgentMessageAvatar')
    expect(runCardSource).toContain('<GroupAgentMessageAvatar')
    expect(runCardSource).not.toContain('run-agent-description')
    expect(panelSource).toContain('@mention-agent="handleMentionAgent"')
    expect(panelSource).toContain('groupChatInputRef.value?.insertMention?.(agent.name)')
    expect(panelSource).not.toContain('class="agent-avatar-popover"')
  })

  it('loads persisted room summary state for the inline transcript anchor without a locate action', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain('async function loadRoomSummaryState(roomId: string)')
    expect(source).toContain('if (roomId && !props.standalone) void loadRoomSummaryState(roomId)')
    expect(source).not.toContain('handleLocateSummaryAnchor')
    expect(source).not.toContain('@click="handleLocateSummaryAnchor"')
  })

  it('fades the group chat surface when switching between rooms like single chat', () => {
    const groupSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const singleSource = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(groupSource).toContain('ref="groupChatSurfaceRef"')
    expect(groupSource).toContain('if (!roomId || !previousRoomId || roomId === previousRoomId) return')
    expect(groupSource).toContain('roomFadeAnimation?.cancel()')
    expect(groupSource).toContain('roomFadeAnimation = surface.animate(')
    expect(groupSource).toContain('duration: 1500')
    expect(groupSource).toContain("easing: 'ease'")
    expect(groupSource).toContain("{ flush: 'post' }")
    expect(singleSource).toContain('duration: 1500')
    expect(singleSource).toContain('easing: "ease"')
  })

  it('shows the refactor notice once and persists acknowledgement locally', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("const GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY = 'hermes.groupChat.refactorNotice.v1.acknowledged'")
    expect(source).toContain("window.localStorage.getItem(GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY) !== '1'")
    expect(source).toContain("window.localStorage.setItem(GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY, '1')")
    expect(source).toContain('v-model:show="showGroupChatRefactorNotice"')
    expect(source).toContain(':mask-closable="false"')
    expect(source).toContain(':close-on-esc="false"')
    expect(source).toContain("t('groupChat.refactorNoticeMessage')")
    expect(source).toContain('@click="acknowledgeGroupChatRefactorNotice"')
  })

  it('renders room creation and manageable room settings as right-side drawers', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("const inviteCodeDraft = ref('')")
    expect(source).toContain('const canUpdateInviteCode = computed(() => {')
    expect(source).toContain('await store.setRoomInviteCode(store.currentRoomId, nextCode)')
    expect(source).toContain('<NDrawer v-model:show="showCreateModal" placement="right"')
    expect(source).toContain('<NDrawerContent :title="t(\'groupChat.createRoom\')" closable>')
    expect(source).toContain('v-model:show="showRoomSettingsModal"')
    expect(source).toContain('<NDrawerContent :title="t(\'groupChat.roomSettings\')" closable>')
    expect(source).toContain('v-model:value="roomNameDraft"')
    expect(source).toContain("updateRoomConfig(store.currentRoomId, { name: roomNameDraft.value.trim() })")
    expect(source).toContain("<h4>{{ t('groupChat.inviteCodeSettings') }}</h4>")
    expect(source).toContain('v-model:value="inviteCodeDraft"')
    expect(source).toContain('@click="handleSaveInviteCode"')
    expect(source).toContain("<h4>{{ t('chat.setWorkspaceTitle') }}</h4>")
    expect(source).toContain('<FolderPicker v-model="workspaceValue" />')
    expect(source).toContain('@click="handleSaveWorkspace"')
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
