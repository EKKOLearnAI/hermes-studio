<script setup lang="ts">
import { ref, computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useMessage, NInput, NButton, NSpace, NSelect, NPopconfirm, NInputNumber, NDropdown, NModal, NPopover, NDrawer, NDrawerContent, type DropdownOption } from 'naive-ui'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { getRoomSummary, updateRoomConfig, updateRoomSummary } from '@/api/hermes/group-chat'
import GroupMessageList from './GroupMessageList.vue'
import GroupChatInput from './GroupChatInput.vue'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import SettingsCircuitBadge from '@/components/layout/SettingsCircuitBadge.vue'
import { copyToClipboard } from '@/utils/clipboard'
import type { Attachment } from '@/stores/hermes/chat'
import type { MemberInfo, RoomAgent, RoomInfo, RoomSummaryAnchor, RoomSummaryConfig, RoomSummaryState } from '@/api/hermes/group-chat'
import { useFilesStore } from '@/stores/hermes/files'
import { useToolPanelStore } from '@/stores/hermes/tool-panel'
import { hasDesktopBrowserBridge } from '@/utils/desktop-bridge'
import { OPEN_DESKTOP_BROWSER_PANEL_EVENT } from '@/utils/desktop-browser'
import { canScopedCodingAgentUseProvider } from '@/utils/codingAgentProviders'
import {
    inferCodingAgentApiMode,
    normalizeCodingAgentApiMode,
    type CodingAgentApiMode,
} from '@/api/coding-agents'
import type { ProfileAvatar as ProfileAvatarData } from '@/api/hermes/profiles'
import {
    defaultGroupAgentAvatar,
    groupAgentAvatar,
    parseStoredAvatar,
} from '@/utils/group-agent-avatar'

const FilesPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/FilesPanel.vue')).default)
const FilePreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/FilePreview.vue')).default)
const WorkspaceDiffPreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/WorkspaceDiffPreview.vue')).default)
const DesktopBrowserPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/DesktopBrowserPanel.vue')).default)
const TerminalPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/TerminalPanel.vue')).default)

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const appStore = useAppStore()
const store = useGroupChatStore()
const profilesStore = useProfilesStore()
const filesStore = useFilesStore()
const toolPanelStore = useToolPanelStore()

const showSidebar = ref(window.innerWidth > 768)
watch(
    showSidebar,
    expanded => appStore.setPageSidebarExpanded(expanded),
    { immediate: true },
)
const showCreateModal = ref(false)
const showCloneModal = ref(false)
const showAddAgentModal = ref(false)
const showGroupChatRefactorNotice = ref(false)
const showMemberRail = ref(true)
const editingAgent = ref<RoomAgent | null>(null)
const isSavingAgent = ref(false)
const showRoomSettingsModal = ref(false)
const showUserProfileModal = ref(false)
const userProfileName = ref('')
const userProfileDescription = ref('')
const isSavingUserProfile = ref(false)
const summaryConfig = ref<RoomSummaryConfig>({
    summaryProfile: 'default',
    summaryProvider: '',
    summaryModel: '',
    summaryApiMode: 'chat_completions',
    summaryEveryTurns: 20,
})
const roomSummaryState = ref<RoomSummaryState | null>(null)
const roomSummaryAnchor = ref<RoomSummaryAnchor | null>(null)
const roomSummaryDraft = ref('')
const isLoadingRoomSummary = ref(false)
const isSavingRoomSummary = ref(false)
const inlineSummaryStatus = ref<{
    roomId: string
    status: 'summarizing' | 'success' | 'failed'
    error: string
} | null>(null)
let inlineSummaryStatusTimer: ReturnType<typeof setTimeout> | null = null
const roomNameDraft = ref('')
const isSavingRoomName = ref(false)
const inviteCodeDraft = ref('')
const isSavingInviteCode = ref(false)
const selectedAgentType = ref<GroupAgentType>('hermes')
const selectedProfile = ref<string | null>(null)
const selectedAgentProvider = ref('')
const selectedAgentModel = ref('')
const selectedAgentApiMode = ref<CodingAgentApiMode>('codex_responses')
const selectedAgentReasoningEffort = ref('')
const agentName = ref('')
const agentDescription = ref('')
const agentAvatar = ref<ProfileAvatarData | null>(null)
const agentAvatarFileInput = ref<HTMLInputElement | null>(null)
const cloneSourceRoomId = ref<string | null>(null)
const cloneRoomName = ref('')
const cloneInviteCode = ref('')
const contextRoomId = ref<string | null>(null)
const showRoomContextMenu = ref(false)
const roomContextMenuX = ref(0)
const roomContextMenuY = ref(0)
const groupChatInputRef = ref<(InstanceType<typeof GroupChatInput> & {
    addFiles?: (files: File[]) => void
    insertMention?: (name: string) => void
}) | null>(null)
const summarySettingsSectionRef = ref<HTMLElement | null>(null)
const chatDropCounter = ref(0)
const isChatDropActive = ref(false)
const groupChatContentWrapperRef = ref<HTMLElement | null>(null)
const groupChatSurfaceRef = ref<HTMLElement | null>(null)
let roomFadeAnimation: Animation | null = null
const showWorkspacePanel = ref(false)
const activeWorkspacePanel = ref<'files' | 'terminal' | 'browser'>('files')
const desktopBrowserAvailable = hasDesktopBrowserBridge()
const workspacePanelMobile = ref(window.innerWidth <= 768)
const GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY = 'hermes.groupChat.refactorNotice.v1.acknowledged'
const WORKSPACE_PANEL_MIN_WIDTH = 360
const WORKSPACE_PANEL_DEFAULT_WIDTH = 560
const WORKSPACE_PANEL_STORAGE_KEY = 'hermes.groupChat.workspacePanelWidth'
const workspacePanelWidth = ref(loadWorkspacePanelWidth())
const workspaceResizeStart = ref<{ x: number; width: number; deltaSign: 1 | -1 } | null>(null)
const workspacePanelStyle = computed(() => ({
    width: workspacePanelMobile.value ? '100%' : `${workspacePanelWidth.value}px`,
}))

const profileOptions = computed(() =>
    profilesStore.profiles.map(p => ({ label: p.name, value: p.name }))
)

type GroupAgentType = 'hermes' | 'ekko' | 'codex' | 'claude'

const groupAgentTypeOptions = computed<Array<{ label: string; value: GroupAgentType }>>(() => [
    { label: 'Hermes', value: 'hermes' },
    { label: 'Claude Code', value: 'claude' },
    { label: 'Codex', value: 'codex' },
    { label: 'Ekko Agent', value: 'ekko' },
])

function getAgentModelGroups(profile: string) {
    return (appStore.profileModelGroups.find(entry => entry.profile === profile)?.groups || [])
        .filter((group) => {
            if (group.provider === 'moa') return selectedAgentType.value === 'hermes'
            if (selectedAgentType.value === 'hermes') return true
            const codingAgentId = selectedAgentType.value === 'ekko'
                ? 'ekko-agent'
                : selectedAgentType.value === 'claude'
                    ? 'claude-code'
                    : 'codex'
            return canScopedCodingAgentUseProvider(codingAgentId, group.provider)
        })
}

function getDefaultAgentModel(profile: string) {
    const groups = getAgentModelGroups(profile)
    const selectedGroup = groups.find(group => group.provider === appStore.selectedProvider)
    if (
        profile === profilesStore.activeProfileName &&
        selectedGroup?.models.includes(appStore.selectedModel)
    ) {
        return { provider: appStore.selectedProvider, model: appStore.selectedModel }
    }
    const profileModels = appStore.profileModelGroups.find(entry => entry.profile === profile)
    const defaultGroup = groups.find(group => group.provider === profileModels?.default_provider)
    const fallbackGroup = defaultGroup || groups.find(group => group.models.length > 0)
    return {
        provider: fallbackGroup?.provider || '',
        model: fallbackGroup?.models.includes(profileModels?.default || '')
            ? profileModels?.default || ''
            : fallbackGroup?.models[0] || '',
    }
}

const agentProviderOptions = computed(() =>
    getAgentModelGroups(selectedProfile.value || '').map(group => ({
        label: group.label || group.provider,
        value: group.provider,
    }))
)

const agentModelOptions = computed(() => {
    const group = getAgentModelGroups(selectedProfile.value || '')
        .find(item => item.provider === selectedAgentProvider.value)
    return (group?.models || []).map(modelId => ({
        label: appStore.displayModelName(modelId, group?.provider),
        value: modelId,
    }))
})

const selectedAgentProviderGroup = computed(() =>
    getAgentModelGroups(selectedProfile.value || '')
        .find(item => item.provider === selectedAgentProvider.value)
)

const agentApiModeOptions = computed(() => [
    { label: t('codingAgents.protocolOpenAiChat'), value: 'chat_completions' },
    { label: t('codingAgents.protocolOpenAiResponses'), value: 'codex_responses' },
    { label: t('codingAgents.protocolAnthropicMessages'), value: 'anthropic_messages' },
])

