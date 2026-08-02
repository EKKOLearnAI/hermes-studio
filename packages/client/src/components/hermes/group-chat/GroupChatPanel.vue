<script setup lang="ts">
import { ref, computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useMessage, NInput, NButton, NSpace, NSelect, NSlider, NPopover, NPopconfirm, NInputNumber, NCheckbox, NDropdown, NModal, type DropdownOption } from 'naive-ui'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { updateRoomConfig, forceCompress, listHandoffs } from '@/api/hermes/group-chat'
import GroupMessageList from './GroupMessageList.vue'
import GroupChatInput from './GroupChatInput.vue'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import SettingsCircuitBadge from '@/components/layout/SettingsCircuitBadge.vue'
import WorkflowModelSelector from '@/components/hermes/workflow/WorkflowModelSelector.vue'
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode } from '@/api/coding-agents'
import type { ProfileAvatar as ParticipantAvatar } from '@/api/hermes/profiles'
import { copyToClipboard } from '@/utils/clipboard'
import { generateGroupChatInviteCode, groupChatInviteCodeForClone } from '@/utils/group-chat-invite'
import type { Attachment } from '@/stores/hermes/chat'
import type { RoomAgent, RoomInfo, GroupHandoffJob, GroupChatMention, StructuredChainRequest } from '@/api/hermes/group-chat'
import { useFilesStore } from '@/stores/hermes/files'
import { useToolPanelStore } from '@/stores/hermes/tool-panel'
import { hasDesktopBrowserBridge } from '@/utils/desktop-bridge'
import { OPEN_DESKTOP_BROWSER_PANEL_EVENT } from '@/utils/desktop-browser'
import { canScopedCodingAgentUseProvider } from '@/utils/codingAgentProviders'
import { reasoningEffortAccentColors } from '@/components/hermes/chat/reasoning-effort-visuals'

const FilesPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/FilesPanel.vue')).default)
const FilePreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/FilePreview.vue')).default)
const WorkspaceDiffPreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/WorkspaceDiffPreview.vue')).default)
const DesktopBrowserPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/DesktopBrowserPanel.vue')).default)

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
const showEditAgentModal = ref(false)
const showCompressionModal = ref(false)
const showUserProfileModal = ref(false)
const userProfileName = ref('')
const userProfileDescription = ref('')
const isSavingUserProfile = ref(false)
const joinInviteCode = ref('')
const isJoiningByInviteCode = ref(false)
const leavingRoomIds = ref<Set<string>>(new Set())
const compressionConfig = ref({ triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10 })
const maxAgentMentionDepth = ref(4)
const unlimitedAgentMentionDepth = ref(false)
const handoffMode = ref<'mentions' | 'fixed'>('mentions')
const handoffOrder = ref<string[]>([])
const handoffJobs = ref<GroupHandoffJob[]>([])
const handoffPollTimer = ref<ReturnType<typeof setInterval> | null>(null)
const expandedActivityChains = ref<Set<string>>(new Set())
const stoppingActivityChains = ref<Set<string>>(new Set())
const stoppingActivityAgents = ref<Set<string>>(new Set())
const isCompressing = ref(false)
const inviteCodeDraft = ref('')
const isSavingInviteCode = ref(false)
const selectedProfile = ref<string | null>(null)
const agentName = ref('')
const agentDescription = ref('')
const editingAgentId = ref('')
const expandedParticipantId = ref('')
const expandedParticipantMessageId = ref('')
const participantQuickX = ref<number | undefined>(undefined)
const participantQuickY = ref<number | undefined>(undefined)
let participantQuickTrigger: HTMLElement | null = null
const participantRuntime = ref<'hermes' | 'coding_agent'>('hermes')
const participantCodingAgentId = ref<'' | 'claude-code' | 'codex'>('')
const participantMode = ref<'scoped' | 'global'>('scoped')
const participantProvider = ref('')
const participantModel = ref('')
const participantApiMode = ref('')
const participantReasoningEffort = ref('default')
const participantAvatar = ref<ParticipantAvatar | null>(null)
const participantAvatarCustomized = ref(false)
const participantAvatarInputRef = ref<HTMLInputElement | null>(null)
const cloneSourceRoomId = ref<string | null>(null)
const cloneRoomName = ref('')
const cloneInviteCode = ref('')
const contextRoomId = ref<string | null>(null)
const showRoomContextMenu = ref(false)
const roomContextMenuX = ref(0)
const roomContextMenuY = ref(0)
const groupChatInputRef = ref<(InstanceType<typeof GroupChatInput> & {
    addFiles?: (files: File[]) => void
    insertParticipantMention?: (participantId: string, displayName: string) => void
}) | null>(null)
const chatDropCounter = ref(0)
const isChatDropActive = ref(false)
const groupChatContentWrapperRef = ref<HTMLElement | null>(null)
const showWorkspacePanel = ref(false)
const activeWorkspacePanel = ref<'files' | 'browser'>('files')
const desktopBrowserAvailable = hasDesktopBrowserBridge()
const workspacePanelMobile = ref(window.innerWidth <= 768)
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

const participantRuntimeOptions = computed(() => [
    { label: 'Hermes', value: 'hermes' },
    { label: 'Codex', value: 'codex' },
    { label: 'Claude Code', value: 'claude-code' },
])
const participantApiModeValues = ['chat_completions', 'codex_responses', 'anthropic_messages', 'bedrock_converse', 'codex_app_server'] as const

function normalizeParticipantApiMode(value: unknown, fallback = 'chat_completions'): string {
    const normalized = String(value || '').trim()
    return (participantApiModeValues as readonly string[]).includes(normalized) ? normalized : fallback
}