const agentReasoningEffortOptions = computed(() => [
    { label: t('chat.reasoningEffort.options.default'), value: '' },
    { label: t('chat.reasoningEffort.options.none'), value: 'none' },
    { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
    { label: t('chat.reasoningEffort.options.low'), value: 'low' },
    { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
    { label: t('chat.reasoningEffort.options.high'), value: 'high' },
    { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
    { label: t('chat.reasoningEffort.options.max'), value: 'max' },
])

const summaryModelGroups = computed(() =>
    (appStore.profileModelGroups.find(entry => entry.profile === summaryConfig.value.summaryProfile)?.groups || [])
        .filter(group => group.provider !== 'moa' && canScopedCodingAgentUseProvider('ekko-agent', group.provider))
)
const summaryProviderOptions = computed(() => summaryModelGroups.value.map(group => ({
    label: group.label || group.provider,
    value: group.provider,
})))
const selectedSummaryProviderGroup = computed(() =>
    summaryModelGroups.value.find(group => group.provider === summaryConfig.value.summaryProvider)
)
const summaryModelOptions = computed(() =>
    (selectedSummaryProviderGroup.value?.models || []).map(model => ({
        label: appStore.displayModelName(model, summaryConfig.value.summaryProvider),
        value: model,
    }))
)
const summaryApiModeOptions = computed(() => [
    { label: t('codingAgents.protocolOpenAiChat'), value: 'chat_completions' },
    { label: t('codingAgents.protocolOpenAiResponses'), value: 'codex_responses' },
    { label: t('codingAgents.protocolAnthropicMessages'), value: 'anthropic_messages' },
])
const liveRoomSummaryState = computed(() => {
    const roomId = store.currentRoomId
    return (roomId && store.roomSummaryStates.get(roomId)) || roomSummaryState.value
})

function clearInlineSummaryStatusTimer() {
    if (inlineSummaryStatusTimer === null) return
    clearTimeout(inlineSummaryStatusTimer)
    inlineSummaryStatusTimer = null
}

function hideInlineSummaryStatus() {
    clearInlineSummaryStatusTimer()
    inlineSummaryStatus.value = null
}

watch(
    () => {
        const state = liveRoomSummaryState.value
        return state ? `${state.roomId}:${state.version}:${state.status}:${state.updatedAt}` : ''
    },
    async () => {
        const state = liveRoomSummaryState.value
        if (!state || state.roomId !== store.currentRoomId) {
            hideInlineSummaryStatus()
            return
        }
        if (state.status === 'summarizing') {
            clearInlineSummaryStatusTimer()
            inlineSummaryStatus.value = {
                roomId: state.roomId,
                status: 'summarizing',
                error: '',
            }
        } else if (
            (state.status === 'success' || state.status === 'failed')
            && inlineSummaryStatus.value?.roomId === state.roomId
            && inlineSummaryStatus.value.status === 'summarizing'
        ) {
            inlineSummaryStatus.value = {
                roomId: state.roomId,
                status: state.status,
                error: state.status === 'failed' ? String(state.lastError || '').trim() : '',
            }
            clearInlineSummaryStatusTimer()
            const completedRoomId = state.roomId
            inlineSummaryStatusTimer = setTimeout(() => {
                if (inlineSummaryStatus.value?.roomId === completedRoomId) {
                    inlineSummaryStatus.value = null
                }
                inlineSummaryStatusTimer = null
            }, state.status === 'failed' ? 6000 : 3000)
        }
        if (!showRoomSettingsModal.value) return
        roomSummaryState.value = state
        if (state.status === 'success') roomSummaryDraft.value = state.summary
        try {
            roomSummaryAnchor.value = (await getRoomSummary(state.roomId)).anchor
        } catch { /* the next settings open refreshes it */ }
    },
    { flush: 'sync' },
)

function handleSummaryProviderChange(provider: string) {
    summaryConfig.value.summaryProvider = provider
    const group = summaryModelGroups.value.find(item => item.provider === provider)
    summaryConfig.value.summaryModel = group?.models[0] || ''
    summaryConfig.value.summaryApiMode = normalizeCodingAgentApiMode(
        group?.api_mode,
        inferCodingAgentApiMode(group?.provider || provider, group?.base_url),
    )
}

const agentAvatarPreview = computed(() =>
    agentAvatar.value || defaultGroupAgentAvatar(selectedAgentType.value)
)

const canConfirmAddAgent = computed(() =>
    Boolean(
        selectedProfile.value &&
        selectedAgentProvider.value &&
        selectedAgentModel.value &&
        (selectedAgentType.value === 'hermes' || selectedAgentApiMode.value),
    )
)

function syncAgentApiMode() {
    const group = selectedAgentProviderGroup.value
    selectedAgentApiMode.value = normalizeCodingAgentApiMode(
        group?.api_mode,
        inferCodingAgentApiMode(group?.provider || selectedAgentProvider.value, group?.base_url),
    )
}

function syncAgentModelSelection(profile: string) {
    const defaults = getDefaultAgentModel(profile)
    selectedAgentProvider.value = defaults.provider
    selectedAgentModel.value = defaults.model
    syncAgentApiMode()
}

function handleAgentProfileChange(profile: string) {
    selectedProfile.value = profile
    syncAgentModelSelection(profile)
}

function handleAgentTypeChange(agent: GroupAgentType) {
    selectedAgentType.value = agent
    if (selectedProfile.value) syncAgentModelSelection(selectedProfile.value)
}

function handleAgentProviderChange(provider: string) {
    selectedAgentProvider.value = provider
    selectedAgentModel.value = agentModelOptions.value[0]?.value || ''
    syncAgentApiMode()
}

function agentAvatarName(agent: RoomAgent): string {
    return agent.agent || 'hermes'
}

function agentContextStatus(agent: RoomAgent): { agentName: string; status: string } | undefined {
    return store.contextStatuses.get(agent.name)
        || Array.from(store.contextStatuses.values()).find(status => status.agentName === agent.name)
}

function agentActivityLabel(agent: RoomAgent): string {
    return agentContextStatus(agent)?.status === 'compressing'
        ? t('groupChat.agentCompressing')
        : t('groupChat.agentReplying')
}

function handleMentionAgent(agent: RoomAgent) {
    groupChatInputRef.value?.insertMention?.(agent.name)
}

const hasRoom = computed(() => !!store.currentRoomId)
const currentRoom = computed(() => store.rooms.find(room => room.id === store.currentRoomId) || null)
const contextRoom = computed(() => store.rooms.find(room => room.id === contextRoomId.value) || null)
function canManageRoom(room: Pick<RoomInfo, 'canManage'> | null | undefined): boolean {
    return room?.canManage === true
}
const currentRoomCanManage = computed(() => canManageRoom(currentRoom.value))
const currentRoomNeedsSummaryConfiguration = computed(() => {
    const room = currentRoom.value
    if (!room) return false
    return !String(room.summaryProfile || '').trim()
        || !String(room.summaryProvider || '').trim()
        || !String(room.summaryModel || '').trim()
        || !String(room.summaryApiMode || '').trim()
        || Number(room.summaryEveryTurns || 0) < 1
})
const railMembers = computed<MemberInfo[]>(() => {
    if (store.members.some(member => member.userId === store.userId)) return store.members
    return [{
        id: `current:${store.userId}`,
        userId: store.userId,
        name: store.userName || t('groupChat.you'),
        description: '',
        joinedAt: 0,
        avatar: store.currentUserAvatar,
    }, ...store.members]
})
const participantCount = computed(() => railMembers.value.length + store.agents.length)
const visibleApproval = computed(() => currentRoomCanManage.value ? store.activePendingApproval : null)
const currentWorkspaceLabel = computed(() => workspaceBasename(currentRoom.value?.workspace || ''))
const groupToolPanelTitle = computed(() => desktopBrowserAvailable
    ? `${t('drawer.files')} / ${t('drawer.terminal')} / ${t('browser.title')}`
    : `${t('drawer.files')} / ${t('drawer.terminal')}`
)
const canUpdateRoomName = computed(() => {
    const nextName = roomNameDraft.value.trim()
    return currentRoomCanManage.value
        && !isSavingRoomName.value
        && !!nextName
        && nextName !== (currentRoom.value?.name || '')
})
const canUpdateInviteCode = computed(() => {
    const nextCode = inviteCodeDraft.value.trim()
    return currentRoomCanManage.value && !isSavingInviteCode.value && !!nextCode && nextCode !== (currentRoom.value?.inviteCode || '')
})
const showWorkspaceModal = ref(false)
const workspaceRoomId = ref<string | null>(null)
const workspaceValue = ref('')

/** Resolve the current user's custom avatar — first from the member list, then from the cached current-user value. */
const userMemberAvatar = computed(() => {
    // Prefer the live member list (populated when a room is active)
    const member = store.members.find(m => m.userId === store.userId)
    const raw = member?.avatar || store.currentUserAvatar
    return parseMemberAvatar(raw)
})

function parseMemberAvatar(raw: unknown) {
    return parseStoredAvatar(raw)
}

function memberAvatarFor(member: MemberInfo) {
    return member.userId === store.userId ? userMemberAvatar.value : parseMemberAvatar(member.avatar)
}

function handleRoomMemberClick(member: MemberInfo) {
    if (member.userId === store.userId) handleOpenUserProfile()
}

function formatTokens(tokens: number): string {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`
    return `${tokens} tokens`
}

function workspaceBasename(path: string): string {
    const trimmed = String(path || '').trim().replace(/[\\/]+$/, '')
    if (!trimmed) return ''
    return trimmed.split(/[\\/]/).pop() || trimmed
}

function toggleSidebar() {
    showSidebar.value = !showSidebar.value
}

function loadWorkspacePanelWidth(): number {
    const saved = Number.parseInt(window.localStorage.getItem(WORKSPACE_PANEL_STORAGE_KEY) || '', 10)
    return Number.isFinite(saved) ? saved : WORKSPACE_PANEL_DEFAULT_WIDTH
}

function workspacePanelMaxWidth(): number {
    if (workspacePanelMobile.value) return window.innerWidth
    const available = groupChatContentWrapperRef.value?.clientWidth || window.innerWidth
    return Math.max(320, Math.min(Math.floor(available * 0.88), available - 120))
}

function clampWorkspacePanelWidth(width: number): number {
    const maxWidth = workspacePanelMaxWidth()
    return Math.min(maxWidth, Math.max(Math.min(WORKSPACE_PANEL_MIN_WIDTH, maxWidth), Math.round(width)))
}

function handleWorkspacePanelResize(): void {
    workspacePanelMobile.value = window.innerWidth <= 768
    if (!workspacePanelMobile.value) workspacePanelWidth.value = clampWorkspacePanelWidth(workspacePanelWidth.value)
}

function handleWorkspaceResizeMove(event: PointerEvent): void {
    if (!workspaceResizeStart.value) return
    workspacePanelWidth.value = clampWorkspacePanelWidth(
        workspaceResizeStart.value.width
            + (event.clientX - workspaceResizeStart.value.x) * workspaceResizeStart.value.deltaSign,
    )
}

function stopWorkspaceResize(): void {
    if (!workspaceResizeStart.value) return
    workspaceResizeStart.value = null
    window.removeEventListener('pointermove', handleWorkspaceResizeMove)
    window.removeEventListener('pointerup', stopWorkspaceResize)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    if (!workspacePanelMobile.value) {
        window.localStorage.setItem(WORKSPACE_PANEL_STORAGE_KEY, String(workspacePanelWidth.value))
    }
}

function startWorkspaceResize(event: PointerEvent): void {
    if (workspacePanelMobile.value) return
    event.preventDefault()
    workspaceResizeStart.value = {
        x: event.clientX,
        width: workspacePanelWidth.value,
        deltaSign: document.documentElement.dir === 'rtl' ? 1 : -1,
    }
    window.addEventListener('pointermove', handleWorkspaceResizeMove)
    window.addEventListener('pointerup', stopWorkspaceResize)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
}

function closeWorkspacePanel(): void {
    if (toolPanelStore.workspaceDiff?.editable && filesStore.hasUnsavedChanges) {
        message.warning(t('files.unsavedChanges'))
        return
    }
    if (toolPanelStore.workspaceDiff?.editable && filesStore.editingFile) filesStore.closeEditor()
    filesStore.closePreview()
    toolPanelStore.closeWorkspaceDiff()
    showWorkspacePanel.value = false
}

function toggleWorkspacePanel(): void {
    if (showWorkspacePanel.value) {
        closeWorkspacePanel()
        return
    }
    showWorkspacePanel.value = true
}

function openWorkspaceFilesPanel(): void {
    if (!currentRoom.value?.workspace) return
    if (showWorkspacePanel.value && activeWorkspacePanel.value === 'files') {
        closeWorkspacePanel()
        return
    }
    selectWorkspacePanel('files')
}

function selectWorkspacePanel(panel: 'files' | 'terminal' | 'browser'): void {
    if (panel === 'browser' && !desktopBrowserAvailable) return
    if (panel !== 'files') {
        if (toolPanelStore.workspaceDiff?.editable && filesStore.hasUnsavedChanges) {
            message.warning(t('files.unsavedChanges'))
            return
        }
        if (toolPanelStore.workspaceDiff?.editable && filesStore.editingFile) filesStore.closeEditor()
        filesStore.closePreview()
        toolPanelStore.closeWorkspaceDiff()
    }
    activeWorkspacePanel.value = panel
    showWorkspacePanel.value = true
}

function handleOpenDesktopBrowserPanelRequest(): void {
    selectWorkspacePanel('browser')
}

function handleBrowserAttachment(payload: { file: File }): void {
    groupChatInputRef.value?.addFiles?.([payload.file])
}

function groupWorkspacePreviewPath(filePath: string): string | null {
    const workspace = currentRoom.value?.workspace?.replace(/\\/g, '/').replace(/\/+$/, '')
    let decodedPath = filePath
    try { decodedPath = decodeURIComponent(filePath) } catch { /* server validates malformed input */ }
    const normalizedPath = decodedPath.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!normalizedPath) return null
    if (!(normalizedPath.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedPath))) return normalizedPath
    if (!workspace) return normalizedPath
    const ignoreCase = /^[a-zA-Z]:\//.test(workspace)
    const comparableWorkspace = ignoreCase ? workspace.toLowerCase() : workspace
    const comparablePath = ignoreCase ? normalizedPath.toLowerCase() : normalizedPath
    if (comparablePath.startsWith(`${comparableWorkspace}/`)) return normalizedPath.slice(workspace.length + 1)
    return normalizedPath
}

function handleWorkspaceFilePreviewRequest(event: Event): void {
    const customEvent = event as CustomEvent<{ path?: string; fileName?: string }>
    const roomId = store.currentRoomId
    const path = groupWorkspacePreviewPath(typeof customEvent.detail?.path === 'string' ? customEvent.detail.path : '')
    if (!roomId || !path || !currentRoomCanManage.value) return
    customEvent.preventDefault()
    const fileName = customEvent.detail?.fileName || path.split('/').pop() || path
    toolPanelStore.closeWorkspaceDiff()
    filesStore.closePreview()
    void filesStore.openGroupWorkspacePreview(roomId, path, fileName).catch(error => {
        message.error(error instanceof Error ? error.message : t('files.previewFailed'))
    })
}

function openPageSidebar() {
    showSidebar.value = true
}

function acknowledgeGroupChatRefactorNotice() {
    try {
        window.localStorage.setItem(GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY, '1')
    } catch {
        // The notice can still be dismissed when persistent browser storage is unavailable.
    }
    showGroupChatRefactorNotice.value = false
}

function openSettingsPage() {
    router.push({ name: 'hermes.settings' })
}

function hasDraggedFiles(event: DragEvent) {
    return Array.from(event.dataTransfer?.types || []).includes('Files')
}

function resetChatDropState() {
    chatDropCounter.value = 0
    isChatDropActive.value = false
}

function handleChatDragOver(event: DragEvent) {
    if (!hasRoom.value || !hasDraggedFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function handleChatDragEnter(event: DragEvent) {
    if (!hasRoom.value || !hasDraggedFiles(event)) return
    event.preventDefault()
    chatDropCounter.value += 1
    isChatDropActive.value = true
}

function handleChatDragLeave(event: DragEvent) {
    if (!hasRoom.value || !hasDraggedFiles(event)) return
    chatDropCounter.value -= 1
    if (chatDropCounter.value <= 0) resetChatDropState()
}

function handleChatDrop(event: DragEvent) {
    if (!hasRoom.value || !hasDraggedFiles(event)) return
    event.preventDefault()
    const files = Array.from(event.dataTransfer?.files || [])
    const target = event.target instanceof Element ? event.target : null
    resetChatDropState()
    if (!files.length || target?.closest('.chat-input-area')) return
    groupChatInputRef.value?.addFiles?.(files)
}

function handleWorkspaceFileAttach(file: File) {
    groupChatInputRef.value?.addFiles?.([file])
}

function generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)]
    }
    return code
}

function formatAgentFailures(results?: Array<{ ok: boolean; profile: string; error?: string; reason?: string }>): string | null {
    const failed = results?.filter(result => !result.ok) || []
    if (failed.length === 0) return null
    const details = failed.map(result => result.reason || result.error || result.profile).join('; ')
    return t('groupChat.agentAddFailedCount', { count: failed.length, details })
}

function extractApiErrorMessage(err: any): string {
    const raw = err?.message || ''
    const jsonStart = raw.indexOf('{')
    if (jsonStart >= 0) {
        try {
            const parsed = JSON.parse(raw.slice(jsonStart))
            if (parsed?.code === 'PROFILE_AGENT_CONNECT_FAILED' && parsed?.error) {
                return parsed.reason ? `${parsed.error}: ${parsed.reason}` : parsed.error
            }
            if (parsed?.error) return parsed.error
        } catch { /* ignore */ }
    }
    return raw || t('common.saveFailed')
}

async function handleCreateRoom(name: string, inviteCode: string, userName: string, description: string, summary: RoomSummaryConfig, workspace: string) {
    try {
        store.setUserInfo(userName, description)
        const res = await store.createNewRoom(
            name,
            inviteCode,
            undefined,
            summary,
            workspace,
            { name: userName, description },
        )
        showCreateModal.value = false
        const failureMessage = formatAgentFailures(res.agentResults)
        if (failureMessage) message.warning(failureMessage)
        else message.success(t('groupChat.roomCreated'))
        await router.push({ name: 'hermes.groupChatRoom', params: { roomId: res.room.id } })
    } catch {
        message.error(t('common.saveFailed'))
    }
}

async function handleDeleteRoom(roomId: string) {
    const room = store.rooms.find(r => r.id === roomId)
    if (!canManageRoom(room)) return
    try {
        await store.deleteRoom(roomId)
        if (store.currentRoomId === roomId) {
            await router.replace({ name: 'hermes.groupChat' })
        }
        message.success(t('groupChat.roomDeleted'))
    } catch {
        message.error(t('common.saveFailed'))
    }
}

function buildRoomUrl(roomId: string) {
    const href = router.resolve({ name: 'hermes.groupChatRoom', params: { roomId } }).href
    return `${window.location.origin}${window.location.pathname}${href}`
}

async function copyRoomLink(roomId: string) {
    const ok = await copyToClipboard(buildRoomUrl(roomId))
    if (ok) message.success(t('common.copied'))
    else message.error(t('chat.copyFailed'))
}

const roomContextMenuOptions = computed<DropdownOption[]>(() => {
    const options: DropdownOption[] = [{ label: t('groupChat.copyRoomLink'), key: 'copy-link' }]
    if (canManageRoom(contextRoom.value)) {
        options.push({ label: t('chat.setWorkspace'), key: 'set-workspace' })
        options.push({ label: t('groupChat.cloneRoom'), key: 'clone-room' })
    }
    return options
})

function handleRoomContextMenu(event: MouseEvent, roomId: string) {
    event.preventDefault()
    contextRoomId.value = roomId
    roomContextMenuX.value = event.clientX
    roomContextMenuY.value = event.clientY
    showRoomContextMenu.value = true
}

function handleRoomContextClickOutside() {
    showRoomContextMenu.value = false
}

function handleRoomContextSelect(key: string) {
    showRoomContextMenu.value = false
    const roomId = contextRoomId.value
    if (!roomId) return
    if (key === 'copy-link') {
        void copyRoomLink(roomId)
    } else if (key === 'set-workspace') {
        if (!canManageRoom(contextRoom.value)) return
        handleOpenWorkspacePicker(roomId)
    } else if (key === 'clone-room') {
        if (!canManageRoom(contextRoom.value)) return
        handleOpenCloneRoom(roomId)
    }
}

function handleOpenCloneRoom(roomId: string) {
    const room = store.rooms.find(r => r.id === roomId)
    if (!canManageRoom(room)) return
    cloneSourceRoomId.value = roomId
    cloneRoomName.value = room?.name ? `${room.name} Copy` : ''
    cloneInviteCode.value = generateCode()
    showCloneModal.value = true
}

async function confirmCloneRoom() {
    if (!cloneSourceRoomId.value || !cloneRoomName.value.trim()) return
    try {
        const res = await store.cloneRoom(cloneSourceRoomId.value, {
            name: cloneRoomName.value.trim(),
            inviteCode: cloneInviteCode.value.trim() || undefined,
        })
        showCloneModal.value = false
        cloneSourceRoomId.value = null
        cloneRoomName.value = ''
        cloneInviteCode.value = ''
        await router.push({ name: 'hermes.groupChatRoom', params: { roomId: res.room.id } })
        const failureMessage = formatAgentFailures(res.agentResults)
        if (failureMessage) message.warning(failureMessage)
        else message.success(t('groupChat.roomCloned'))
    } catch {
        message.error(t('common.saveFailed'))
    }
}

async function handleClearRoomContext() {
    if (!store.currentRoomId) return
    if (!currentRoomCanManage.value) return
    if (store.contextStatuses.size > 0) {
        message.warning(t('groupChat.compressingInProgress'))
        return
    }
    try {
        await store.clearCurrentRoomContext()
        message.success(t('groupChat.contextCleared'))
    } catch {
        message.error(t('common.deleteFailed'))
    }
}

async function handleSelectRoom(roomId: string) {
    try {
        await router.push({ name: 'hermes.groupChatRoom', params: { roomId } })
        if (window.innerWidth <= 768) showSidebar.value = false
    } catch {
        message.error(t('groupChat.joinFailed'))
    }
}

async function handleSendMessage(content: string, attachments?: Attachment[]) {
    try {
        await store.sendMessage(content, attachments)
    } catch (err: any) {
        message.error(err.message)
    }
}

async function handleSummaryConfigurationRequired() {
    if (!currentRoomCanManage.value) {
        message.warning(t('groupChat.summaryConfigurationOwnerRequired'))
        return
    }
    message.warning(t('groupChat.summaryConfigurationRequired'))
    void handleOpenRoomSettings()
    await nextTick()
    summarySettingsSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function resetAgentForm() {
    selectedProfile.value = null
    selectedAgentType.value = 'hermes'
    selectedAgentProvider.value = ''
    selectedAgentModel.value = ''
    selectedAgentApiMode.value = 'codex_responses'
    selectedAgentReasoningEffort.value = ''
    agentName.value = ''
    agentDescription.value = ''
    agentAvatar.value = null
}

function closeAgentModal() {
    showAddAgentModal.value = false
    editingAgent.value = null
    resetAgentForm()
}

async function handleAddAgent() {
    if (!currentRoomCanManage.value) return
    await Promise.all([
        profilesStore.fetchProfiles(),
        appStore.loadModels(),
    ])
    editingAgent.value = null
    resetAgentForm()
    selectedAgentType.value = 'hermes'
    selectedProfile.value =
        profilesStore.activeProfileName ||
        profilesStore.profiles.find(profile => profile.active)?.name ||
        profilesStore.profiles[0]?.name ||
        'default'
    syncAgentModelSelection(selectedProfile.value)
    selectedAgentReasoningEffort.value = ''
    showAddAgentModal.value = true
}

function randomAgentAvatarSeed() {
    return `group-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function handleRandomAgentAvatar() {
    agentAvatar.value = { type: 'generated', seed: randomAgentAvatarSeed() }
}

function handleResetAgentAvatar() {
    agentAvatar.value = null
}

function triggerAgentAvatarUpload() {
    agentAvatarFileInput.value?.click()
}

async function handleAgentAvatarFileChange(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        message.warning(t('profiles.avatar.invalidType'))
        return
    }
    if (file.size > 1024 * 1024) {
        message.warning(t('profiles.avatar.tooLarge'))
        return
    }
    try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result || ''))
            reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
            reader.readAsDataURL(file)
        })
        agentAvatar.value = { type: 'image', dataUrl }
    } catch {
        message.error(t('profiles.avatar.saveFailed'))
    }
}

async function handleEditAgent(agent: RoomAgent) {
    if (!currentRoomCanManage.value) return
    await Promise.all([
        profilesStore.fetchProfiles(),
        appStore.loadModels(),
    ])
    editingAgent.value = agent
    selectedAgentType.value = agent.agent || 'hermes'
    selectedProfile.value = agent.profile
    selectedAgentProvider.value = agent.provider || ''
    selectedAgentModel.value = agent.model || ''
    selectedAgentApiMode.value = normalizeCodingAgentApiMode(
        agent.apiMode,
        inferCodingAgentApiMode(agent.provider),
    )
    selectedAgentReasoningEffort.value = agent.reasoningEffort || ''
    agentName.value = agent.name || ''
    agentDescription.value = agent.description || ''
    agentAvatar.value = parseStoredAvatar(agent.avatar)
    showAddAgentModal.value = true
}

onMounted(() => {
    try {
        showGroupChatRefactorNotice.value = window.localStorage.getItem(GROUP_CHAT_REFACTOR_NOTICE_STORAGE_KEY) !== '1'
    } catch {
        showGroupChatRefactorNotice.value = true
    }
    window.addEventListener('hermes:open-page-sidebar', openPageSidebar)
    window.addEventListener('hermes:preview-workspace-file', handleWorkspaceFilePreviewRequest)
    window.addEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, handleOpenDesktopBrowserPanelRequest)
    window.addEventListener('resize', handleWorkspacePanelResize)
    handleWorkspacePanelResize()
    if (profilesStore.profiles.length === 0) {
        void profilesStore.fetchProfiles()
    }
})

onUnmounted(() => {
    hideInlineSummaryStatus()
    window.removeEventListener('hermes:open-page-sidebar', openPageSidebar)
    window.removeEventListener('hermes:preview-workspace-file', handleWorkspaceFilePreviewRequest)
    window.removeEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, handleOpenDesktopBrowserPanelRequest)
    window.removeEventListener('resize', handleWorkspacePanelResize)
    stopWorkspaceResize()
    roomFadeAnimation?.cancel()
    if (showWorkspacePanel.value) closeWorkspacePanel()
    else toolPanelStore.closeWorkspaceDiff()
    roomFadeAnimation = null
})

async function loadRoomSummaryState(roomId: string) {
    try {
        const result = await getRoomSummary(roomId)
        const existing = store.roomSummaryStates.get(roomId)
        if (!existing || result.summary.version >= existing.version) {
            store.roomSummaryStates.set(roomId, result.summary)
        }
        if (store.currentRoomId !== roomId) return
        roomSummaryState.value = store.roomSummaryStates.get(roomId) || result.summary
        roomSummaryAnchor.value = result.anchor
        roomSummaryDraft.value = roomSummaryState.value.summary
    } catch {
        // A missing summary should not block entering or reading the room.
    }
}

watch(() => store.currentRoomId, (roomId, previousRoomId) => {
    if (roomId === previousRoomId) return
    hideInlineSummaryStatus()
    roomSummaryState.value = null
    roomSummaryAnchor.value = null
    roomSummaryDraft.value = ''
    if (filesStore.previewFile || toolPanelStore.workspaceDiff || showWorkspacePanel.value) closeWorkspacePanel()
    if (roomId) void loadRoomSummaryState(roomId)
}, { immediate: true })

watch(
    () => store.currentRoomId,
    async (roomId, previousRoomId) => {
        if (!roomId || !previousRoomId || roomId === previousRoomId) return

        await nextTick()
        const surface = groupChatSurfaceRef.value
        if (!surface || typeof surface.animate !== 'function') return

        roomFadeAnimation?.cancel()
        roomFadeAnimation = surface.animate(
            [
                { opacity: 0 },
                { opacity: 1 },
            ],
            {
                duration: 1500,
                easing: 'ease',
            },
        )
    },
    { flush: 'post' },
)

watch(() => filesStore.previewFile, previewFile => {
    if (previewFile?.workspaceRoomId === store.currentRoomId) {
        activeWorkspacePanel.value = 'files'
        showWorkspacePanel.value = true
    }
})