const participantApiModeOptions = computed(() => [
    { label: 'Chat Completions', value: 'chat_completions' },
    { label: 'Responses API', value: 'codex_responses' },
    { label: 'Anthropic Messages', value: 'anthropic_messages' },
])
const participantReasoningOptions = computed(() => [
    { label: t('chat.reasoningEffort.options.default'), value: '' },
    { label: t('chat.reasoningEffort.options.none'), value: 'none' },
    { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
    { label: t('chat.reasoningEffort.options.low'), value: 'low' },
    { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
    { label: t('chat.reasoningEffort.options.high'), value: 'high' },
    { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
    { label: t('chat.reasoningEffort.options.max'), value: 'max' },
])
const participantModelGroups = computed(() => {
    const groups = appStore.profileModelGroups.find(entry => entry.profile === selectedProfile.value)?.groups || appStore.modelGroups
    const codingAgentId = participantCodingAgentId.value
    if (participantRuntime.value !== 'coding_agent' || !codingAgentId) return groups
    return groups.filter(group => canScopedCodingAgentUseProvider(codingAgentId, group.provider))
})
const selectedProfileDefaults = computed(() => (
    appStore.profileModelGroups.find(entry => entry.profile === selectedProfile.value)
))
const participantConfigurationValid = computed(() => {
    if (participantMode.value === 'global') return true
    if (participantRuntime.value === 'hermes') {
        return !!participantProvider.value && !!participantModel.value
    }
    return !!participantCodingAgentId.value
        && !!participantProvider.value
        && !!participantModel.value
        && !!participantApiMode.value
        && canScopedCodingAgentUseProvider(participantCodingAgentId.value, participantProvider.value)
})
const participantCanSubmit = computed(() => !!selectedProfile.value && participantConfigurationValid.value)

function defaultParticipantAvatar(value = participantRuntimeValue()): ParticipantAvatar {
    const assetUrl = value === 'codex'
        ? '/coding-agents/codex-openai.png'
        : value === 'claude-code'
            ? '/coding-agents/claude-code.svg'
            : '/coding-agents/hermes.png'
    return { type: 'asset', assetUrl }
}

function applySelectedProfileDefaults() {
    const profileDefaults = selectedProfileDefaults.value
    if (!profileDefaults) return
    const defaultGroup = participantModelGroups.value.find(group => group.provider === profileDefaults.default_provider)
    const providerGroup = defaultGroup || participantModelGroups.value[0]
    participantProvider.value = providerGroup?.provider || ''
    participantModel.value = defaultGroup?.models.includes(profileDefaults.default || '')
        ? profileDefaults.default || ''
        : providerGroup?.models[0] || ''
    const fallbackApiMode = inferCodingAgentApiMode(providerGroup?.provider, providerGroup?.base_url)
    participantApiMode.value = normalizeCodingAgentApiMode(providerGroup?.api_mode, fallbackApiMode)
}

function setParticipantProfile(value: string | null) {
    selectedProfile.value = value
    applySelectedProfileDefaults()
}

function setParticipantRuntime(value: string) {
    participantRuntime.value = value === 'hermes' ? 'hermes' : 'coding_agent'
    participantCodingAgentId.value = value === 'codex' || value === 'claude-code' ? value : ''
    applySelectedProfileDefaults()
    if (!agentName.value.trim() || ['Hermes', 'Codex', 'Claude Code'].includes(agentName.value.trim())) {
        agentName.value = value === 'codex' ? 'Codex' : value === 'claude-code' ? 'Claude Code' : 'Hermes'
    }
    if (!participantAvatarCustomized.value) participantAvatar.value = defaultParticipantAvatar(value)
}

function participantRuntimeValue(): string {
    return participantRuntime.value === 'hermes' ? 'hermes' : participantCodingAgentId.value
}

function handleParticipantModelSelect(selection: { provider: string; model: string; apiMode?: string }) {
    participantProvider.value = selection.provider
    participantModel.value = selection.model
    const providerGroup = participantModelGroups.value.find(group => group.provider === selection.provider)
    participantApiMode.value = normalizeCodingAgentApiMode(
        selection.apiMode,
        inferCodingAgentApiMode(providerGroup?.provider, providerGroup?.base_url),
    )
}

function resetParticipantForm() {
    editingAgentId.value = ''
    selectedProfile.value = profilesStore.activeProfileName || profilesStore.profiles[0]?.name || null
    agentName.value = 'Hermes'
    agentDescription.value = ''
    participantRuntime.value = 'hermes'
    participantCodingAgentId.value = ''
    participantMode.value = 'scoped'
    participantProvider.value = ''
    participantModel.value = ''
    participantApiMode.value = ''
    participantReasoningEffort.value = 'default'
    participantAvatar.value = defaultParticipantAvatar('hermes')
    participantAvatarCustomized.value = false
    applySelectedProfileDefaults()
}

function randomizeParticipantAvatar() {
    participantAvatar.value = { type: 'generated', seed: `participant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }
    participantAvatarCustomized.value = true
}

function resetParticipantAvatar() {
    participantAvatar.value = defaultParticipantAvatar()
    participantAvatarCustomized.value = false
}

function triggerParticipantAvatarUpload() {
    participantAvatarInputRef.value?.click()
}

async function handleParticipantAvatarFileChange(event: Event) {
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
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
        reader.readAsDataURL(file)
    })
    participantAvatar.value = { type: 'image', dataUrl }
    participantAvatarCustomized.value = true
}

function profileAvatarFor(profileName?: string) {
    if (!profileName) return null
    return profilesStore.profiles.find(profile => profile.name === profileName)?.avatar || null
}

function agentAvatarName(agent: RoomAgent): string {
    return agent.profile || agent.name || agent.agentId
}

const hasRoom = computed(() => !!store.currentRoomId)
const currentRoom = computed(() => store.rooms.find(room => room.id === store.currentRoomId) || null)
const contextRoom = computed(() => store.rooms.find(room => room.id === contextRoomId.value) || null)
function canManageRoom(room: Pick<RoomInfo, 'canManage'> | null | undefined): boolean {
    return room?.canManage === true
}
function canApproveRoom(room: Pick<RoomInfo, 'canApprove'> | null | undefined): boolean {
    return room?.canApprove === true
}
const currentRoomCanManage = computed(() => canManageRoom(currentRoom.value))
const currentRoomCanApprove = computed(() => canApproveRoom(currentRoom.value))
const expandedParticipant = computed(() => (
    store.agents.find(agent => agent.agentId === expandedParticipantId.value) || null
))
const handoffModeOptions = computed(() => [
    { label: t('groupChat.handoffModeMentions'), value: 'mentions' },
    { label: t('groupChat.handoffModeFixed'), value: 'fixed' },
])
const handoffAgentOptions = computed(() => store.agents.map(agent => ({ label: agent.name, value: agent.agentId })))
type ActivityChain = {
    chainId: string
    jobs: GroupHandoffJob[]
    activeJobs: GroupHandoffJob[]
    activeAgentIds: string[]
    step: number
    total: number
    status: 'pending' | 'running'
}
const activityChains = computed<ActivityChain[]>(() => {
    const jobsByChain = new Map<string, GroupHandoffJob[]>()
    for (const job of handoffJobs.value) {
        const jobs = jobsByChain.get(job.chainId) || []
        jobs.push(job)
        jobsByChain.set(job.chainId, jobs)
    }
    return Array.from(jobsByChain.entries()).flatMap(([chainId, jobs]) => {
        const activeJobs = jobs
            .filter(job => job.status === 'pending' || job.status === 'running')
            .sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt)
        if (!activeJobs.length) return []
        let orderedIds: string[] = []
        for (const job of activeJobs) {
            try {
                const parsed = JSON.parse(job.chainOrderJson || '[]')
                if (Array.isArray(parsed) && parsed.length > orderedIds.length) orderedIds = parsed.map(String)
            } catch {
                // A malformed historical plan still falls back to observed jobs.
            }
        }
        const activeAgentIds = Array.from(new Set(activeJobs.map(job => job.targetAgentId).filter(Boolean)))
        const running = activeJobs.find(job => job.status === 'running')
        const current = running || activeJobs[0]
        const total = Math.max(orderedIds.length, ...jobs.map(job => job.depth + 1), 1)
        return [{
            chainId,
            jobs: [...jobs].sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt),
            activeJobs,
            activeAgentIds,
            step: Math.min(total, current.depth + 1),
            total,
            status: running ? 'running' as const : 'pending' as const,
        }]
    }).sort((a, b) => a.activeJobs[0].createdAt - b.activeJobs[0].createdAt)
})
const relayActivityAgentIds = computed(() => new Set(activityChains.value.flatMap(chain => chain.activeAgentIds)))
const replyActivities = computed(() => Array.from(store.contextStatuses.values()).filter(status => (
    !relayActivityAgentIds.value.has(status.agentId)
)))
const hasActivityDock = computed(() => activityChains.value.length > 0 || replyActivities.value.length > 0 || !!store.typingText)
const visibleApproval = computed(() => currentRoomCanApprove.value ? store.activePendingApproval : null)
const currentWorkspaceLabel = computed(() => workspaceBasename(currentRoom.value?.workspace || ''))
const canUpdateInviteCode = computed(() => {
    const nextCode = inviteCodeDraft.value
    return currentRoomCanManage.value && !isSavingInviteCode.value && !!nextCode.trim() && nextCode !== (currentRoom.value?.inviteCode || '')
})
const canJoinByInviteCode = computed(() => !!joinInviteCode.value.trim() && !isJoiningByInviteCode.value)
function isLeavingRoom(roomId: string): boolean {
    return leavingRoomIds.value.has(roomId)
}
const showWorkspaceModal = ref(false)
const workspaceRoomId = ref<string | null>(null)
const workspaceValue = ref('')

/** Resolve the current user's custom avatar — first from the member list, then from the cached current-user value. */
const userMemberAvatar = computed(() => {
    // Prefer the live member list (populated when a room is active)
    const member = store.members.find(m => m.userId === store.userId)
    const raw = member?.avatar || store.currentUserAvatar
    if (!raw) return null
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (parsed && parsed.type === 'image' && parsed.dataUrl) return parsed
    } catch { /* malformed JSON — fall through to multiavatar */ }
    return null
})

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
    if (!currentRoom.value?.workspace) return
    if (showWorkspacePanel.value && activeWorkspacePanel.value === 'files') {
        closeWorkspacePanel()
        return
    }
    activeWorkspacePanel.value = 'files'
    showWorkspacePanel.value = true
}

function selectWorkspacePanel(panel: 'files' | 'browser'): void {
    if (panel === 'browser') {
        if (!desktopBrowserAvailable) return
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
    return generateGroupChatInviteCode()
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

async function handleCreateRoom(name: string, inviteCode: string, userName: string, description: string, compression: { triggerTokens: number; maxHistoryTokens: number; tailMessageCount: number }, workspace: string) {
    try {
        store.setUserInfo(userName, description)
        const res = await store.createNewRoom(
            name,
            inviteCode,
            undefined,
            compression,
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

async function handleJoinByInviteCode() {
    const code = joinInviteCode.value
    if (!code.trim() || isJoiningByInviteCode.value) return
    isJoiningByInviteCode.value = true
    try {
        const room = await store.joinByCode(code)
        joinInviteCode.value = ''
        message.success(t('groupChat.joined'))
        await router.push({ name: 'hermes.groupChatRoom', params: { roomId: room.id } })
    } catch (err: any) {
        message.error(err?.message || t('groupChat.joinFailed'))
    } finally {
        isJoiningByInviteCode.value = false
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

async function handleLeaveRoom(roomId: string) {
    if (isLeavingRoom(roomId)) return
    const wasCurrentRoom = store.currentRoomId === roomId
    leavingRoomIds.value = new Set([...leavingRoomIds.value, roomId])
    try {
        await store.leaveRoom(roomId)
        if (wasCurrentRoom) {
            await router.replace({ name: 'hermes.groupChat' })
        }
        message.success(t('groupChat.roomLeft'))
    } catch (err: any) {
        message.error(err?.message || t('groupChat.leaveRoomFailed'))
    } finally {
        const next = new Set(leavingRoomIds.value)
        next.delete(roomId)
        leavingRoomIds.value = next
    }
}

function buildRoomUrl(roomId: string) {
    const href = router.resolve({ name: 'hermes.groupChatRoom', params: { roomId } }).href
    return `${window.location.origin}${window.location.pathname}${href}`
}

async function copyRoomLink(roomId: string) {
    const ok = await copyToClipboard(buildRoomUrl(roomId))
    if (ok) message.success(t('common.copied'))
    else message.error(t('common.copied') + ' ✗')
}

async function handleCopyInviteCode() {
    const code = inviteCodeDraft.value
    if (!code.trim()) return
    const ok = await copyToClipboard(code)
    if (ok) message.success(t('groupChat.inviteCodeCopied'))
    else message.error(t('groupChat.inviteCodeCopyFailed'))
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
            inviteCode: groupChatInviteCodeForClone(cloneInviteCode.value),
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

async function handleSendMessage(
    content: string,
    attachments?: Attachment[],
    mentions?: GroupChatMention[],
    chainRequest?: StructuredChainRequest,
) {
    try {
        await store.sendMessage(content, attachments, mentions, chainRequest)
    } catch (err: any) {
        message.error(err.message)
    }
}

async function handleAddAgent() {
    if (!currentRoomCanManage.value) return
    await profilesStore.fetchProfiles()
    await appStore.reloadModels({ preserveSelection: true })
    resetParticipantForm()
    showAddAgentModal.value = true
}

function handleEditAgent(agent: RoomAgent) {
    if (!currentRoomCanManage.value) return
    editingAgentId.value = agent.agentId
    selectedProfile.value = agent.profile
    agentName.value = agent.name
    agentDescription.value = agent.description
    participantRuntime.value = agent.runtime
    participantCodingAgentId.value = agent.codingAgentId
    participantMode.value = agent.mode
    participantProvider.value = agent.provider
    participantModel.value = agent.model
    participantApiMode.value = agent.apiMode
    participantReasoningEffort.value = agent.reasoningEffort || 'default'
    participantAvatar.value = agent.avatar || defaultParticipantAvatar(participantRuntimeValue())
    participantAvatarCustomized.value = !!agent.avatar
    showEditAgentModal.value = true
}

function participantRuntimeLabel(agent: RoomAgent): string {
    if ((agent.runtime || 'hermes') !== 'coding_agent') return 'Hermes'
    return agent.codingAgentId === 'claude-code' ? 'Claude Code' : 'Codex'
}

let participantQuickLifecycleGeneration = 0

function participantQuickAuthorityGeneration(): string {
    return `${store.roomAuthorityGeneration}:${participantQuickLifecycleGeneration}`
}

function participantQuickKey(roomId: string, agentId: string, authorityGeneration: string): string {
    return `${roomId}\u0000${agentId}\u0000${authorityGeneration}`
}

const participantQuickSaveQueues = new Map<string, Promise<void>>()
const participantQuickDesired = new Map<string, Pick<RoomAgent, 'provider' | 'model' | 'apiMode' | 'reasoningEffort'>>()
type ParticipantRuntimeSnapshot = Pick<RoomAgent, 'provider' | 'model' | 'apiMode' | 'reasoningEffort'>
const participantReasoningCommits = new Map<string, {
    timer: ReturnType<typeof setTimeout>
    previous: ParticipantRuntimeSnapshot
    value: ParticipantRuntimeSnapshot['reasoningEffort']
}>()

function participantModelGroupsFor(agent: RoomAgent) {
    const groups = appStore.profileModelGroups.find(entry => entry.profile === agent.profile)?.groups || appStore.modelGroups
    const codingAgentId = agent.codingAgentId
    if ((agent.runtime || 'hermes') !== 'coding_agent' || !codingAgentId) return groups
    return groups.filter(group => canScopedCodingAgentUseProvider(codingAgentId, group.provider))
}

function participantModelOptions(agent: RoomAgent): DropdownOption[] {
    return participantModelGroupsFor(agent).map(group => ({
        type: 'group',
        label: group.label || group.provider,
        key: group.provider,
        children: [
            ...group.models,
            ...(appStore.customModels[group.provider] || []).filter(model => !group.models.includes(model)),
        ].map(model => ({
            label: appStore.displayModelName(model, group.provider),
            value: `${group.provider}\u0000${model}`,
            disabled: !!group.model_meta?.[model]?.disabled,
        })),
    })) as DropdownOption[]
}

function participantApiModeOptionsFor(_agent: RoomAgent) {
    return participantApiModeOptions.value
}

function participantReasoningSliderValue(agent: RoomAgent): number {
    const value = agent.reasoningEffort || ''
    const index = participantReasoningOptions.value.findIndex(option => option.value === value)
    return index >= 0 ? index : 0
}

function participantReasoningSliderLabel(value: number): string {
    return participantReasoningOptions.value[Math.round(value)]?.label || t('chat.reasoningEffort.defaultLabel')
}

function participantReasoningLabel(agent: RoomAgent): string {
    return participantReasoningSliderLabel(participantReasoningSliderValue(agent))
}

function participantReasoningAccentStyle(agent: RoomAgent) {
    return {
        '--reasoning-effort-accent-color': reasoningEffortAccentColors[participantReasoningSliderValue(agent)]
            || reasoningEffortAccentColors[0],
    }
}

function participantApiModeFor(agent: RoomAgent): string {
    if (agent.apiMode) return agent.apiMode
    const group = participantModelGroupsFor(agent).find(candidate => candidate.provider === agent.provider)
    const fallback = inferCodingAgentApiMode(group?.provider || agent.provider, group?.base_url)
    return normalizeParticipantApiMode(group?.api_mode, fallback)
}

function participantRuntimeSnapshot(agent: RoomAgent): ParticipantRuntimeSnapshot {
    return {
        provider: agent.provider || '',
        model: agent.model || '',
        apiMode: agent.apiMode || '',
        reasoningEffort: agent.reasoningEffort || '',
    }
}

function participantQuickAuthorityIsCurrent(roomId: string, authorityGeneration: string): boolean {
    return store.currentRoomId === roomId
        && participantQuickAuthorityGeneration() === authorityGeneration
}

function applyParticipantQuickState(roomId: string, agentId: string, authorityGeneration: string, state: Partial<RoomAgent>) {
    if (!participantQuickAuthorityIsCurrent(roomId, authorityGeneration)) return
    const current = store.agents.find(candidate => candidate.agentId === agentId)
    if (current) Object.assign(current, state)
}

async function saveParticipantQuickSetting(agent: RoomAgent, updates: Partial<ParticipantRuntimeSnapshot>, rollbackOverride?: ParticipantRuntimeSnapshot) {
    if (!store.currentRoomId || !currentRoomCanManage.value) return
    const roomId = store.currentRoomId
    const authorityGeneration = participantQuickAuthorityGeneration()
    const queueKey = participantQuickKey(roomId, agent.agentId, authorityGeneration)
    const previous = rollbackOverride || participantRuntimeSnapshot(agent)
    const base = participantQuickDesired.get(queueKey) || previous
    const optimistic = { ...base, ...updates }
    participantQuickDesired.set(queueKey, optimistic)
    Object.assign(agent, optimistic)

    const activeQueue = participantQuickSaveQueues.get(queueKey)
    if (activeQueue) {
        await activeQueue
        return
    }

    const queue = (async () => {
        let rollback = previous
        while (true) {
            const requested = participantQuickDesired.get(queueKey)
            if (!requested) break
            try {
                const saved = await store.updateAgentInRoom(roomId, agent.agentId, {
                    provider: requested.provider,
                    model: requested.model,
                    apiMode: String(requested.apiMode || ''),
                    reasoningEffort: requested.reasoningEffort,
                })
                if (!participantQuickAuthorityIsCurrent(roomId, authorityGeneration)) break
                rollback = {
                    provider: saved.provider || '',
                    model: saved.model || '',
                    apiMode: saved.apiMode || '',
                    reasoningEffort: saved.reasoningEffort || '',
                }
                const desired = participantQuickDesired.get(queueKey)
                if (desired === requested) {
                    participantQuickDesired.delete(queueKey)
                    applyParticipantQuickState(roomId, agent.agentId, authorityGeneration, saved)
                    message.success(t('groupChat.participantSettingsSaved'))
                    break
                }
                if (desired) applyParticipantQuickState(roomId, agent.agentId, authorityGeneration, desired)
            } catch (error) {
                if (!participantQuickAuthorityIsCurrent(roomId, authorityGeneration)) break
                const desired = participantQuickDesired.get(queueKey)
                if (desired && desired !== requested) {
                    applyParticipantQuickState(roomId, agent.agentId, authorityGeneration, desired)
                    message.error(extractApiErrorMessage(error))
                    continue
                }
                participantQuickDesired.delete(queueKey)
                applyParticipantQuickState(roomId, agent.agentId, authorityGeneration, rollback)
                message.error(extractApiErrorMessage(error))
                break
            }
        }
    })().finally(() => {
        if (participantQuickSaveQueues.get(queueKey) === queue) {
            participantQuickSaveQueues.delete(queueKey)
        }
    })
    participantQuickSaveQueues.set(queueKey, queue)
    await queue
}

function handleQuickModelChange(agent: RoomAgent | null, value: string | null) {
    if (!agent) return
    if (!value) return
    const separator = value.indexOf('\u0000')
    if (separator < 1) return
    const provider = value.slice(0, separator)
    const model = value.slice(separator + 1)
    const group = participantModelGroupsFor(agent).find(candidate => candidate.provider === provider)
    const fallback = inferCodingAgentApiMode(group?.provider || provider, group?.base_url)
    const apiMode = normalizeParticipantApiMode(group?.api_mode, fallback)
    void saveParticipantQuickSetting(agent, { provider, model, apiMode })
}

function handleQuickApiModeChange(agent: RoomAgent | null, apiMode: string | null) {
    if (!agent) return
    if (!apiMode) return
    void saveParticipantQuickSetting(agent, { apiMode })
}

function commitParticipantReasoning(agent: RoomAgent) {
    const pending = participantReasoningCommits.get(agent.agentId)
    if (!pending) return
    clearTimeout(pending.timer)
    participantReasoningCommits.delete(agent.agentId)
    void saveParticipantQuickSetting(agent, { reasoningEffort: pending.value || '' }, pending.previous)
}

function handleQuickReasoningChange(agent: RoomAgent | null, value: number | [number, number]) {
    if (!agent) return
    const numericValue = Array.isArray(value) ? value[0] : value
    const reasoningEffort = participantReasoningOptions.value[Math.round(numericValue)]?.value
    if (reasoningEffort === undefined || reasoningEffort === (agent.reasoningEffort || '')) return
    const existing = participantReasoningCommits.get(agent.agentId)
    const previous = existing?.previous || participantRuntimeSnapshot(agent)
    if (existing) clearTimeout(existing.timer)
    agent.reasoningEffort = reasoningEffort
    const timer = setTimeout(() => commitParticipantReasoning(agent), 180)
    participantReasoningCommits.set(agent.agentId, { timer, previous, value: reasoningEffort })
}

function mentionParticipant(agent: RoomAgent) {
    closeParticipantQuickSettings()
    groupChatInputRef.value?.insertParticipantMention(agent.agentId, agent.name)
}

function closeParticipantQuickSettings(restoreFocus = false) {
    const trigger = participantQuickTrigger
    expandedParticipantId.value = ''
    expandedParticipantMessageId.value = ''
    participantQuickX.value = undefined
    participantQuickY.value = undefined
    participantQuickTrigger = null
    if (restoreFocus) void nextTick(() => trigger?.focus())
}

function openParticipantQuickSettings(agentId: string, trigger: HTMLElement, messageId = '') {
    if (expandedParticipantId.value === agentId && participantQuickTrigger === trigger) {
        closeParticipantQuickSettings(true)
        return
    }
    const agent = store.agents.find(candidate => candidate.agentId === agentId)
    if (!agent) return
    const rect = trigger.getBoundingClientRect()
    participantQuickX.value = rect.right + 8
    participantQuickY.value = rect.top + Math.min(18, rect.height / 2)
    participantQuickTrigger = trigger
    expandedParticipantId.value = agent.agentId
    expandedParticipantMessageId.value = messageId
}

function handleParticipantAvatarTrigger(agentId: string, event: MouseEvent) {
    const trigger = event.currentTarget
    if (trigger instanceof HTMLElement) openParticipantQuickSettings(agentId, trigger)
}

function handleMessageParticipantAvatar(payload: { participantId: string, messageId: string, trigger: HTMLElement }) {
    openParticipantQuickSettings(payload.participantId, payload.trigger, payload.messageId)
}

function handleParticipantQuickShowUpdate(show: boolean) {
    if (!show) closeParticipantQuickSettings(true)
}

function handleParticipantQuickClickOutside(event: MouseEvent) {
    const target = event.target
    if (target instanceof Node && participantQuickTrigger?.contains(target)) return
    closeParticipantQuickSettings()
}

function handleParticipantQuickEscape() {
    closeParticipantQuickSettings(true)
}

function participantModelValue(agent: RoomAgent): string | null {
    return agent.provider && agent.model ? `${agent.provider}\u0000${agent.model}` : null
}

async function refreshHandoffs() {
    if (!store.currentRoomId) {
        handoffJobs.value = []
        return
    }
    const roomId = store.currentRoomId
    try {
        const res = await listHandoffs(store.currentRoomId)
        if (store.currentRoomId === roomId) handoffJobs.value = res.jobs
    } catch {
        // Fail closed: the server is authoritative. A failed reconciliation
        // must not preserve a pre-disconnect active relay in the Activity Dock.
        if (store.currentRoomId === roomId) handoffJobs.value = []
    }
}

function handoffStatusLabel(status: GroupHandoffJob['status']): string {
    const key = status === 'pending' ? 'handoffPending'
        : status === 'running' ? 'handoffRunning'
            : status === 'interrupted' ? 'handoffInterrupted'
                : 'handoffFailed'
    return t(`groupChat.${key}`)
}

function isActivityChainExpanded(chainId: string): boolean {
    return expandedActivityChains.value.has(chainId)
}

function toggleActivityChain(chainId: string) {
    const next = new Set(expandedActivityChains.value)
    if (next.has(chainId)) next.delete(chainId)
    else next.add(chainId)
    expandedActivityChains.value = next
}

function isActivityAgentStopping(agentId: string): boolean {
    return stoppingActivityAgents.value.has(agentId)
}

async function stopActivityReply(agentId: string) {
    if (!currentRoomCanManage.value || isActivityAgentStopping(agentId)) return
    stoppingActivityAgents.value = new Set([...stoppingActivityAgents.value, agentId])
    try {
        await store.interruptAgent(agentId)
    } catch (err: any) {
        message.error(err.message || t('common.saveFailed'))
    } finally {
        const next = new Set(stoppingActivityAgents.value)
        next.delete(agentId)
        stoppingActivityAgents.value = next
    }
}

async function stopActivityChain(chain: ActivityChain) {
    if (!currentRoomCanManage.value || stoppingActivityChains.value.has(chain.chainId)) return
    stoppingActivityChains.value = new Set([...stoppingActivityChains.value, chain.chainId])
    try {
        await store.interruptHandoffChain(chain.chainId)
        await refreshHandoffs()
    } catch (err: any) {
        message.error(err.message || t('common.saveFailed'))
    } finally {
        const next = new Set(stoppingActivityChains.value)
        next.delete(chain.chainId)
        stoppingActivityChains.value = next
    }
}

function activityChainAgentSummary(chain: ActivityChain): string {
    return chain.activeAgentIds.map(handoffAgentName).join(', ')
}

function activityChainStepStatus(job: GroupHandoffJob): string {
    if (job.status === 'completed') return t('groupChat.activityCompleted')
    if (job.status === 'running') return t('groupChat.activityRunning')
    if (job.status === 'pending') return t('groupChat.activityPending')
    return handoffStatusLabel(job.status)
}

function moveHandoffAgent(agentId: string, direction: -1 | 1) {
    const index = handoffOrder.value.indexOf(agentId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= handoffOrder.value.length) return
    const next = [...handoffOrder.value]
    ;[next[index], next[target]] = [next[target], next[index]]
    handoffOrder.value = next
}

function handoffAgentName(agentId: string): string {
    return store.agents.find(agent => agent.agentId === agentId)?.name || agentId
}

onMounted(() => {
    window.addEventListener('hermes:open-page-sidebar', openPageSidebar)
    window.addEventListener('hermes:preview-workspace-file', handleWorkspaceFilePreviewRequest)
    window.addEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, handleOpenDesktopBrowserPanelRequest)
    window.addEventListener('resize', handleWorkspacePanelResize)
    handleWorkspacePanelResize()
    void refreshHandoffs()
    handoffPollTimer.value = setInterval(() => { void refreshHandoffs() }, 2_000)
    if (profilesStore.profiles.length === 0) {
        void profilesStore.fetchProfiles()
    }
})

onUnmounted(() => {
    participantQuickLifecycleGeneration += 1
    participantQuickDesired.clear()
    participantQuickSaveQueues.clear()
    window.removeEventListener('hermes:open-page-sidebar', openPageSidebar)
    window.removeEventListener('hermes:preview-workspace-file', handleWorkspaceFilePreviewRequest)
    window.removeEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, handleOpenDesktopBrowserPanelRequest)
    window.removeEventListener('resize', handleWorkspacePanelResize)
    if (handoffPollTimer.value) clearInterval(handoffPollTimer.value)
    for (const pending of participantReasoningCommits.values()) clearTimeout(pending.timer)
    participantReasoningCommits.clear()
    handoffPollTimer.value = null
    stopWorkspaceResize()
    if (showWorkspacePanel.value) closeWorkspacePanel()
    else toolPanelStore.closeWorkspaceDiff()
})

watch(() => store.currentRoomId, (roomId, previousRoomId) => {
    if (roomId !== previousRoomId) {
        participantQuickDesired.clear()
        participantQuickSaveQueues.clear()
        for (const pending of participantReasoningCommits.values()) clearTimeout(pending.timer)
        participantReasoningCommits.clear()
        closeParticipantQuickSettings()
    }
    if (roomId !== previousRoomId && (filesStore.previewFile || toolPanelStore.workspaceDiff || showWorkspacePanel.value)) closeWorkspacePanel()
    handoffJobs.value = []
    expandedActivityChains.value = new Set()
    stoppingActivityChains.value = new Set()
    stoppingActivityAgents.value = new Set()
    void refreshHandoffs()
})

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
    if (!selectedProfile.value) return
    try {
        await store.addAgentToRoom(store.currentRoomId, {
            profile: selectedProfile.value,
            name: agentName.value.trim() || undefined,
            description: agentDescription.value.trim() || undefined,
            runtime: participantRuntime.value,
            codingAgentId: participantCodingAgentId.value,
            mode: participantMode.value,
            provider: participantMode.value === 'scoped' ? participantProvider.value : '',
            model: participantMode.value === 'scoped' ? participantModel.value : '',
            apiMode: participantRuntime.value === 'coding_agent' && participantMode.value === 'scoped' ? participantApiMode.value : '',
            reasoningEffort: participantMode.value === 'scoped' ? (participantReasoningEffort.value === 'default' ? '' : participantReasoningEffort.value) : '',
            avatar: participantAvatar.value,
        })
        showAddAgentModal.value = false
        resetParticipantForm()
        message.success(t('groupChat.agentAdded'))
    } catch (err: any) {
        if (err.message?.includes('already')) {
            message.warning(t('groupChat.agentAlreadyInRoom'))
        } else {
            message.error(extractApiErrorMessage(err))
        }
    }
}

async function confirmEditAgent() {
    if (!store.currentRoomId || !editingAgentId.value || !agentName.value.trim()) return
    try {
        await store.updateAgentInRoom(store.currentRoomId, editingAgentId.value, {
            name: agentName.value.trim(),
            description: agentDescription.value.trim(),
            mode: participantMode.value,
            provider: participantMode.value === 'scoped' ? participantProvider.value : '',
            model: participantMode.value === 'scoped' ? participantModel.value : '',
            apiMode: participantRuntime.value === 'coding_agent' && participantMode.value === 'scoped' ? participantApiMode.value : '',
            reasoningEffort: participantMode.value === 'scoped' ? (participantReasoningEffort.value === 'default' ? '' : participantReasoningEffort.value) : '',
            avatar: participantAvatar.value,
        })
        showEditAgentModal.value = false
        resetParticipantForm()
        message.success(t('common.saved'))
    } catch (err: any) {
        message.error(extractApiErrorMessage(err))
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
        await store.setRoomWorkspace(roomId, String(workspaceValue.value || '').trim())
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

function handleOpenRoomSettings() {
    if (!currentRoomCanManage.value) return
    const room = store.rooms.find(r => r.id === store.currentRoomId)
    if (room) {
        inviteCodeDraft.value = room.inviteCode || ''
        compressionConfig.value = {
            triggerTokens: room.triggerTokens ?? 100000,
            maxHistoryTokens: room.maxHistoryTokens ?? 32000,
            tailMessageCount: room.tailMessageCount ?? 10,
        }
        unlimitedAgentMentionDepth.value = room.maxAgentMentionDepth === null
        maxAgentMentionDepth.value = Number.isSafeInteger(room.maxAgentMentionDepth) && Number(room.maxAgentMentionDepth) > 0
            ? Number(room.maxAgentMentionDepth)
            : 4
        handoffMode.value = room.handoffMode === 'fixed' ? 'fixed' : 'mentions'
        const storedOrder = Array.isArray(room.handoffOrder) ? room.handoffOrder.map(String) : []
        const allowed = new Set(store.agents.map(agent => agent.agentId))
        handoffOrder.value = storedOrder.filter((id, index) => allowed.has(id) && storedOrder.indexOf(id) === index)
        if (handoffMode.value === 'fixed' && handoffOrder.value.length < 2) {
            handoffOrder.value = store.agents.map(agent => agent.agentId)
        }
    }
    showCompressionModal.value = true
}

async function handleSaveInviteCode() {
    if (!store.currentRoomId || !currentRoomCanManage.value || isSavingInviteCode.value || !canUpdateInviteCode.value) return
    const nextCode = inviteCodeDraft.value
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

async function handleSaveCompressionConfig() {
    if (!store.currentRoomId) return
    if (!currentRoomCanManage.value) return
    const finiteDepth = Number(maxAgentMentionDepth.value)
    if (!unlimitedAgentMentionDepth.value && (!Number.isSafeInteger(finiteDepth) || finiteDepth <= 0)) {
        message.error(t('groupChat.invalidAutomaticHandoffLimit'))
        return
    }
    if (handoffMode.value === 'fixed' && (handoffOrder.value.length < 2 || new Set(handoffOrder.value).size !== handoffOrder.value.length)) {
        message.error(t('groupChat.invalidFixedHandoffOrder'))
        return
    }
    try {
        const res = await updateRoomConfig(store.currentRoomId, {
            ...compressionConfig.value,
            maxAgentMentionDepth: unlimitedAgentMentionDepth.value ? null : finiteDepth,
            handoffMode: handoffMode.value,
            handoffOrder: handoffOrder.value,
        })
        const idx = store.rooms.findIndex(r => r.id === store.currentRoomId)
        if (idx >= 0 && res.room) store.rooms[idx] = res.room
        showCompressionModal.value = false
        message.success(t('groupChat.roomSettingsSaved'))
    } catch {
        message.error(t('common.saveFailed'))
    }
}

async function handleForceCompress() {
    if (!store.currentRoomId || isCompressing.value) return
    if (!currentRoomCanManage.value) return
    if (store.contextStatuses.size > 0) {
        message.warning(t('groupChat.compressingInProgress'))
        return
    }
    isCompressing.value = true
    try {
        await forceCompress(store.currentRoomId)
        message.success(t('groupChat.compressionSaved'))
    } catch {
        message.error(t('common.saveFailed'))
    } finally {
        isCompressing.value = false
    }
}

async function handleRemoveAgent(agentId: string) {
    if (!store.currentRoomId) return
    if (!currentRoomCanManage.value) return
    try {
        await store.removeAgentFromRoom(store.currentRoomId, agentId)
    } catch {
        message.error(t('common.deleteFailed'))
    }
}

async function handleApproval(choice: 'once' | 'session' | 'always' | 'deny') {
    if (!currentRoomCanApprove.value) return
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
            <form class="invite-join-form" @submit.prevent="handleJoinByInviteCode">
                <NInput
                    v-model:value="joinInviteCode"
                    size="small"
                    :placeholder="t('groupChat.enterCode')"
                    :disabled="isJoiningByInviteCode"
                />
                <NButton
                    attr-type="submit"
                    size="small"
                    type="primary"
                    :disabled="!canJoinByInviteCode"
                    :loading="isJoiningByInviteCode"
                >
                    {{ t('groupChat.joinByCode') }}
                </NButton>
            </form>
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
                    <NPopconfirm v-if="room.canLeave !== false" @positive-click="handleLeaveRoom(room.id)">
                        <template #trigger>
                            <button
                                class="room-action-btn leave"
                                type="button"
                                :title="t('groupChat.leaveRoom')"
                                :aria-label="t('groupChat.leaveRoom')"
                                :disabled="isLeavingRoom(room.id)"
                                @click.stop
                            >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                                    <polyline points="16 17 21 12 16 7" />
                                    <line x1="21" y1="12" x2="9" y2="12" />
                                </svg>
                            </button>
                        </template>
                        {{ t('groupChat.leaveRoomConfirm') }}
                    </NPopconfirm>
                    <NPopconfirm v-if="canManageRoom(room)" @positive-click="handleDeleteRoom(room.id)">
                        <template #trigger>
                            <button class="room-action-btn danger" type="button" :title="t('groupChat.deleteRoomConfirm')" :aria-label="t('groupChat.deleteRoomConfirm')" @click.stop>
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
                        @click="toggleWorkspacePanel"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                        </svg>
                        <span>{{ currentWorkspaceLabel }}</span>
                    </button>
                </div>
                <div class="header-info">
                    <!-- Stacked avatars (user + agents) -->
                    <NPopover v-if="store.agents.length" trigger="click" placement="bottom-end" :width="360">
                        <template #trigger>
                            <button
                                type="button"
                                class="avatar-stack-inner avatar-stack-trigger"
                                :aria-label="`${t('groupChat.agents')} (${store.agents.length})`"
                            >
                                <!-- User avatar first -->
                                <span class="avatar-stack-item" :style="{ zIndex: store.agents.length + 1 }">
                                    <ProfileAvatar class="agent-avatar" :name="store.userName || store.userId" :avatar="userMemberAvatar" :size="24" />
                                </span>
                                <span
                                    v-for="(agent, index) in store.agents.slice(-4)"
                                    :key="agent.agentId"
                                    class="avatar-stack-item"
                                    :style="{ zIndex: store.agents.length - index }"
                                >
                                    <ProfileAvatar class="agent-avatar" :name="agentAvatarName(agent)" :avatar="agent.avatar || profileAvatarFor(agent.profile)" :size="24" />
                                </span>
                                <span v-if="store.agents.length > 4" class="avatar-stack-more">+{{ store.agents.length - 4 }}</span>
                            </button>
                        </template>
                        <div class="agent-popover">
                            <div class="agent-popover-item" style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--n-border-color, #efeff5);">
                                <ProfileAvatar class="agent-avatar" :name="store.userName || store.userId" :avatar="userMemberAvatar" :size="28" />
                                <div class="agent-popover-info">
                                    <span class="agent-popover-name">{{ store.userName || t('groupChat.you') }}</span>
                                    <span class="agent-popover-profile">{{ t('groupChat.you') }}</span>
                                </div>
                            </div>
                            <div class="agent-popover-title">{{ t('groupChat.agents') }} ({{ store.agents.length }})</div>
                            <div v-for="agent in store.agents" :key="agent.agentId" class="participant-quick-settings-row">
                                <div class="agent-popover-item">
                                    <button
                                        type="button"
                                        class="participant-avatar-trigger"
                                        :aria-label="`${t('groupChat.participantQuickSettings')}: ${agent.name}`"
                                        :aria-expanded="expandedParticipantId === agent.agentId"
                                        @click.stop="handleParticipantAvatarTrigger(agent.agentId, $event)"
                                    >
                                        <ProfileAvatar class="agent-avatar" :name="agentAvatarName(agent)" :avatar="agent.avatar || profileAvatarFor(agent.profile)" :size="28" />
                                    </button>
                                    <div class="agent-popover-info">
                                        <span class="agent-popover-name">{{ agent.name }}</span>
                                        <span class="agent-popover-profile">{{ participantRuntimeLabel(agent) }} · {{ agent.profile }}</span>
                                    </div>
                                    <button v-if="currentRoomCanManage" class="agent-popover-remove" :title="t('common.edit')" @click="handleEditAgent(agent)">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
                                    </button>
                                    <button v-if="currentRoomCanManage" class="agent-popover-remove" @click="handleRemoveAgent(agent.agentId)">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </NPopover>
                    <!-- Only user avatar, no agents -->
                    <div v-else-if="store.userName" class="avatar-stack-inner">
                        <span class="avatar-stack-item">
                            <ProfileAvatar class="agent-avatar" :name="store.userName || store.userId" :avatar="userMemberAvatar" :size="24" />
                        </span>
                    </div>
                    <button v-if="hasRoom" class="icon-btn" :title="t('groupChat.yourName')" @click="handleOpenUserProfile">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" />
                        </svg>
                    </button>
                    <button v-if="currentRoomCanManage" class="icon-btn" :title="t('groupChat.addAgent')" @click="handleAddAgent">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
                    <button
                        v-if="currentRoom?.workspace && currentRoomCanManage"
                        class="icon-btn workspace-panel-toggle"
                        :class="{ active: showWorkspacePanel }"
                        :title="t('chat.workspace')"
                        :aria-label="t('chat.workspace')"
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
                    <span v-if="store.members.length" class="member-count">
                        {{ store.members.length }} {{ t('groupChat.members') }}
                    </span>
                    <span class="connection-dot" :class="{ connected: store.connected, disconnected: !store.connected }"></span>
                </div>
            </div>

            <div
                v-if="hasRoom"
                ref="groupChatContentWrapperRef"
                class="group-chat-content-wrapper"
                :class="{ 'chat-main--drop-active': isChatDropActive }"
            >
                <div class="group-chat-surface">
                    <div class="group-message-shell">
                        <GroupMessageList
                            :expanded-participant-message-id="expandedParticipantMessageId"
                            @participant-avatar-click="handleMessageParticipantAvatar"
                            @participant-quick-close="closeParticipantQuickSettings"
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
                    <section v-if="hasActivityDock" class="activity-dock" :aria-label="t('groupChat.activityDock')">
                        <div class="activity-dock-live" role="status" aria-live="polite" aria-atomic="true">
                            <span v-for="chain in activityChains" :key="`live-chain-${chain.chainId}`">
                                {{ chain.status === 'running' ? t('groupChat.handoffRunning') : t('groupChat.handoffPending') }} ·
                                {{ t('groupChat.activityStep', { step: chain.step, total: chain.total }) }} ·
                                {{ activityChainAgentSummary(chain) }}
                            </span>
                            <span v-for="status in replyActivities" :key="`live-reply-${status.agentId}`">
                                @{{ status.agentName }} {{ status.status === 'compressing' ? t('groupChat.agentCompressing') : t('groupChat.agentReplying') }}
                            </span>
                            <span v-if="!activityChains.length && !replyActivities.length && store.typingText">{{ store.typingText }}</span>
                        </div>
                        <div class="activity-dock-items">
                            <article v-for="chain in activityChains" :key="chain.chainId" class="activity-dock-item activity-dock-relay">
                                <div class="activity-dock-main">
                                    <span class="typing-dots" aria-hidden="true"><span /><span /><span /></span>
                                    <span class="activity-dock-primary">
                                        {{ chain.status === 'running' ? t('groupChat.handoffRunning') : t('groupChat.handoffPending') }}
                                    </span>
                                    <span class="activity-dock-meta">{{ t('groupChat.activityStep', { step: chain.step, total: chain.total }) }}</span>
                                    <span class="activity-dock-agents">{{ activityChainAgentSummary(chain) }}</span>
                                </div>
                                <div class="activity-dock-actions">
                                    <button
                                        class="activity-dock-progress-button"
                                        type="button"
                                        :aria-expanded="isActivityChainExpanded(chain.chainId)"
                                        :aria-controls="`activity-dock-chain-${chain.chainId}`"
                                        @click="toggleActivityChain(chain.chainId)"
                                    >
                                        {{ t('groupChat.viewHandoffProgress') }}
                                    </button>
                                    <button
                                        v-if="currentRoomCanManage"
                                        class="activity-dock-stop activity-dock-stop-relay"
                                        type="button"
                                        :disabled="stoppingActivityChains.has(chain.chainId)"
                                        @click="stopActivityChain(chain)"
                                    >
                                        {{ stoppingActivityChains.has(chain.chainId) ? t('groupChat.stoppingActivity') : t('groupChat.stopHandoff') }}
                                    </button>
                                </div>
                                <ol
                                    v-if="isActivityChainExpanded(chain.chainId)"
                                    :id="`activity-dock-chain-${chain.chainId}`"
                                    class="activity-dock-progress"
                                >
                                    <li v-for="job in chain.jobs" :key="job.id">
                                        <span>{{ handoffAgentName(job.targetAgentId) }}</span>
                                        <span>{{ activityChainStepStatus(job) }}</span>
                                    </li>
                                </ol>
                            </article>
                            <article v-for="status in replyActivities" :key="status.agentId" class="activity-dock-item activity-dock-reply">
                                <div class="activity-dock-main">
                                    <span class="typing-dots" aria-hidden="true"><span /><span /><span /></span>
                                    <span class="activity-dock-primary">
                                        @{{ status.agentName }} {{ status.status === 'compressing' ? t('groupChat.agentCompressing') : t('groupChat.agentReplying') }}
                                    </span>
                                </div>
                                <button
                                    v-if="currentRoomCanManage"
                                    class="activity-dock-stop activity-dock-stop-reply"
                                    type="button"
                                    :disabled="isActivityAgentStopping(status.agentId)"
                                    @click="stopActivityReply(status.agentId)"
                                >
                                    {{ isActivityAgentStopping(status.agentId) ? t('groupChat.stoppingActivity') : t('groupChat.stopReply', { agent: status.agentName }) }}
                                </button>
                            </article>
                            <div v-if="!activityChains.length && !replyActivities.length && store.typingText" class="activity-dock-item typing-indicator">
                                <span class="typing-dots" aria-hidden="true"><span /><span /><span /></span>
                                {{ store.typingText }}
                            </div>
                        </div>
                    </section>
                    <GroupChatInput ref="groupChatInputRef" @send="handleSendMessage" @send-error="message.error" />
                </div>
                <aside
                    v-if="showWorkspacePanel && (activeWorkspacePanel === 'browser' ? desktopBrowserAvailable : (toolPanelStore.workspaceDiff || currentRoom?.workspace || filesStore.previewFile?.workspaceRoomId === store.currentRoomId))"
                    class="group-workspace-panel"
                    :style="workspacePanelStyle"
                >
                    <div class="group-workspace-resize-handle" @pointerdown="startWorkspaceResize" />
                    <div class="group-workspace-panel-inner">
                        <div
                            v-if="desktopBrowserAvailable && !toolPanelStore.workspaceDiff && !filesStore.previewFile"
                            class="group-workspace-panel-tabs"
                            role="tablist"
                        >
                            <button
                                type="button"
                                role="tab"
                                :class="{ active: activeWorkspacePanel === 'files' }"
                                :aria-selected="activeWorkspacePanel === 'files'"
                                @click="selectWorkspacePanel('files')"
                            >
                                {{ t('drawer.files') }}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                :class="{ active: activeWorkspacePanel === 'browser' }"
                                :aria-selected="activeWorkspacePanel === 'browser'"
                                @click="selectWorkspacePanel('browser')"
                            >
                                {{ t('browser.title') }}
                            </button>
                            <button class="group-workspace-panel-close" type="button" :title="t('files.closePreview')" @click="closeWorkspacePanel">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        <DesktopBrowserPanel
                            class="group-browser-panel"
                            v-if="desktopBrowserAvailable && activeWorkspacePanel === 'browser'"
                            @attach="handleBrowserAttachment"
                        />
                        <WorkspaceDiffPreview
                            v-else-if="toolPanelStore.workspaceDiff"
                            :custom-close="closeWorkspacePanel"
                        />
                        <FilePreview
                            v-else-if="filesStore.previewFile?.workspaceRoomId === store.currentRoomId"
                            :custom-close="closeWorkspacePanel"
                        />
                        <template v-else-if="currentRoom?.workspace">
                            <div v-if="!desktopBrowserAvailable" class="group-workspace-panel-header">
                                <span>{{ t('drawer.files') }}</span>
                                <button type="button" :title="t('files.closePreview')" @click="closeWorkspacePanel">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <line x1="18" y1="6" x2="6" y2="18" />
                                        <line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                </button>
                            </div>
                            <div class="group-workspace-panel-content">
                                <FilesPanel
                                    :workspace-room-id="store.currentRoomId"
                                    :workspace="currentRoom.workspace"
                                    @attach="handleWorkspaceFileAttach"
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

        <NPopover
            v-if="expandedParticipant"
            trigger="manual"
            placement="right-start"
            :show="true"
            :x="participantQuickX"
            :y="participantQuickY"
            :width="320"
            :show-arrow="true"
            :internal-trap-focus="true"
            content-class="participant-quick-popover-content"
            @update:show="handleParticipantQuickShowUpdate"
            @clickoutside="handleParticipantQuickClickOutside"
        >
            <div
                class="participant-quick-settings message-participant-quick-settings"
                role="dialog"
                :aria-label="`${t('groupChat.participantQuickSettings')}: ${expandedParticipant.name}`"
                @keydown.esc.stop.prevent="handleParticipantQuickEscape"
            >
                <div class="participant-quick-settings-title">{{ expandedParticipant.name }}</div>
                <p class="participant-quick-settings-hint">{{ t('groupChat.participantSettingsNextRun') }}</p>
                <div v-if="currentRoomCanManage && (expandedParticipant.mode || 'scoped') === 'scoped'" class="participant-quick-control">
                    <label>{{ t('groupChat.participantModel') }}</label>
                    <NSelect
                        :value="participantModelValue(expandedParticipant)"
                        :options="participantModelOptions(expandedParticipant)"
                        filterable
                        size="small"
                        @update:value="value => handleQuickModelChange(expandedParticipant, value as string | null)"
                    />
                </div>
                <div v-if="currentRoomCanManage && (expandedParticipant.mode || 'scoped') === 'scoped'" class="participant-quick-control">
                    <label>{{ t('groupChat.participantApiMode') }}</label>
                    <NSelect
                        :value="participantApiModeFor(expandedParticipant)"
                        :options="participantApiModeOptionsFor(expandedParticipant)"
                        size="small"
                        @update:value="value => handleQuickApiModeChange(expandedParticipant, value as string | null)"
                    />
                </div>
                <div
                    v-if="currentRoomCanManage && (expandedParticipant.mode || 'scoped') === 'scoped'"
                    class="participant-quick-control participant-reasoning-control"
                    :style="participantReasoningAccentStyle(expandedParticipant)"
                >
                    <label>{{ t('groupChat.participantReasoningEffort') }} · <strong>{{ participantReasoningLabel(expandedParticipant) }}</strong></label>
                    <NSlider
                        class="participant-reasoning-slider"
                        :class="{ 'participant-reasoning-slider--max': (expandedParticipant.reasoningEffort || '') === 'max' }"
                        :value="participantReasoningSliderValue(expandedParticipant)"
                        :min="0"
                        :max="participantReasoningOptions.length - 1"
                        :step="1"
                        :format-tooltip="participantReasoningSliderLabel"
                        @update:value="value => handleQuickReasoningChange(expandedParticipant, value)"
                        @dragend="commitParticipantReasoning(expandedParticipant)"
                    />
                    <div class="participant-reasoning-range" aria-hidden="true">
                        <span>{{ participantReasoningOptions[0].label }}</span>
                        <span>{{ participantReasoningOptions[participantReasoningOptions.length - 1].label }}</span>
                    </div>
                </div>
                <NButton type="primary" size="small" block class="participant-mention-button" :title="t('groupChat.mentionParticipant')" @click="mentionParticipant(expandedParticipant)">
                    @ {{ expandedParticipant.name }}
                </NButton>
            </div>
        </NPopover>

        <!-- Create room modal -->
        <Teleport to="body">
            <div v-if="showCreateModal" class="modal-backdrop" @click.self="showCreateModal = false">
                <div class="modal">
                    <h3>{{ t('groupChat.createRoom') }}</h3>
                    <CreateRoomForm @submit="handleCreateRoom" @cancel="showCreateModal = false" />
                </div>
            </div>
        </Teleport>

        <Teleport to="body">
            <div v-if="showAddAgentModal" class="modal-backdrop" @click.self="showAddAgentModal = false">
                <div class="modal">
                    <h3>{{ t('groupChat.addAgent') }}</h3>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.participantRuntime') }}</label>
                        <NSelect
                            :value="participantRuntimeValue()"
                            :options="participantRuntimeOptions"
                            @update:value="setParticipantRuntime"
                        />
                    </div>
                    <div class="form-group">
                        <NSelect
                            :value="selectedProfile"
                            :options="profileOptions"
                            :placeholder="t('groupChat.selectProfile')"
                            filterable
                            @update:value="setParticipantProfile"
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
                    <div class="form-group participant-avatar-field">
                        <label class="form-label">{{ t('groupChat.participantAvatar') }}</label>
                        <div class="participant-avatar-editor">
                            <ProfileAvatar :name="agentName || participantRuntimeValue()" :avatar="participantAvatar" :size="52" />
                            <input ref="participantAvatarInputRef" class="participant-avatar-file-input" type="file" accept="image/png,image/jpeg,image/webp" @change="handleParticipantAvatarFileChange">
                            <NSpace size="small" wrap>
                                <NButton size="small" @click="triggerParticipantAvatarUpload">{{ t('profiles.avatar.upload') }}</NButton>
                                <NButton size="small" @click="randomizeParticipantAvatar">{{ t('profiles.avatar.random') }}</NButton>
                                <NButton size="small" @click="resetParticipantAvatar">{{ t('profiles.avatar.reset') }}</NButton>
                            </NSpace>
                        </div>
                    </div>
                    <div v-if="participantMode === 'scoped'" class="form-group">
                        <label class="form-label">{{ t('groupChat.participantModel') }}</label>
                        <WorkflowModelSelector
                            :provider="participantProvider"
                            :model="participantModel"
                            :groups="participantModelGroups"
                            @select="handleParticipantModelSelect"
                        />
                    </div>
                    <div v-if="participantRuntime === 'coding_agent' && participantMode === 'scoped'" class="form-group">
                        <label class="form-label">{{ t('groupChat.participantApiMode') }}</label>
                        <NSelect v-model:value="participantApiMode" :options="participantApiModeOptions" />
                    </div>
                    <div v-if="participantMode === 'scoped'" class="form-group">
                        <label class="form-label">{{ t('groupChat.participantReasoningEffort') }}</label>
                        <NSelect v-model:value="participantReasoningEffort" :options="participantReasoningOptions" />
                    </div>
                    <div class="modal-actions">
                        <NSpace justify="end">
                            <NButton @click="showAddAgentModal = false">{{ t('common.cancel') }}</NButton>
                            <NButton type="primary" :disabled="!participantCanSubmit" @click="confirmAddAgent">{{ t('common.add') }}</NButton>
                        </NSpace>
                    </div>
                </div>
            </div>
            <div v-if="showEditAgentModal" class="modal-backdrop" @click.self="showEditAgentModal = false">
                <div class="modal">
                    <h3>{{ t('groupChat.editParticipant') }}</h3>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.participantRuntime') }}</label>
                        <NInput :value="participantRuntimeValue()" disabled />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.agentName') }}</label>
                        <NInput v-model:value="agentName" />
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.agentDesc') }}</label>
                        <NInput v-model:value="agentDescription" type="textarea" :rows="2" />
                    </div>
                    <div class="form-group participant-avatar-field">
                        <label class="form-label">{{ t('groupChat.participantAvatar') }}</label>
                        <div class="participant-avatar-editor">
                            <ProfileAvatar :name="agentName || participantRuntimeValue()" :avatar="participantAvatar" :size="52" />
                            <input ref="participantAvatarInputRef" class="participant-avatar-file-input" type="file" accept="image/png,image/jpeg,image/webp" @change="handleParticipantAvatarFileChange">
                            <NSpace size="small" wrap>
                                <NButton size="small" @click="triggerParticipantAvatarUpload">{{ t('profiles.avatar.upload') }}</NButton>
                                <NButton size="small" @click="randomizeParticipantAvatar">{{ t('profiles.avatar.random') }}</NButton>
                                <NButton size="small" @click="resetParticipantAvatar">{{ t('profiles.avatar.reset') }}</NButton>
                            </NSpace>
                        </div>
                    </div>
                    <div v-if="participantMode === 'scoped'" class="form-group">
                        <label class="form-label">{{ t('groupChat.participantModel') }}</label>
                        <WorkflowModelSelector
                            :provider="participantProvider"
                            :model="participantModel"
                            :groups="participantModelGroups"
                            @select="handleParticipantModelSelect"
                        />
                    </div>
                    <div v-if="participantRuntime === 'coding_agent' && participantMode === 'scoped'" class="form-group">
                        <label class="form-label">{{ t('groupChat.participantApiMode') }}</label>
                        <NSelect v-model:value="participantApiMode" :options="participantApiModeOptions" />
                    </div>
                    <div v-if="participantMode === 'scoped'" class="form-group">
                        <label class="form-label">{{ t('groupChat.participantReasoningEffortNextRun') }}</label>
                        <NSelect v-model:value="participantReasoningEffort" :options="participantReasoningOptions" />
                    </div>
                    <div class="modal-actions">
                        <NSpace justify="end">
                            <NButton @click="showEditAgentModal = false">{{ t('common.cancel') }}</NButton>
                            <NButton type="primary" :disabled="!agentName.trim() || !participantCanSubmit" @click="confirmEditAgent">{{ t('common.save') }}</NButton>
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
            <div v-if="showCompressionModal" class="modal-backdrop" @click.self="showCompressionModal = false">
                <div class="modal room-settings-modal">
                    <h3>{{ t('groupChat.roomSettings') }}</h3>
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
                                <NButton size="small" :disabled="!inviteCodeDraft.trim()" :title="t('groupChat.copyInviteCode')" @click="handleCopyInviteCode">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
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
                        <h4>{{ t('groupChat.automaticHandoffSettings') }}</h4>
                        <div class="form-group">
                            <label class="form-label">{{ t('groupChat.handoffMode') }}</label>
                            <NSelect v-model:value="handoffMode" :options="handoffModeOptions" />
                        </div>
                        <div v-if="handoffMode === 'fixed'" class="form-group">
                            <label class="form-label">{{ t('groupChat.fixedHandoffOrder') }}</label>
                            <NSelect
                                v-model:value="handoffOrder"
                                multiple
                                :options="handoffAgentOptions"
                            />
                            <div class="handoff-order-list">
                                <div v-for="(agentId, index) in handoffOrder" :key="agentId" class="handoff-order-item">
                                    <span>{{ index + 1 }}. {{ handoffAgentName(agentId) }}</span>
                                    <NSpace :size="4">
                                        <NButton size="tiny" :disabled="index === 0" :aria-label="t('groupChat.moveHandoffUp')" @click="moveHandoffAgent(agentId, -1)">↑</NButton>
                                        <NButton size="tiny" :disabled="index === handoffOrder.length - 1" :aria-label="t('groupChat.moveHandoffDown')" @click="moveHandoffAgent(agentId, 1)">↓</NButton>
                                    </NSpace>
                                </div>
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">{{ t('groupChat.maxAutomaticHandoffs') }}</label>
                            <NInputNumber
                                v-model:value="maxAgentMentionDepth"
                                :min="1"
                                :step="1"
                                :precision="0"
                                :disabled="unlimitedAgentMentionDepth"
                                style="width: 100%"
                            />
                            <NCheckbox v-model:checked="unlimitedAgentMentionDepth" style="margin-top: 10px">
                                {{ t('groupChat.unlimitedAutomaticHandoffs') }}
                            </NCheckbox>
                            <p class="form-hint">{{ t('groupChat.maxAutomaticHandoffsDesc') }}</p>
                        </div>
                    </section>
                    <section class="settings-section">
                        <h4>{{ t('groupChat.compressionSettings') }}</h4>
                        <div class="form-group">
                            <label class="form-label">{{ t('groupChat.triggerTokens') }}</label>
                            <NInputNumber v-model:value="compressionConfig.triggerTokens" :min="1000" :step="10000" style="width: 100%" />
                            <p class="form-hint">{{ t('groupChat.triggerTokensDesc') }}</p>
                        </div>
                        <div class="form-group">
                            <label class="form-label">{{ t('groupChat.maxHistoryTokens') }}</label>
                            <NInputNumber v-model:value="compressionConfig.maxHistoryTokens" :min="1000" :step="1000" style="width: 100%" />
                            <p class="form-hint">{{ t('groupChat.maxHistoryTokensDesc') }}</p>
                        </div>
                        <div class="form-group">
                            <label class="form-label">{{ t('groupChat.tailMessageCount') }}</label>
                            <NInputNumber v-model:value="compressionConfig.tailMessageCount" :min="1" :step="5" style="width: 100%" />
                            <p class="form-hint">{{ t('groupChat.tailMessageCountDesc') }}</p>
                        </div>
                    </section>
                    <div style="margin-top: 8px">
                        <NButton
                            block
                            :disabled="isCompressing || store.contextStatuses.size > 0"
                            :loading="isCompressing"
                            @click="handleForceCompress"
                        >
                            {{ isCompressing ? t('groupChat.compressingInProgress') : t('groupChat.compressNow') }}
                        </NButton>
                    </div>
                    <div class="modal-actions">
                        <NSpace justify="end">
                            <NButton @click="showCompressionModal = false">{{ t('common.cancel') }}</NButton>
                            <NButton type="primary" @click="handleSaveCompressionConfig">{{ t('groupChat.saveRoomSettings') }}</NButton>
                        </NSpace>
                    </div>
                </div>
            </div>
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
@use '@/styles/reasoning-effort' as reasoning-effort;

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

.activity-dock {
    flex-shrink: 0;
    margin: 0 16px 8px;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.18);
    border-radius: 12px;
    background: rgba(var(--accent-primary-rgb), 0.035);
    color: $text-secondary;
    overflow: hidden;

    .dark & {
        background: rgba(255, 255, 255, 0.035);
        border-color: rgba(255, 255, 255, 0.1);
    }
}

.activity-dock-live {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}

.activity-dock-items {
    display: grid;
}

.activity-dock-item {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 7px 9px;
    font-size: 12px;

    & + & {
        border-top: 1px solid rgba(var(--accent-primary-rgb), 0.1);
    }
}

.activity-dock-main {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    flex: 1;
}

.activity-dock-primary {
    flex: 0 0 auto;
    color: $text-primary;
    font-weight: 600;
}

.activity-dock-meta {
    flex: 0 0 auto;
    color: var(--accent-primary);
    font-variant-numeric: tabular-nums;
}

.activity-dock-agents {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.activity-dock-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
}

.activity-dock-progress-button,
.activity-dock-stop {
    min-height: 28px;
    border-radius: 7px;
    padding: 3px 8px;
    font: inherit;
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;

    &:focus-visible {
        outline: 2px solid var(--accent-primary);
        outline-offset: 2px;
    }

    &:disabled {
        cursor: wait;
        opacity: 0.6;
    }
}

.activity-dock-progress-button {
    border: 1px solid rgba(var(--accent-primary-rgb), 0.22);
    background: transparent;
    color: $text-secondary;

    &:hover:not(:disabled) {
        background: rgba(var(--accent-primary-rgb), 0.08);
        color: $text-primary;
    }
}

.activity-dock-stop {
    border: 1px solid rgba(var(--error-rgb), 0.24);
    background: rgba(var(--error-rgb), 0.06);
    color: $error;

    &:hover:not(:disabled) {
        color: #fff;
        background: $error;
        border-color: $error;
    }
}

.activity-dock-progress {
    grid-column: 1 / -1;
    width: 100%;
    margin: 0;
    padding: 5px 8px 3px 28px;
    color: $text-secondary;

    li {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 3px 0;
    }
}

.activity-dock-relay {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
}

@media (max-width: $breakpoint-mobile) {
    .activity-dock {
        margin: 0 8px 6px;
    }

    .activity-dock-item,
    .activity-dock-relay {
        align-items: stretch;
        grid-template-columns: 1fr;
        flex-direction: column;
    }

    .activity-dock-actions,
    .activity-dock-stop-reply {
        width: 100%;
    }

    .activity-dock-actions > button,
    .activity-dock-stop-reply {
        flex: 1;
    }

    .activity-dock-agents {
        white-space: normal;
        overflow-wrap: anywhere;
    }
}

@media (prefers-reduced-motion: reduce) {
    .activity-dock-progress-button,
    .activity-dock-stop {
        transition: none;
    }
}

.handoff-order-list {
    display: grid;
    gap: 6px;
    margin-top: 8px;
}

.handoff-order-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 8px;
    border: 1px solid $border-color;
    border-radius: 6px;
    color: $text-secondary;
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

.typing-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: $text-muted;
}

.typing-dots {
    display: inline-flex;
    align-items: center;
    gap: 2px;

    span {
        display: block;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background-color: $text-muted;
        animation: typing-bounce 1.2s infinite;

        &:nth-child(2) { animation-delay: 0.2s; }
        &:nth-child(3) { animation-delay: 0.4s; }
    }
}

@keyframes typing-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30% { transform: translateY(-3px); opacity: 1; }
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

.invite-join-form {
    flex-shrink: 0;
    display: grid;
    gap: 6px;
    padding: 0 12px 10px;
    border-bottom: 1px solid $border-color;
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

        &:disabled {
            cursor: not-allowed;
            opacity: 0.35;
        }

        &.leave {
            opacity: 0.72;
        }

        &.danger:hover {
            color: $error;
            background-color: rgba(var(--error-rgb), 0.1);
        }
    }

    &:hover .room-action-btn {
        opacity: 1;
    }

    &:hover .room-action-btn:disabled {
        opacity: 0.35;
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

.group-chat-surface {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background-color: $bg-main-surface;
    animation: group-chat-surface-fade-in 1.5s ease both;
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
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}

.group-workspace-panel-tabs {
    height: 47px;
    padding: 8px 12px;
    border-bottom: 1px solid $border-color;
    display: flex;
    align-items: center;
    gap: 4px;
    box-sizing: border-box;

    button {
        height: 30px;
        padding: 0 10px;
        border: 0;
        border-radius: $radius-sm;
        color: $text-secondary;
        background: transparent;
        cursor: pointer;

        &:hover,
        &.active {
            color: var(--accent-primary);
            background: rgba(var(--accent-primary-rgb), 0.1);
        }
    }

    .group-workspace-panel-close {
        width: 30px;
        padding: 0;
        margin-inline-start: auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }
}

.group-browser-panel {
    flex: 1;
    min-height: 0;
}

.group-workspace-panel-header {
    height: 47px;
    padding: 8px 12px;
    border-bottom: 1px solid $border-color;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    color: $text-primary;
    font-size: 13px;
    font-weight: 500;

    button {
        width: 28px;
        height: 28px;
        padding: 0;
        border: 0;
        border-radius: $radius-sm;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: $text-secondary;
        background: transparent;
        cursor: pointer;

        &:hover {
            color: $text-primary;
            background: rgba(var(--accent-primary-rgb), 0.08);
        }
    }
}

.group-workspace-panel-content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;

    > * {
        height: 100%;
        min-height: 0;
    }
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

    .avatar-stack-item,
    .avatar-stack-more {
        width: 24px;
        height: 24px;
    }

    .avatar-stack-item,
    .avatar-stack-more,
    .icon-btn {
        box-sizing: content-box;
    }

    .avatar-stack-item {
        margin-inline-start: -10px;
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
}

// ─── Header Avatar Stack ──────────────────────────────

.avatar-stack {
    cursor: pointer;
}

.avatar-stack-inner {
    display: flex;
    align-items: center;
}

.avatar-stack-trigger {
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;
    cursor: pointer;
    -webkit-app-region: no-drag;
}

.avatar-stack-item {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid $bg-card;
    margin-inline-start: -12px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: $bg-secondary;
    transition: transform $transition-fast;

    &:first-child {
        margin-inline-start: 0;
    }

    &:hover {
        transform: translateY(-2px);
        z-index: 100 !important;
    }
}

.avatar-stack-more {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid $bg-card;
    margin-inline-start: -12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: $bg-secondary;
    font-size: 11px;
    font-weight: 600;
    color: $text-secondary;
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

// ─── Participant quick settings ───────────────────────

.participant-quick-settings-row {
    padding: 2px 0;
    border-bottom: 1px solid rgba(var(--accent-primary-rgb), 0.08);

    &:last-child {
        border-bottom: 0;
    }
}

.participant-avatar-trigger {
    width: 32px;
    height: 32px;
    padding: 2px;
    border: 0;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: inherit;
    background: transparent;
    cursor: pointer;

    &:hover,
    &:focus-visible {
        outline: 2px solid rgba(var(--accent-primary-rgb), 0.45);
        outline-offset: 1px;
    }
}

.participant-quick-settings {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
    padding: 4px;
    background: transparent;
}

.participant-quick-settings-title {
    font-size: 14px;
    font-weight: 650;
    color: $text-primary;
}

.participant-mention-button {
    margin-top: 2px;
    font-weight: 600;
}

.participant-quick-settings-hint {
    margin: -2px 0 0;
    font-size: 11px;
    line-height: 1.5;
    color: $text-secondary;
}

.participant-quick-control {
    display: flex;
    flex-direction: column;
    gap: 6px;

    > label {
        font-size: 12px;
        font-weight: 500;
        color: $text-secondary;
    }
}

.participant-reasoning-control {
    padding: 2px 4px 0;

    > label strong {
        color: var(--reasoning-effort-accent-color);
        font-weight: 600;
    }
}

@include reasoning-effort.slider('.participant-reasoning-slider', '.participant-reasoning-slider--max');

.participant-reasoning-range {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    color: $text-muted;
    font-size: 10px;
}

// ─── Agent Popover ─────────────────────────────────────

.agent-popover {
    max-height: min(620px, calc(100vh - 96px));
    overflow-y: auto;
    overflow-x: hidden;
}

.agent-popover-title {
    font-size: 12px;
    font-weight: 600;
    color: $text-muted;
    padding: 0 0 8px;
    border-bottom: 1px solid $border-color;
    margin-bottom: 8px;
}

.agent-popover-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 4px;
    border-radius: $radius-sm;
    transition: background-color $transition-fast;

    &:hover {
        background-color: rgba(var(--accent-primary-rgb), 0.06);
    }

    .agent-popover-info {
        flex: 1;
        min-width: 0;
    }

    .agent-popover-name {
        display: block;
        font-size: 13px;
        color: $text-primary;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .agent-popover-profile {
        display: block;
        font-size: 11px;
        color: $text-muted;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .agent-popover-remove {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: none;
        border-radius: $radius-sm;
        color: $text-muted;
        cursor: pointer;
        flex-shrink: 0;
        transition: all $transition-fast;

        &:hover {
            color: $error;
            background-color: rgba(200, 50, 50, 0.08);
        }
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
    padding: 16px;
    box-sizing: border-box;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    overflow-y: auto;
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

.room-settings-modal {
    width: 480px;
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

.form-group {
    margin-bottom: 16px;
}

.form-label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: $text-secondary;
    margin-bottom: 6px;
}

.participant-avatar-editor {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
}

.participant-avatar-file-input {
    display: none;
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

    .header-sidebar-toggle {
        display: none;
    }

    .room-title-text {
        display: none;
    }

}
</style>