watch(() => toolPanelStore.workspaceDiff, workspaceDiff => {
    if (workspaceDiff) {
        activeWorkspacePanel.value = 'files'
        showWorkspacePanel.value = true
    }
})

watch(showWorkspacePanel, async visible => {
    if (!visible || workspacePanelMobile.value) return
    await nextTick()
    handleWorkspacePanelResize()
})

async function confirmAddAgent() {
    if (!store.currentRoomId) {
        message.warning(t('groupChat.selectRoomFirst'))
        return
    }
    if (!canConfirmAddAgent.value || !selectedProfile.value || isSavingAgent.value) return
    isSavingAgent.value = true
    try {
        await store.addAgentToRoom(store.currentRoomId, {
            agent: selectedAgentType.value,
            profile: selectedProfile.value,
            provider: selectedAgentProvider.value,
            model: selectedAgentModel.value,
            apiMode: selectedAgentType.value === 'hermes' ? undefined : selectedAgentApiMode.value,
            reasoningEffort: selectedAgentReasoningEffort.value,
            name: agentName.value.trim() || undefined,
            description: agentDescription.value.trim() || undefined,
            avatar: agentAvatar.value ? JSON.stringify(agentAvatar.value) : '',
        })
        closeAgentModal()
        message.success(t('groupChat.agentAdded'))
    } catch (err: any) {
        if (err.message?.includes('already')) {
            message.warning(t('groupChat.agentAlreadyInRoom'))
        } else {
            message.error(extractApiErrorMessage(err))
        }
    } finally {
        isSavingAgent.value = false
    }
}

async function confirmUpdateAgent() {
    if (!store.currentRoomId || !editingAgent.value) return
    if (!canConfirmAddAgent.value || !selectedProfile.value || isSavingAgent.value) return
    isSavingAgent.value = true
    try {
        await store.updateAgentInRoom(store.currentRoomId, editingAgent.value.id, {
            agent: selectedAgentType.value,
            profile: selectedProfile.value,
            provider: selectedAgentProvider.value,
            model: selectedAgentModel.value,
            apiMode: selectedAgentType.value === 'hermes' ? undefined : selectedAgentApiMode.value,
            reasoningEffort: selectedAgentReasoningEffort.value,
            name: agentName.value.trim() || undefined,
            description: agentDescription.value.trim() || undefined,
            avatar: agentAvatar.value ? JSON.stringify(agentAvatar.value) : '',
        })
        closeAgentModal()
        message.success(t('common.saved'))
    } catch (err: any) {
        message.error(extractApiErrorMessage(err))
    } finally {
        isSavingAgent.value = false
    }
}

function handleOpenWorkspacePicker(roomId = store.currentRoomId || '') {
    if (!roomId) return
    const room = store.rooms.find(r => r.id === roomId)
    if (!canManageRoom(room)) return
    workspaceRoomId.value = roomId
    workspaceValue.value = room?.workspace || ''
    showWorkspaceModal.value = true
}

async function handleSaveWorkspace() {
    const roomId = workspaceRoomId.value || store.currentRoomId
    if (!roomId) return
    const room = store.rooms.find(r => r.id === roomId)
    if (!canManageRoom(room)) return
    try {
        const updatedRoom = await store.setRoomWorkspace(roomId, String(workspaceValue.value || '').trim())
        workspaceValue.value = updatedRoom?.workspace || ''
        showWorkspaceModal.value = false
        workspaceRoomId.value = null
        message.success(t('chat.workspaceSet'))
    } catch (err: any) {
        message.error(err?.message || t('chat.workspaceSetFailed'))
    }
}

async function handleClearWorkspace() {
    workspaceValue.value = ''
    await handleSaveWorkspace()
}

function handleOpenUserProfile() {
    const member = store.members.find(item => item.userId === store.userId)
    userProfileName.value = member?.name || store.userName || ''
    userProfileDescription.value = member?.description || ''
    showUserProfileModal.value = true
}

async function handleSaveUserProfile() {
    const name = userProfileName.value.trim()
    if (!name || isSavingUserProfile.value) return
    isSavingUserProfile.value = true
    try {
        await store.updateCurrentMemberProfile(name, userProfileDescription.value)
        showUserProfileModal.value = false
        message.success(t('common.saved'))
    } catch {
        message.error(t('common.saveFailed'))
    } finally {
        isSavingUserProfile.value = false
    }
}

async function handleOpenRoomSettings() {
    if (!currentRoomCanManage.value) return
    const room = store.rooms.find(r => r.id === store.currentRoomId)
    if (room) {
        roomNameDraft.value = room.name
        inviteCodeDraft.value = room.inviteCode || ''
        workspaceRoomId.value = room.id
        workspaceValue.value = room.workspace || ''
        summaryConfig.value = {
            summaryProfile: room.summaryProfile || profilesStore.activeProfileName || 'default',
            summaryProvider: room.summaryProvider || '',
            summaryModel: room.summaryModel || '',
            summaryApiMode: room.summaryApiMode || 'chat_completions',
            summaryEveryTurns: room.summaryEveryTurns || 20,
        }
    }
    showRoomSettingsModal.value = true
    if (!store.currentRoomId) return
    isLoadingRoomSummary.value = true
    try {
        const result = await getRoomSummary(store.currentRoomId)
        roomSummaryState.value = result.summary
        roomSummaryAnchor.value = result.anchor
        roomSummaryDraft.value = result.summary.summary
        store.roomSummaryStates.set(store.currentRoomId, result.summary)
    } catch (err: any) {
        message.error(err?.message || t('groupChat.summaryLoadFailed'))
    } finally {
        isLoadingRoomSummary.value = false
    }
}

async function handleSaveRoomName() {
    if (!store.currentRoomId || !canUpdateRoomName.value) return
    isSavingRoomName.value = true
    try {
        const res = await updateRoomConfig(store.currentRoomId, { name: roomNameDraft.value.trim() })
        const idx = store.rooms.findIndex(r => r.id === store.currentRoomId)
        if (idx >= 0 && res.room) store.rooms[idx] = res.room
        if (res.room) store.roomName = res.room.name
        message.success(t('common.saved'))
    } catch (err: any) {
        message.error(err?.message || t('common.saveFailed'))
    } finally {
        isSavingRoomName.value = false
    }
}

async function handleSaveInviteCode() {
    if (!store.currentRoomId || !currentRoomCanManage.value || isSavingInviteCode.value || !canUpdateInviteCode.value) return
    const nextCode = inviteCodeDraft.value.trim()
    isSavingInviteCode.value = true
    try {
        await store.setRoomInviteCode(store.currentRoomId, nextCode)
        inviteCodeDraft.value = nextCode
        message.success(t('groupChat.inviteCodeUpdated'))
    } catch (err: any) {
        message.error(err?.message || t('groupChat.inviteCodeUpdateFailed'))
    } finally {
        isSavingInviteCode.value = false
    }
}

async function handleSaveSummaryConfig() {
    if (!store.currentRoomId) return
    if (!currentRoomCanManage.value) return
    try {
        const res = await updateRoomConfig(store.currentRoomId, { ...summaryConfig.value })
        const idx = store.rooms.findIndex(r => r.id === store.currentRoomId)
        if (idx >= 0 && res.room) store.rooms[idx] = res.room
        message.success(t('groupChat.summaryConfigSaved'))
    } catch {
        message.error(t('common.saveFailed'))
    }
}

async function handleSaveRoomSummary() {
    if (!store.currentRoomId || isSavingRoomSummary.value || !currentRoomCanManage.value) return
    isSavingRoomSummary.value = true
    try {
        const result = await updateRoomSummary(store.currentRoomId, roomSummaryDraft.value)
        roomSummaryState.value = result.summary
        store.roomSummaryStates.set(store.currentRoomId, result.summary)
        message.success(t('groupChat.summaryUpdated'))
    } catch (err: any) {
        message.error(err?.message || t('common.saveFailed'))
    } finally {
        isSavingRoomSummary.value = false
    }
}

function roomSummaryStatusLabel(status?: RoomSummaryState['status']): string {
    return t(`groupChat.summaryStatus.${status || 'idle'}`)
}

function formatSummaryTime(timestamp?: number): string {
    return timestamp ? new Date(timestamp).toLocaleString() : t('groupChat.summaryNever')
}

async function handleRemoveAgent(agentId: string) {
    if (!store.currentRoomId) return
    if (!currentRoomCanManage.value) return
    try {
        await store.removeAgentFromRoom(store.currentRoomId, agentId)
        if (editingAgent.value && (editingAgent.value.id === agentId || editingAgent.value.agentId === agentId)) {
            closeAgentModal()
        }
    } catch {
        message.error(t('common.deleteFailed'))
    }
}

async function handleInterruptAgent(agentName: string) {
    if (!currentRoomCanManage.value) return
    try {
        await store.interruptAgent(agentName)
    } catch (err: any) {
        message.error(err.message || t('common.saveFailed'))
    }
}

async function handleApproval(choice: 'once' | 'session' | 'always' | 'deny') {
    if (!currentRoomCanManage.value) return
    try {
        await store.respondApproval(choice)
    } catch (err: any) {
        message.error(err.message || t('common.saveFailed'))
    }
}

</script>

<template>
    <div class="group-chat-panel">
        <!-- Mobile backdrop -->
        <div class="sidebar-backdrop" :class="{ active: showSidebar }" @click="showSidebar = false" />
        <!-- Room sidebar -->
        <div v-if="showSidebar" class="room-sidebar">
            <div class="sidebar-header">
                <PageSidebarNav
                    active="group"
                    :primary-label="t('groupChat.createRoom')"
                    @primary="showCreateModal = true"
                />
            </div>
            <div class="room-list">
                <div
                    v-for="room in store.rooms"
                    :key="room.id"
                    class="room-item"
                    :class="{ active: store.currentRoomId === room.id }"
                    @click="handleSelectRoom(room.id)"
                    @contextmenu="handleRoomContextMenu($event, room.id)"
                >
                    <svg class="room-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <div class="room-info">
                        <span class="room-name">{{ room.name || room.id }}</span>
                        <span v-if="room.inviteCode" class="room-code">{{ room.inviteCode }}</span>
                        <span class="room-tokens">{{ formatTokens(room.totalTokens || 0) }}</span>
                    </div>
                    <NPopconfirm v-if="canManageRoom(room)" @positive-click="handleDeleteRoom(room.id)">
                        <template #trigger>
                            <button class="room-action-btn danger" @click.stop>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                        </template>
                        {{ t('groupChat.deleteRoomConfirm') }}
                    </NPopconfirm>
                </div>
                <div v-if="store.rooms.length === 0" class="empty-rooms">
                    {{ t('groupChat.noRooms') }}
                </div>
            </div>
            <div class="page-sidebar-bottom">
                <button class="page-sidebar-menu-btn" type="button" @click="openSettingsPage">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    <span>{{ t('sidebar.settings') }}</span>
                </button>
                <SettingsCircuitBadge />
            </div>
        </div>

        <NDropdown
            placement="bottom-start"
            trigger="manual"
            :x="roomContextMenuX"
            :y="roomContextMenuY"
            :options="roomContextMenuOptions"
            :show="showRoomContextMenu"
            @select="handleRoomContextSelect"
            @clickoutside="handleRoomContextClickOutside"
        />

        <!-- Main chat area -->
        <div
            class="chat-main"
            :class="{ 'chat-main--sidebar-collapsed': !showSidebar }"
            @dragover="handleChatDragOver"
            @dragenter="handleChatDragEnter"
            @dragleave="handleChatDragLeave"
            @drop="handleChatDrop"
        >
            <div class="chat-header">
                <div class="header-left">
                    <button class="icon-btn header-sidebar-toggle" @click="toggleSidebar">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" />
                        </svg>
                    </button>
                    <span class="room-title-text">{{ store.roomName || (store.currentRoomId || t('groupChat.title')) }}</span>
                    <button
                        v-if="currentRoom?.workspace"
                        class="workspace-badge"
                        type="button"
                        :title="currentRoom.workspace"
                        @click="openWorkspaceFilesPanel"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                        </svg>
                        <span>{{ currentWorkspaceLabel }}</span>
                    </button>
                </div>
                <div class="header-info">
                    <button
                        v-if="currentRoomCanManage"
                        class="icon-btn workspace-panel-toggle"
                        :class="{ active: showWorkspacePanel }"
                        :title="groupToolPanelTitle"
                        :aria-label="groupToolPanelTitle"
                        :aria-pressed="showWorkspacePanel"
                        @click="toggleWorkspacePanel"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <line x1="15" y1="3" x2="15" y2="21" />
                        </svg>
                    </button>
                    <button v-if="currentRoomCanManage" class="icon-btn compression-settings-button" :title="t('groupChat.roomSettings')" @click="handleOpenRoomSettings">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 4.6a1.65 1.65 0 0 0 1.51 1V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1.51 1z"/></svg>
                    </button>
                    <NPopconfirm v-if="currentRoomCanManage" @positive-click="handleClearRoomContext">
                        <template #trigger>
                            <button class="icon-btn" :title="t('groupChat.clearContext')">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v5" /><path d="M14 11v5" />
                                </svg>
                            </button>
                        </template>
                        {{ t('groupChat.clearContextConfirm') }}
                    </NPopconfirm>
                    <button
                        v-if="participantCount"
                        type="button"
                        class="member-count member-count-toggle"
                        :aria-expanded="showMemberRail"
                        @click="showMemberRail = !showMemberRail"
                    >
                        <span>{{ t('groupChat.members', { count: participantCount }) }}</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" :class="{ collapsed: !showMemberRail }" aria-hidden="true">
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                    <span class="connection-dot" :class="{ connected: store.connected, disconnected: !store.connected }"></span>
                </div>
            </div>

            <div
                v-if="hasRoom"
                ref="groupChatContentWrapperRef"
                class="group-chat-content-wrapper"
                :class="{ 'chat-main--drop-active': isChatDropActive }"
            >
                <aside
                    v-if="showMemberRail"
                    class="agent-avatar-rail"
                    :aria-label="t('groupChat.members', { count: participantCount })"
                >
                    <div class="agent-avatar-rail-trigger">
                        <button
                            v-for="member in railMembers"
                            :key="member.id"
                            type="button"
                            class="agent-avatar-rail-item agent-avatar-rail-user"
                            :class="{
                                'agent-avatar-rail-current-user': member.userId === store.userId,
                                'agent-avatar-rail-typing': member.userId !== store.userId && store.isUserTyping(member.userId),
                            }"
                            :title="member.userId === store.userId ? t('groupChat.yourName') : member.name"
                            :aria-label="member.userId === store.userId ? t('groupChat.yourName') : member.name"
                            :disabled="member.userId !== store.userId"
                            @click="handleRoomMemberClick(member)"
                        >
                            <ProfileAvatar
                                class="agent-avatar"
                                :name="member.name || t('groupChat.you')"
                                :avatar="memberAvatarFor(member)"
                                :size="32"
                            />
                        </button>
                        <span v-if="store.agents.length" class="agent-avatar-rail-divider" aria-hidden="true"></span>
                        <NPopover
                            v-for="agent in store.agents"
                            :key="agent.id"
                            trigger="hover"
                            placement="right"
                            :show-arrow="false"
                            :disabled="!agentContextStatus(agent)"
                        >
                            <template #trigger>
                                <button
                                    type="button"
                                    class="agent-avatar-rail-item"
                                    :class="{ 'agent-avatar-rail-active': !!agentContextStatus(agent) }"
                                    :aria-label="agent.name"
                                    :aria-busy="!!agentContextStatus(agent)"
                                    :disabled="!currentRoomCanManage"
                                    @click="handleEditAgent(agent)"
                                >
                                    <ProfileAvatar class="agent-avatar" :name="agentAvatarName(agent)" :avatar="groupAgentAvatar(agent)" :size="32" />
                                </button>
                            </template>
                            <div class="agent-avatar-activity-popover">
                                <span class="agent-avatar-activity-text">
                                    @{{ agent.name }} {{ agentActivityLabel(agent) }}
                                </span>
                                <button
                                    v-if="currentRoomCanManage"
                                    type="button"
                                    class="agent-avatar-stop"
                                    :aria-label="t('common.stop')"
                                    @click.stop="handleInterruptAgent(agent.name)"
                                >
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                        <rect x="6" y="6" width="12" height="12" rx="1" />
                                    </svg>
                                    <span>{{ t('common.stop') }}</span>
                                </button>
                            </div>
                        </NPopover>
                    </div>
                    <button
                        v-if="currentRoomCanManage"
                        type="button"
                        class="agent-avatar-rail-add"
                        :title="t('groupChat.addAgent')"
                        :aria-label="t('groupChat.addAgent')"
                        @click="handleAddAgent"
                    >
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                    </button>
                </aside>
                <div ref="groupChatSurfaceRef" class="group-chat-surface">
                    <div class="group-message-shell">
                        <GroupMessageList
                            @mention-agent="handleMentionAgent"
                        />
                        <Transition name="approval-float">
                            <div v-if="visibleApproval" class="approval-float-panel">
                                <div class="approval-float-header">
                                    <span class="approval-float-icon" aria-hidden="true">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                                            <path d="m9 12 2 2 4-4" />
                                        </svg>
                                    </span>
                                    <span>{{ t('chat.approvalKicker') }}</span>
                                </div>
                                <div class="approval-float-title">
                                    <span v-if="visibleApproval.agentName">@{{ visibleApproval.agentName }} · </span>{{ t('chat.approvalTitle') }}
                                </div>
                                <div class="approval-float-desc">{{ visibleApproval.description }}</div>
                                <code class="approval-float-command">{{ visibleApproval.command }}</code>
                                <div class="approval-float-actions">
                                    <NButton v-if="visibleApproval.isMemoryWrite" size="small" type="primary" @click="handleApproval('once')">
                                        {{ t('chat.approvalAgree') }}
                                    </NButton>
                                    <NButton v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('once')" size="small" type="primary" @click="handleApproval('once')">
                                        {{ t('chat.approvalAllowOnce') }}
                                    </NButton>
                                    <NButton v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('session')" size="small" secondary @click="handleApproval('session')">
                                        {{ t('chat.approvalAllowSession') }}
                                    </NButton>
                                    <NButton v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('always')" size="small" secondary @click="handleApproval('always')">
                                        {{ t('chat.approvalAlways') }}
                                    </NButton>
                                    <NButton v-if="visibleApproval.isMemoryWrite || visibleApproval.choices.includes('deny')" size="small" type="error" secondary @click="handleApproval('deny')">
                                        {{ t('chat.approvalDeny') }}
                                    </NButton>
                                </div>
                            </div>
                        </Transition>
                    </div>
                    <Transition name="summary-inline">
                        <div
                            v-if="inlineSummaryStatus"
                            class="group-summary-inline-status"
                            :class="`is-${inlineSummaryStatus.status}`"
                            role="status"
                            aria-live="polite"
                        >
                            <span class="group-summary-inline-label">
                                {{ roomSummaryStatusLabel(inlineSummaryStatus.status) }}
                            </span>
                            <span
                                v-if="inlineSummaryStatus.status === 'summarizing'"
                                class="group-summary-inline-spinner"
                                aria-hidden="true"
                            ></span>
                            <svg
                                v-else-if="inlineSummaryStatus.status === 'success'"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                class="group-summary-inline-success-icon"
                                aria-hidden="true"
                            >
                                <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.15" />
                                <path d="M8 12L11 15L16 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                            <svg
                                v-else
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                class="group-summary-inline-error-icon"
                                aria-hidden="true"
                            >
                                <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.15" />
                                <path d="M15 9L9 15M9 9L15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                            <span
                                v-if="inlineSummaryStatus.status === 'failed' && inlineSummaryStatus.error"
                                class="group-summary-inline-detail"
                                :title="inlineSummaryStatus.error"
                            >
                                {{ inlineSummaryStatus.error }}
                            </span>
                        </div>
                    </Transition>
                    <GroupChatInput
                        ref="groupChatInputRef"
                        :send-blocked="currentRoomNeedsSummaryConfiguration"
                        @send="handleSendMessage"
                        @send-blocked="handleSummaryConfigurationRequired"
                    />
                </div>
                <aside
                    v-if="showWorkspacePanel && (
                        activeWorkspacePanel === 'files'
                        || activeWorkspacePanel === 'terminal'
                        || (activeWorkspacePanel === 'browser' && desktopBrowserAvailable)
                        || toolPanelStore.workspaceDiff
                        || currentRoom?.workspace
                        || filesStore.previewFile?.workspaceRoomId === store.currentRoomId
                    )"
                    class="group-workspace-panel"
                    :style="workspacePanelStyle"
                >
                    <div class="group-workspace-resize-handle" @pointerdown="startWorkspaceResize" />
                    <div class="group-workspace-panel-inner">
                        <WorkspaceDiffPreview
                            v-if="toolPanelStore.workspaceDiff"
                            :custom-close="closeWorkspacePanel"
                        />
                        <FilePreview
                            v-else-if="filesStore.previewFile?.workspaceRoomId === store.currentRoomId"
                            :custom-close="closeWorkspacePanel"
                        />
                        <template v-else>
                            <div class="group-tool-tabs" role="tablist">
                                <button
                                    class="group-tool-tab"
                                    :class="{ active: activeWorkspacePanel === 'files' }"
                                    type="button"
                                    role="tab"
                                    :title="t('drawer.files')"
                                    :aria-label="t('drawer.files')"
                                    :aria-selected="activeWorkspacePanel === 'files'"
                                    @click="selectWorkspacePanel('files')"
                                >
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
                                    </svg>
                                </button>
                                <button
                                    class="group-tool-tab"
                                    :class="{ active: activeWorkspacePanel === 'terminal' }"
                                    type="button"
                                    role="tab"
                                    :title="t('drawer.terminal')"
                                    :aria-label="t('drawer.terminal')"
                                    :aria-selected="activeWorkspacePanel === 'terminal'"
                                    @click="selectWorkspacePanel('terminal')"
                                >
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <rect x="3" y="4" width="18" height="16" rx="2" />
                                        <path d="m7 9 3 3-3 3M13 15h4" />
                                    </svg>
                                </button>
                                <button
                                    v-if="desktopBrowserAvailable"
                                    class="group-tool-tab"
                                    :class="{ active: activeWorkspacePanel === 'browser' }"
                                    type="button"
                                    role="tab"
                                    :title="t('browser.title')"
                                    :aria-label="t('browser.title')"
                                    :aria-selected="activeWorkspacePanel === 'browser'"
                                    @click="selectWorkspacePanel('browser')"
                                >
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <rect x="3" y="4" width="18" height="16" rx="2" />
                                        <path d="M3 9h18" />
                                        <circle cx="6.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
                                        <circle cx="9.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
                                    </svg>
                                </button>
                            </div>
                            <div class="group-tool-content">
                                <template v-if="currentRoom?.workspace">
                                    <FilesPanel
                                        v-show="activeWorkspacePanel === 'files'"
                                        :workspace-room-id="store.currentRoomId"
                                        :workspace="currentRoom.workspace"
                                        @attach="handleWorkspaceFileAttach"
                                    />
                                </template>
                                <div v-else-if="activeWorkspacePanel === 'files'" class="group-workspace-empty">
                                    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                                        <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                                    </svg>
                                    <span>{{ t('chat.setWorkspaceTitle') }}</span>
                                    <NButton type="primary" size="small" @click="handleOpenWorkspacePicker()">
                                        {{ t('chat.setWorkspace') }}
                                    </NButton>
                                </div>
                                <TerminalPanel
                                    v-show="activeWorkspacePanel === 'terminal'"
                                    class="group-terminal-panel"
                                    :visible="showWorkspacePanel && activeWorkspacePanel === 'terminal'"
                                />
                                <DesktopBrowserPanel
                                    v-if="desktopBrowserAvailable && activeWorkspacePanel === 'browser'"
                                    class="group-browser-panel"
                                    @attach="handleBrowserAttachment"
                                />
                            </div>
                        </template>
                    </div>
                </aside>
            </div>

            <div v-else class="no-room">
                <div class="no-room-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                </div>
                <p>{{ t('groupChat.selectOrCreate') }}</p>
            </div>
        </div>

        <NDrawer v-model:show="showCreateModal" placement="right" :width="workspacePanelMobile ? '100%' : 520">
            <NDrawerContent :title="t('groupChat.createRoom')" closable>
                <CreateRoomForm @submit="handleCreateRoom" @cancel="showCreateModal = false" />
            </NDrawerContent>
        </NDrawer>

        <Teleport to="body">
            <div v-if="showAddAgentModal" class="modal-backdrop" @click.self="closeAgentModal">
                <div class="modal">
                    <h3>{{ editingAgent ? t('groupChat.editAgentTitle', { name: editingAgent.name }) : t('groupChat.addAgent') }}</h3>
                    <div class="group-agent-avatar-editor">
                        <ProfileAvatar
                            :name="selectedAgentType"
                            :avatar="agentAvatarPreview"
                            :size="64"
                        />
                        <div class="group-agent-avatar-controls">
                            <span class="form-label">{{ t('profiles.avatar.customize') }}</span>
                            <div class="group-agent-avatar-actions">
                                <NButton size="small" @click="triggerAgentAvatarUpload">
                                    {{ t('profiles.avatar.upload') }}
                                </NButton>
                                <NButton size="small" @click="handleRandomAgentAvatar">
                                    {{ t('profiles.avatar.random') }}
                                </NButton>
                                <NButton size="small" @click="handleResetAgentAvatar">
                                    {{ t('profiles.avatar.reset') }}
                                </NButton>
                            </div>
                            <span class="group-agent-avatar-hint">{{ t('profiles.avatar.hint') }}</span>
                        </div>
                        <input
                            ref="agentAvatarFileInput"
                            class="group-agent-avatar-file"
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            @change="handleAgentAvatarFileChange"
                        >
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.agentType') }}</label>
                        <NSelect
                            :value="selectedAgentType"
                            :options="groupAgentTypeOptions"
                            @update:value="handleAgentTypeChange"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('sidebar.profiles') }}</label>
                        <NSelect
                            :value="selectedProfile"
                            :options="profileOptions"
                            :placeholder="t('groupChat.selectProfile')"
                            filterable
                            @update:value="handleAgentProfileChange"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('models.provider') }}</label>
                        <NSelect
                            :value="selectedAgentProvider"
                            :options="agentProviderOptions"
                            :placeholder="t('models.selectProvider')"
                            filterable
                            @update:value="handleAgentProviderChange"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('models.models') }}</label>
                        <NSelect
                            v-model:value="selectedAgentModel"
                            :options="agentModelOptions"
                            :placeholder="t('models.selectModel')"
                            :disabled="!selectedAgentProvider"
                            filterable
                        />
                    </div>
                    <div v-if="selectedAgentType !== 'hermes'" class="form-group">
                        <label class="form-label">{{ t('codingAgents.protocolScope') }}</label>
                        <NSelect
                            v-model:value="selectedAgentApiMode"
                            :options="agentApiModeOptions"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('chat.reasoningEffort.tooltip') }}</label>
                        <NSelect
                            v-model:value="selectedAgentReasoningEffort"
                            :options="agentReasoningEffortOptions"
                            :placeholder="t('chat.reasoningEffort.tooltip')"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.agentName') }}</label>
                        <NInput
                            v-model:value="agentName"
                            :placeholder="t('groupChat.agentNamePlaceholder')"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.agentDesc') }}</label>
                        <NInput
                            v-model:value="agentDescription"
                            type="textarea"
                            :rows="2"
                            :placeholder="t('groupChat.agentDescPlaceholder')"
                        />
                    </div>
                    <div class="modal-actions" :class="{ 'agent-modal-actions': editingAgent }">
                        <NPopconfirm
                            v-if="editingAgent"
                            @positive-click="handleRemoveAgent(editingAgent.id)"
                        >
                            <template #trigger>
                                <NButton type="error" secondary :disabled="isSavingAgent">
                                    {{ t('common.delete') }}
                                </NButton>
                            </template>
                            {{ t('groupChat.deleteAgentConfirm', { name: editingAgent.name }) }}
                        </NPopconfirm>
                        <NSpace justify="end">
                            <NButton :disabled="isSavingAgent" @click="closeAgentModal">{{ t('common.cancel') }}</NButton>
                            <NButton
                                type="primary"
                                :disabled="!canConfirmAddAgent"
                                :loading="isSavingAgent"
                                @click="editingAgent ? confirmUpdateAgent() : confirmAddAgent()"
                            >
                                {{ editingAgent ? t('common.update') : t('common.add') }}
                            </NButton>
                        </NSpace>
                    </div>
                </div>
            </div>
            <div v-if="showCloneModal" class="modal-backdrop" @click.self="showCloneModal = false">
                <div class="modal">
                    <h3>{{ t('groupChat.cloneRoom') }}</h3>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.roomName') }}</label>
                        <NInput
                            v-model:value="cloneRoomName"
                            :placeholder="t('groupChat.roomNamePlaceholder')"
                            @keyup.enter="confirmCloneRoom"
                        />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.inviteCode') }}</label>
                        <div class="code-row">
                            <NInput
                                v-model:value="cloneInviteCode"
                                :placeholder="t('groupChat.autoGenerate')"
                                @keyup.enter="confirmCloneRoom"
                            />
                            <NButton size="small" @click="cloneInviteCode = generateCode()">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                                </svg>
                            </NButton>
                        </div>
                    </div>
                    <div class="modal-actions">
                        <NSpace justify="end">
                            <NButton @click="showCloneModal = false">{{ t('common.cancel') }}</NButton>
                            <NButton type="primary" :disabled="!cloneRoomName.trim()" @click="confirmCloneRoom">{{ t('groupChat.cloneRoom') }}</NButton>
                        </NSpace>
                    </div>
                </div>
            </div>
            <NModal
                v-model:show="showGroupChatRefactorNotice"
                preset="dialog"
                :title="t('groupChat.refactorNoticeTitle')"
                :mask-closable="false"
                :close-on-esc="false"
                :closable="false"
                style="width: 480px; max-width: 92vw"
            >
                <p class="group-chat-refactor-notice">
                    {{ t('groupChat.refactorNoticeMessage') }}
                </p>
                <template #action>
                    <NButton type="primary" @click="acknowledgeGroupChatRefactorNotice">
                        {{ t('common.confirm') }}
                    </NButton>
                </template>
            </NModal>
            <NModal
                v-model:show="showWorkspaceModal"
                preset="dialog"
                :title="t('chat.setWorkspaceTitle')"
                class="workspace-modal"
                style="width: 520px; max-width: 92vw"
            >
                <FolderPicker v-model="workspaceValue" />
                <template #action>
                    <NSpace justify="end">
                        <NButton @click="showWorkspaceModal = false">{{ t('common.cancel') }}</NButton>
                        <NButton @click="handleClearWorkspace">{{ t('workflow.workspace.clear') }}</NButton>
                        <NButton type="primary" @click="handleSaveWorkspace">{{ t('common.save') }}</NButton>
                    </NSpace>
                </template>
            </NModal>
            <NModal
                v-model:show="showUserProfileModal"
                preset="dialog"
                :title="t('groupChat.yourName')"
                style="width: 460px; max-width: 92vw"
            >
                <div class="form-group">
                    <label class="form-label">{{ t('groupChat.yourName') }}</label>
                    <NInput
                        v-model:value="userProfileName"
                        :placeholder="t('groupChat.yourNamePlaceholder')"
                        :maxlength="120"
                        @keyup.enter="handleSaveUserProfile"
                    />
                </div>
                <div class="form-group">
                    <label class="form-label">{{ t('groupChat.yourDescription') }}</label>
                    <NInput
                        v-model:value="userProfileDescription"
                        type="textarea"
                        :rows="3"
                        :maxlength="2000"
                        :placeholder="t('groupChat.yourDescriptionPlaceholder')"
                    />
                </div>
                <template #action>
                    <NSpace justify="end">
                        <NButton @click="showUserProfileModal = false">{{ t('common.cancel') }}</NButton>
                        <NButton
                            type="primary"
                            :disabled="!userProfileName.trim()"
                            :loading="isSavingUserProfile"
                            @click="handleSaveUserProfile"
                        >
                            {{ t('common.save') }}
                        </NButton>
                    </NSpace>
                </template>
            </NModal>
            <NDrawer
                v-model:show="showRoomSettingsModal"
                placement="right"
                :width="workspacePanelMobile ? '100%' : 520"
            >
                <NDrawerContent :title="t('groupChat.roomSettings')" closable>
                    <div class="room-settings-drawer">
                        <section class="settings-section">
                            <h4>{{ t('groupChat.roomName') }}</h4>
                            <div class="code-row room-name-row">
                                <NInput
                                    v-model:value="roomNameDraft"
                                    :placeholder="t('groupChat.roomNamePlaceholder')"
                                    :maxlength="120"
                                    :disabled="isSavingRoomName"
                                    @keyup.enter="handleSaveRoomName"
                                />
                                <NButton
                                    type="primary"
                                    :disabled="!canUpdateRoomName"
                                    :loading="isSavingRoomName"
                                    @click="handleSaveRoomName"
                                >
                                    {{ t('common.update') }}
                                </NButton>
                            </div>
                        </section>
                        <section class="settings-section">
                            <h4>{{ t('groupChat.inviteCodeSettings') }}</h4>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.inviteCode') }}</label>
                                <div class="code-row invite-code-row">
                                    <NInput
                                        v-model:value="inviteCodeDraft"
                                        :placeholder="t('groupChat.inviteCodePlaceholder')"
                                        :disabled="isSavingInviteCode"
                                        @keyup.enter="handleSaveInviteCode"
                                    />
                                    <NButton size="small" :disabled="isSavingInviteCode" :title="t('groupChat.generateInviteCode')" @click="inviteCodeDraft = generateCode()">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                                            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                                        </svg>
                                    </NButton>
                                    <NButton
                                        type="primary"
                                        :disabled="!canUpdateInviteCode"
                                        :loading="isSavingInviteCode"
                                        @click="handleSaveInviteCode"
                                    >
                                        {{ t('common.update') }}
                                    </NButton>
                                </div>
                                <p class="form-hint">{{ t('groupChat.inviteCodeRotateHint') }}</p>
                            </div>
                        </section>
                        <section class="settings-section">
                            <h4>{{ t('chat.setWorkspaceTitle') }}</h4>
                            <FolderPicker v-model="workspaceValue" />
                            <NSpace class="room-workspace-actions" justify="end">
                                <NButton @click="handleClearWorkspace">{{ t('workflow.workspace.clear') }}</NButton>
                                <NButton type="primary" @click="handleSaveWorkspace">{{ t('common.save') }}</NButton>
                            </NSpace>
                        </section>
                        <section ref="summarySettingsSectionRef" class="settings-section">
                            <h4>{{ t('groupChat.summarySettings') }}</h4>
                            <p v-if="currentRoomNeedsSummaryConfiguration" class="summary-config-required">
                                {{ t('groupChat.summaryConfigurationRequired') }}
                            </p>
                            <p class="form-hint">{{ t('groupChat.summarySettingsDesc') }}</p>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryProvider') }}</label>
                                <NSelect
                                    :value="summaryConfig.summaryProvider"
                                    :options="summaryProviderOptions"
                                    @update:value="handleSummaryProviderChange"
                                />
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryModel') }}</label>
                                <NSelect
                                    v-model:value="summaryConfig.summaryModel"
                                    :options="summaryModelOptions"
                                    :disabled="!summaryConfig.summaryProvider"
                                />
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryApiMode') }}</label>
                                <NSelect v-model:value="summaryConfig.summaryApiMode" :options="summaryApiModeOptions" />
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryEveryTurns') }}</label>
                                <NInputNumber v-model:value="summaryConfig.summaryEveryTurns" :min="1" :max="1000" :step="1" style="width: 100%" />
                                <p class="form-hint">{{ t('groupChat.summaryEveryTurnsDesc') }}</p>
                            </div>
                            <NButton
                                type="primary"
                                :disabled="!summaryConfig.summaryProvider || !summaryConfig.summaryModel || !summaryConfig.summaryApiMode"
                                @click="handleSaveSummaryConfig"
                            >
                                {{ t('groupChat.saveSummaryConfig') }}
                            </NButton>
                        </section>
                    <section class="settings-section summary-state-section">
                        <div class="summary-state-heading">
                            <h4>{{ t('groupChat.currentSummary') }}</h4>
                            <span class="summary-status" :class="`is-${liveRoomSummaryState?.status || 'idle'}`">
                                {{ roomSummaryStatusLabel(liveRoomSummaryState?.status) }}
                            </span>
                        </div>
                        <div v-if="isLoadingRoomSummary" class="summary-loading">{{ t('common.loading') }}</div>
                        <template v-else>
                            <div class="summary-meta">
                                <span>
                                    <span>{{ t('groupChat.summaryUpdatedAt') }}</span>
                                    <strong>{{ formatSummaryTime(liveRoomSummaryState?.updatedAt) }}</strong>
                                </span>
                                <span>
                                    <span>{{ t('groupChat.summarizedTurns') }}</span>
                                    <strong>{{ liveRoomSummaryState?.summarizedTurnCount || 0 }}</strong>
                                </span>
                            </div>
                            <div v-if="liveRoomSummaryState?.lastError" class="summary-error">
                                {{ liveRoomSummaryState.lastError }}
                            </div>
                            <div class="summary-anchor">
                                <div>
                                    <strong>{{ t('groupChat.summaryAnchor') }}</strong>
                                    <template v-if="roomSummaryAnchor">
                                        <span>{{ roomSummaryAnchor.senderName }} · {{ formatSummaryTime(roomSummaryAnchor.timestamp) }}</span>
                                        <p>{{ roomSummaryAnchor.content }}</p>
                                    </template>
                                    <span v-else>{{ liveRoomSummaryState?.summaryThroughMessageId || t('groupChat.summaryNoAnchor') }}</span>
                                </div>
                            </div>
                            <div class="form-group">
                                <label class="form-label">{{ t('groupChat.summaryContent') }}</label>
                                <NInput
                                    v-model:value="roomSummaryDraft"
                                    type="textarea"
                                    :rows="12"
                                    :disabled="liveRoomSummaryState?.status === 'summarizing'"
                                    :placeholder="t('groupChat.summaryEmpty')"
                                />
                                <p class="form-hint">{{ t('groupChat.summaryEditKeepsAnchor') }}</p>
                            </div>
                            <NButton
                                type="primary"
                                :loading="isSavingRoomSummary"
                                :disabled="liveRoomSummaryState?.status === 'summarizing'"
                                @click="handleSaveRoomSummary"
                            >
                                {{ t('groupChat.saveSummary') }}
                            </NButton>
                        </template>
                    </section>
                    </div>
                </NDrawerContent>
            </NDrawer>
        </Teleport>

    </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import CreateRoomForm from './CreateRoomForm.vue'

export default defineComponent({ components: { CreateRoomForm } })
</script>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.group-chat-panel {
    display: flex;
    height: 100%;
    overflow: hidden;
    position: relative;
    min-width: 0;
    max-width: 100%;
    background-color: $bg-card;
}

.sidebar-backdrop {
    display: none;
}

.group-message-shell {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
}

.group-chat-refactor-notice {
    margin: 0;
    line-height: 1.7;
}

@media (max-width: $breakpoint-mobile) {
    .sidebar-backdrop {
        display: block;
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 99;
        opacity: 0;
        pointer-events: none;
        transition: opacity $transition-fast;

        &.active {
            opacity: 1;
            pointer-events: auto;
        }
    }
}

.approval-float-panel {
    position: absolute;
    right: 16px;
    bottom: 16px;
    z-index: 8;
    width: min(720px, calc(100% - 32px));
    padding: 10px;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
    border-radius: 16px;
    background: #ffffff;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.14);
    backdrop-filter: blur(14px);

    .dark & {
        background: #262626;
    }
}

.approval-float-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px 8px;
    color: var(--accent-primary);
    font-size: 11px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.approval-float-icon {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.12);
    border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
}

.approval-float-title {
    padding: 0 4px;
    font-size: 14px;
    font-weight: 700;
    line-height: 1.3;
    color: $text-primary;
}

.approval-float-desc {
    padding: 0 4px;
    margin-top: 5px;
    font-size: 12px;
    line-height: 1.45;
    color: $text-secondary;
}

.approval-float-command {
    display: block;
    margin: 8px 4px 0;
    max-height: 96px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
    font-size: 11px;
    line-height: 1.45;
    color: $text-primary;
    background: rgba(255, 255, 255, 0.68);
    border: 1px solid $border-color;
    border-radius: 11px;
    padding: 8px 10px;

    .dark & {
        background: rgba(255, 255, 255, 0.08);
    }
}

.approval-float-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: 8px;
    margin-top: 10px;
    padding: 10px 4px 0;
    border-top: 1px solid $border-color;
}

@media (max-width: 640px) {
    .approval-float-panel {
        left: 8px;
        right: 8px;
        bottom: 8px;
        width: auto;
        padding: 7px;
        border-radius: 14px;
    }

    .approval-float-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .approval-float-actions :deep(.n-button) {
        width: 100%;
    }
}

.approval-float-enter-active,
.approval-float-leave-active {
    transition: opacity 0.2s ease, transform 0.2s ease;
}

.approval-float-enter-from,
.approval-float-leave-to {
    opacity: 0;
    transform: translateY(10px) scale(0.98);
}

// ─── Room Sidebar ────────────────────────────────────────

.room-sidebar {
    width: $sidebar-width;
    min-height: 0;
    align-self: stretch;
    margin: 10px;
    background: $bg-sidebar-surface;
    border: 1px solid $border-color;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.sidebar-header {
    padding: 12px;
    flex-shrink: 0;
}

.page-sidebar-tab {
    width: 100%;
    min-width: 0;
    height: 34px;
    border: none;
    border-radius: $radius-sm;
    background: transparent;
    color: $text-secondary;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    padding: 7px 10px;
    cursor: pointer;
    transition:
        background-color $transition-fast,
        color $transition-fast;

    svg {
        flex-shrink: 0;
    }

    span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        line-height: 18px;
    }

    &:hover {
        background: rgba(var(--accent-primary-rgb), 0.06);
        color: $text-primary;
    }

}

.conversation-switch {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
    margin: 0 12px 8px;
    padding: 2px;
    border-radius: $radius-sm;
    background: rgba(var(--accent-primary-rgb), 0.05);
    flex-shrink: 0;
}

.conversation-switch-tab {
    min-width: 0;
    height: 28px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: $text-secondary;
    font-size: 12px;
    line-height: 16px;
    cursor: pointer;
    transition:
        background-color $transition-fast,
        color $transition-fast;

    &:hover {
        color: $text-primary;
    }

    &.active {
        background: $bg-card;
        color: $text-primary;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
    }
}

.room-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
}

.room-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    border-radius: $radius-sm;
    cursor: pointer;
    transition: background-color $transition-fast;

    &:hover {
        background-color: rgba(var(--accent-primary-rgb), 0.06);
    }

    &.active {
        background-color: rgba(var(--accent-primary-rgb), 0.12);
    }

    &.active .room-name {
        color: $text-primary;
    }

    .room-icon {
        color: $text-muted;
        flex-shrink: 0;
    }

    .room-info {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
    }

    .room-name {
        font-size: 13px;
        color: $text-primary;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .room-code {
        font-size: 11px;
        color: $text-muted;
        font-family: $font-code;
    }

    .room-tokens {
        font-size: 11px;
        color: $text-muted;
    }

    .room-action-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: $text-muted;
        cursor: pointer;
        border-radius: $radius-sm;
        opacity: 0;
        transition: opacity $transition-fast, color $transition-fast, background-color $transition-fast;

        &:hover {
            color: $text-primary;
            background-color: rgba(var(--accent-primary-rgb), 0.08);
        }

        &.danger:hover {
            color: $error;
            background-color: rgba(var(--error-rgb), 0.1);
        }
    }

    &:hover .room-action-btn {
        opacity: 1;
    }
}

.empty-rooms {
    padding: 20px 12px;
    text-align: center;
    font-size: 13px;
    color: $text-muted;
}

.page-sidebar-bottom {
    flex-shrink: 0;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.page-sidebar-menu-btn {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    height: 36px;
    border: none;
    border-radius: $radius-sm;
    background: transparent;
    color: $text-secondary;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    padding: 8px 10px;
    cursor: pointer;
    transition:
        background-color $transition-fast,
        color $transition-fast;

    &:hover {
        background: rgba(var(--accent-primary-rgb), 0.06);
        color: $text-primary;
    }

    span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        line-height: 18px;
    }
}

// ─── Chat Main ──────────────────────────────────────────

.chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    margin: 10px 10px 10px 0;
    overflow: hidden;
    background-color: $bg-main-surface;
    border: 1px solid $border-color;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
    position: relative;

    &--sidebar-collapsed {
        margin-inline-start: 10px;
    }
}

.group-chat-content-wrapper {
    flex: 1;
    display: flex;
    overflow: hidden;
    position: relative;
    min-width: 0;
    min-height: 0;
    max-width: 100%;
}

.agent-avatar-rail {
    flex: 0 0 72px;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 72px;
    min-height: 0;
    padding: 12px 0;
    overflow: hidden;
    box-sizing: border-box;
    border-inline-end: 1px solid $border-color;
    background: rgba(var(--bg-main-surface-rgb), 0.55);
}

.agent-avatar-rail-trigger {
    display: flex;
    align-items: center;
    flex-direction: column;
    flex: 1;
    width: 100%;
    min-height: 0;
    gap: 10px;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-width: none;

    &::-webkit-scrollbar {
        display: none;
    }
}

.agent-avatar-rail-item {
    display: flex;
    flex: 0 0 34px;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    overflow: hidden;
    box-sizing: border-box;
    border: 1px solid rgba(var(--text-primary-rgb), 0.12);
    border-radius: 50%;
    background: $bg-secondary;
    cursor: pointer;
    transition: border-color $transition-fast, box-shadow $transition-fast;
    -webkit-app-region: no-drag;

    &:hover {
        border-color: rgba(var(--accent-primary-rgb), 0.55);
    }

    &:focus-visible {
        border-color: rgba(var(--accent-primary-rgb), 0.75);
        box-shadow: 0 0 0 2px rgba(var(--accent-primary-rgb), 0.14);
        outline: none;
    }

    &:disabled {
        cursor: default;
    }

    .agent-avatar {
        width: 32px;
        height: 32px;
    }
}

.agent-avatar-rail-current-user {
    border-color: rgba(var(--accent-primary-rgb), 0.28);
}

.agent-avatar-rail-typing {
    border-color: rgba(var(--accent-primary-rgb), 0.72);
    animation: member-avatar-typing-breathe 1.6s ease-in-out infinite;
}

.agent-avatar-rail-active {
    border-color: transparent;
    animation: agent-avatar-rainbow-glow 4s linear infinite;
}

.agent-avatar-activity-popover {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 280px;
}

.agent-avatar-activity-text {
    color: $text-secondary;
    font-size: 12px;
    line-height: 1.4;
}

.agent-avatar-stop {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 26px;
    padding: 0 9px;
    border: 1px solid rgba(var(--error-rgb), 0.24);
    border-radius: $radius-sm;
    color: $error;
    background: rgba(var(--error-rgb), 0.08);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    transition: color $transition-fast, border-color $transition-fast, background $transition-fast;

    &:hover {
        border-color: $error;
        color: #ffffff;
        background: $error;
    }
}

@keyframes agent-avatar-rainbow-glow {
    0% {
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
    }

    16.66% {
        box-shadow:
            0 0 0 2px #feca57,
            0 0 10px rgba(254, 202, 87, 0.4),
            0 0 20px rgba(254, 202, 87, 0.2);
    }

    33.33% {
        box-shadow:
            0 0 0 2px #48dbfb,
            0 0 10px rgba(72, 219, 251, 0.4),
            0 0 20px rgba(72, 219, 251, 0.2);
    }

    50% {
        box-shadow:
            0 0 0 2px #ff9ff3,
            0 0 10px rgba(255, 159, 243, 0.4),
            0 0 20px rgba(255, 159, 243, 0.2);
    }

    66.66% {
        box-shadow:
            0 0 0 2px #54a0ff,
            0 0 10px rgba(84, 160, 255, 0.4),
            0 0 20px rgba(84, 160, 255, 0.2);
    }

    83.33% {
        box-shadow:
            0 0 0 2px #5f27cd,
            0 0 10px rgba(95, 39, 205, 0.4),
            0 0 20px rgba(95, 39, 205, 0.2);
    }

    100% {
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
    }
}

@keyframes member-avatar-typing-breathe {
    0%,
    100% {
        box-shadow:
            0 0 0 1px rgba(var(--accent-primary-rgb), 0.18),
            0 0 5px rgba(var(--accent-primary-rgb), 0.12);
    }

    50% {
        box-shadow:
            0 0 0 3px rgba(var(--accent-primary-rgb), 0.28),
            0 0 14px rgba(var(--accent-primary-rgb), 0.42);
    }
}

@media (prefers-reduced-motion: reduce) {
    .agent-avatar-rail-active {
        animation: none;
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
    }

    .agent-avatar-rail-typing {
        animation: none;
        box-shadow: 0 0 0 2px rgba(var(--accent-primary-rgb), 0.24);
    }
}

.agent-avatar-rail-divider {
    flex: 0 0 1px;
    width: 24px;
    background: $border-color;
}

.agent-avatar-rail-add {
    display: flex;
    flex: 0 0 34px;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    margin-top: 10px;
    padding: 0;
    border: 1px dashed rgba(var(--accent-primary-rgb), 0.65);
    border-radius: 50%;
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.08);
    cursor: pointer;
    transition: color $transition-fast, border-color $transition-fast, background $transition-fast;
    -webkit-app-region: no-drag;

    &:hover {
        border-color: rgba(var(--accent-primary-rgb), 0.82);
        color: var(--accent-primary);
        background: rgba(var(--accent-primary-rgb), 0.13);
    }
}

.group-chat-surface {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background-color: $bg-main-surface;
    animation: group-chat-surface-fade-in 1.5s ease both;
}

.group-summary-inline-status {
    display: flex;
    align-items: center;
    align-self: flex-start;
    gap: 6px;
    width: 520px;
    max-width: calc(100% - 40px);
    min-width: 0;
    box-sizing: border-box;
    margin: 0 20px;
    padding: 3px 8px;
    border-radius: $radius-sm;
    color: $text-secondary;
    background: rgba(0, 0, 0, 0.03);
    font-size: 11px;

    &.is-success {
        color: #52c41a;
    }

    &.is-failed {
        color: #ff4d4f;
    }
}

.group-summary-inline-label {
    flex: 0 1 auto;
    min-width: 0;
    color: $text-secondary;
    font-family: $font-code;
    white-space: nowrap;
}

.group-summary-inline-spinner {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
    box-sizing: border-box;
    border: 1.5px solid $text-muted;
    border-top-color: transparent;
    border-radius: 50%;
    animation: group-summary-inline-spin 0.6s linear infinite;
}

.group-summary-inline-success-icon,
.group-summary-inline-error-icon {
    flex-shrink: 0;
}

.group-summary-inline-detail {
    min-width: 0;
    overflow: hidden;
    color: $text-muted;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.summary-inline-enter-active,
.summary-inline-leave-active {
    transition: opacity 0.15s ease, transform 0.15s ease;
}

.summary-inline-enter-from,
.summary-inline-leave-to {
    opacity: 0;
    transform: translateY(3px);
}

.workspace-panel-toggle.active {
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.1);
}

.group-workspace-panel {
    position: relative;
    flex: 0 0 auto;
    min-width: 320px;
    max-width: 100%;
    min-height: 0;
    overflow: visible;
    display: flex;
    background: $bg-card;
    border-inline-start: 1px solid $border-color;
}

.group-workspace-resize-handle {
    position: absolute;
    inset-inline-start: -7px;
    top: 0;
    bottom: 0;
    width: 14px;
    cursor: col-resize;
    z-index: 20;

    &::after {
        content: '';
        position: absolute;
        inset-inline-start: 6px;
        top: 0;
        bottom: 0;
        width: 1px;
        background:
            linear-gradient($border-color, $border-color) top / 1px calc(50% - 26px) no-repeat,
            linear-gradient($border-color, $border-color) bottom / 1px calc(50% - 26px) no-repeat;
    }

    &::before {
        content: '';
        position: absolute;
        inset-inline-start: 1px;
        top: 50%;
        width: 12px;
        height: 38px;
        transform: translateY(-50%);
        border-radius: 6px;
        border: 1px solid $border-color;
        background:
            linear-gradient($text-muted, $text-muted) center 12px / 6px 1px no-repeat,
            linear-gradient($text-muted, $text-muted) center 19px / 6px 1px no-repeat,
            linear-gradient($text-muted, $text-muted) center 26px / 6px 1px no-repeat,
            $bg-card;
    }

    &:hover::before {
        border-color: var(--accent-primary);
        background:
            linear-gradient(var(--accent-primary), var(--accent-primary)) center 12px / 6px 1px no-repeat,
            linear-gradient(var(--accent-primary), var(--accent-primary)) center 19px / 6px 1px no-repeat,
            linear-gradient(var(--accent-primary), var(--accent-primary)) center 26px / 6px 1px no-repeat,
            $bg-card;
    }
}

.group-workspace-panel-inner {
    display: flex;
    flex-direction: row;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: $bg-main-surface;
}

.group-tool-tabs {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    order: 2;
    width: 48px;
    height: 100%;
    gap: 4px;
    padding: 8px 6px;
    border-inline-start: 1px solid $border-color;
    background: $bg-sidebar-surface;
    box-sizing: border-box;
}

.group-tool-tab {
    position: relative;
    width: 36px;
    height: 36px;
    padding: 0;
    border: none;
    border-radius: $radius-sm;
    background: transparent;
    color: $text-secondary;
    cursor: pointer;
    display: grid;
    place-items: center;
    transition: all $transition-fast;

    svg {
        width: 18px;
        height: 18px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
    }

    &:hover {
        color: $text-primary;
        background: rgba(var(--accent-primary-rgb), 0.06);
    }

    &.active {
        color: var(--accent-primary);
        background: rgba(var(--accent-primary-rgb), 0.12);

        &::after {
            content: '';
            position: absolute;
            inset-inline-end: -6px;
            top: 9px;
            bottom: 9px;
            width: 2px;
            border-radius: 2px 0 0 2px;
            background: var(--accent-primary);
        }
    }
}

.group-tool-content {
    order: 1;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: $bg-main-surface;

    > * {
        height: 100%;
        min-height: 0;
    }
}

.group-workspace-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    color: $text-muted;
    text-align: center;
    font-size: 13px;

    > svg {
        color: $text-secondary;
    }
}

.group-browser-panel,
.group-terminal-panel {
    min-height: 0;
}

@media (max-width: $breakpoint-mobile) {
    .group-workspace-panel {
        position: absolute;
        inset: 0;
        z-index: 70;
        width: 100% !important;
        min-width: 0;
        border-inline-start: none;
    }

    .group-workspace-resize-handle {
        display: none;
    }
}

@keyframes group-chat-surface-fade-in {
    from {
        opacity: 0;
    }

    to {
        opacity: 1;
    }
}

.chat-main--drop-active::after {
    content: "";
    position: absolute;
    inset: 12px;
    z-index: 30;
    pointer-events: none;
    border: 2px dashed var(--accent-info);
    border-radius: 8px;
    background: rgba(var(--accent-info-rgb), 0.05);
}

.chat-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 21px 20px;
    border-bottom: 1px solid $border-color;

    .icon-btn {
        width: 28px;
        height: 28px;
    }

    .icon-btn {
        box-sizing: content-box;
    }

    .header-left {
        display: flex;
        align-items: center;
        gap: 8px;
        overflow: hidden;
        flex: 1;
        min-width: 0;
    }

    .room-title-text {
        font-size: 16px;
        font-weight: 600;
        color: $text-primary;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }

    .header-info {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
    }

    .workspace-badge {
        border: 0;
        font-size: 11px;
        line-height: 16px;
        color: $text-muted;
        background: rgba(255, 255, 255, 0.05);
        padding: 2px 8px;
        border-radius: 4px;
        max-width: 160px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        overflow: hidden;
        cursor: pointer;
        flex-shrink: 0;

        svg {
            flex: 0 0 auto;
        }

        span {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        &:hover {
            color: $text-secondary;
            background: rgba(var(--accent-primary-rgb), 0.06);
        }
    }

    .member-count {
        font-size: 12px;
        color: $text-muted;
    }

    .member-count-toggle {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 3px 5px;
        border: 0;
        border-radius: $radius-sm;
        background: transparent;
        cursor: pointer;
        transition: color $transition-fast, background-color $transition-fast;
        -webkit-app-region: no-drag;

        &:hover {
            color: $text-secondary;
            background: rgba(var(--accent-primary-rgb), 0.06);
        }

        svg {
            transition: transform $transition-fast;

            &.collapsed {
                transform: rotate(180deg);
            }
        }
    }
}

.agent-avatar {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;

    :deep(svg) {
        width: 100%;
        height: 100%;
    }
}

// ─── No Room State ────────────────────────────────────────

.no-room {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    color: $text-muted;

    .no-room-icon {
        opacity: 0.3;
    }

    p {
        font-size: 14px;
    }
}

// ─── Shared ──────────────────────────────────────────────

.icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    background: none;
    border-radius: $radius-sm;
    color: $text-secondary;
    cursor: pointer;
    transition: all $transition-fast;

    &:hover {
        background-color: rgba(var(--accent-primary-rgb), 0.08);
        color: $text-primary;
    }
}

.modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.modal {
    background: $bg-card;
    border-radius: $radius-lg;
    padding: 24px;
    width: 400px;
    max-width: 90vw;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    box-sizing: border-box;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);

    h3 {
        font-size: 16px;
        font-weight: 600;
        color: $text-primary;
        margin: 0 0 20px;
    }
}

.room-settings-drawer {
    min-width: 0;
}

.settings-section {
    margin-bottom: 18px;

    h4 {
        margin: 0 0 12px;
        font-size: 13px;
        font-weight: 600;
        color: $text-primary;
    }
}

.summary-state-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    h4 {
        margin-bottom: 0;
    }
}

.summary-config-required {
    margin: 0 0 10px;
    padding: 8px 10px;
    border-radius: $radius-sm;
    color: #d97706;
    background: rgba(217, 119, 6, 0.1);
    font-size: 12px;
    line-height: 1.5;
}

.summary-status {
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    color: $text-muted;
    background: rgba(var(--text-primary-rgb), 0.06);

    &.is-summarizing {
        color: var(--accent-primary);
        background: rgba(var(--accent-primary-rgb), 0.12);
    }

    &.is-success {
        color: #36ad6a;
        background: rgba(54, 173, 106, 0.12);
    }

    &.is-failed {
        color: #d03050;
        background: rgba(208, 48, 80, 0.12);
    }
}

.summary-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin: 10px 0;
    color: $text-muted;
    font-size: 11px;

    > span {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
    }

    strong {
        color: $text-secondary;
        font-weight: 500;
    }
}

.room-workspace-actions {
    margin-top: 12px;
}

.summary-error {
    margin-bottom: 12px;
    padding: 8px 10px;
    border-radius: $radius-sm;
    color: #d03050;
    background: rgba(208, 48, 80, 0.08);
    font-size: 12px;
    overflow-wrap: anywhere;
}

.summary-anchor {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 14px;
    padding: 10px;
    border: 1px solid $border-color;
    border-radius: $radius-sm;
    color: $text-secondary;
    font-size: 12px;

    strong,
    span {
        display: block;
    }

    span {
        margin-top: 3px;
        color: $text-muted;
    }

    p {
        margin: 6px 0 0;
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        overflow-wrap: anywhere;
    }
}

.summary-loading {
    padding: 20px 0;
    color: $text-muted;
    text-align: center;
}

.form-group {
    margin-bottom: 16px;
}

.group-agent-avatar-editor {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 18px;
    padding: 12px;
    border: 1px solid $border-color;
    border-radius: $radius-md;
    background: rgba(var(--text-primary-rgb), 0.02);
}

.group-agent-avatar-controls {
    min-width: 0;
    flex: 1;

    .form-label {
        margin-bottom: 7px;
    }
}

.group-agent-avatar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.group-agent-avatar-hint {
    display: block;
    margin-top: 6px;
    color: $text-muted;
    font-size: 11px;
}

.group-agent-avatar-file {
    display: none;
}

.form-label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: $text-secondary;
    margin-bottom: 6px;
}

.code-row {
    display: flex;
    gap: 8px;
    align-items: center;
}

.invite-code-row :deep(.n-input) {
    flex: 1;
}

.modal-actions {
    margin-top: 12px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.agent-modal-actions {
    justify-content: space-between;
}

.form-hint {
    font-size: 11px;
    color: $text-muted;
    margin: 4px 0 0;
}

// ─── Connection Dot ──────────────────────────────────────

.connection-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;

    &.connected {
        background-color: $success;
        box-shadow: 0 0 6px rgba(var(--success-rgb), 0.5);
    }

    &.disconnected {
        background-color: $error;
    }
}

@keyframes group-summary-inline-spin {
    to {
        transform: rotate(360deg);
    }
}

// ─── Mobile ──────────────────────────────────────────────

@media (max-width: $breakpoint-mobile) {
    .chat-main {
        margin: 0;
        border: none;
        border-radius: 0;
        box-shadow: none;
    }

    .room-sidebar {
        position: absolute;
        left: 10px;
        top: 10px;
        bottom: 10px;
        height: auto;
        margin: 0;
        z-index: 100;
    }

    .chat-header {
        padding: 16px 12px 16px 52px;
    }

    .group-summary-inline-status {
        max-width: calc(100% - 24px);
        margin: 0 12px;
    }

    .agent-avatar-rail {
        flex-basis: 68px;
        width: 68px;
        padding: 10px 0;
    }

    .agent-avatar-rail-item {
        width: 32px;
        height: 32px;

        .agent-avatar {
            width: 30px;
            height: 30px;
        }
    }

    .agent-avatar-rail-add {
        width: 32px;
        height: 32px;
        flex-basis: 32px;
    }

    .header-sidebar-toggle {
        display: none;
    }

    .room-title-text {
        display: none;
    }

}
</style>
