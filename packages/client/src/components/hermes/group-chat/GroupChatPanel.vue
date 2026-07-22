<script setup lang="ts">
import { ref, computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useMessage, NInput, NButton, NSpace, NSelect, NPopover, NPopconfirm, NInputNumber, NDropdown, NModal, type DropdownOption } from 'naive-ui'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { updateRoomConfig, forceCompress } from '@/api/hermes/group-chat'
import GroupMessageList from './GroupMessageList.vue'
import GroupChatInput from './GroupChatInput.vue'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import SettingsCircuitBadge from '@/components/layout/SettingsCircuitBadge.vue'
import { copyToClipboard } from '@/utils/clipboard'
import type { Attachment } from '@/stores/hermes/chat'
import type { RoomAgent, RoomInfo } from '@/api/hermes/group-chat'
import { useFilesStore } from '@/stores/hermes/files'
import { useToolPanelStore } from '@/stores/hermes/tool-panel'

const FilesPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/FilesPanel.vue')).default)
const FilePreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/FilePreview.vue')).default)
const WorkspaceDiffPreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/WorkspaceDiffPreview.vue')).default)

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const store = useGroupChatStore()
const profilesStore = useProfilesStore()
const filesStore = useFilesStore()
const toolPanelStore = useToolPanelStore()

const showSidebar = ref(window.innerWidth > 768)
const showCreateModal = ref(false)
const showCloneModal = ref(false)
const showAddAgentModal = ref(false)
const showCompressionModal = ref(false)
const compressionConfig = ref({ triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10 })
const isCompressing = ref(false)
const inviteCodeDraft = ref('')
const isSavingInviteCode = ref(false)
const selectedProfile = ref<string | null>(null)
const agentName = ref('')
const agentDescription = ref('')
const cloneSourceRoomId = ref<string | null>(null)
const cloneRoomName = ref('')
const cloneInviteCode = ref('')
const contextRoomId = ref<string | null>(null)
const showRoomContextMenu = ref(false)
const roomContextMenuX = ref(0)
const roomContextMenuY = ref(0)
const groupChatInputRef = ref<(InstanceType<typeof GroupChatInput> & { addFiles?: (files: File[]) => void }) | null>(null)
const chatDropCounter = ref(0)
const isChatDropActive = ref(false)
const groupChatContentWrapperRef = ref<HTMLElement | null>(null)
const showWorkspacePanel = ref(false)
const workspacePanelMobile = ref(window.innerWidth <= 768)
const WORKSPACE_PANEL_MIN_WIDTH = 360
const WORKSPACE_PANEL_DEFAULT_WIDTH = 560
const WORKSPACE_PANEL_STORAGE_KEY = 'hermes.groupChat.workspacePanelWidth'
const workspacePanelWidth = ref(loadWorkspacePanelWidth())
const workspaceResizeStart = ref<{ x: number; width: number } | null>(null)
const workspacePanelStyle = computed(() => ({
    width: workspacePanelMobile.value ? '100%' : `${workspacePanelWidth.value}px`,
}))

const profileOptions = computed(() =>
    profilesStore.profiles.map(p => ({ label: p.name, value: p.name }))
)

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
const currentRoomCanManage = computed(() => canManageRoom(currentRoom.value))
const visibleApproval = computed(() => currentRoomCanManage.value ? store.activePendingApproval : null)
const currentWorkspaceLabel = computed(() => workspaceBasename(currentRoom.value?.workspace || ''))
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
        workspaceResizeStart.value.width + workspaceResizeStart.value.x - event.clientX,
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
    workspaceResizeStart.value = { x: event.clientX, width: workspacePanelWidth.value }
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
    if (showWorkspacePanel.value) closeWorkspacePanel()
    else showWorkspacePanel.value = true
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

async function handleCreateRoom(name: string, inviteCode: string, userName: string, description: string, compression: { triggerTokens: number; maxHistoryTokens: number; tailMessageCount: number }, workspace: string) {
    try {
        store.setUserInfo(userName, description)
        const res = await store.createNewRoom(name, inviteCode, undefined, compression, workspace)
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
    else message.error(t('common.copied') + ' ✗')
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

async function handleAddAgent() {
    if (!currentRoomCanManage.value) return
    await profilesStore.fetchProfiles()
    showAddAgentModal.value = true
}

onMounted(() => {
    window.addEventListener('hermes:open-page-sidebar', openPageSidebar)
    window.addEventListener('hermes:preview-workspace-file', handleWorkspaceFilePreviewRequest)
    window.addEventListener('resize', handleWorkspacePanelResize)
    handleWorkspacePanelResize()
    if (profilesStore.profiles.length === 0) {
        void profilesStore.fetchProfiles()
    }
})

onUnmounted(() => {
    window.removeEventListener('hermes:open-page-sidebar', openPageSidebar)
    window.removeEventListener('hermes:preview-workspace-file', handleWorkspaceFilePreviewRequest)
    window.removeEventListener('resize', handleWorkspacePanelResize)
    stopWorkspaceResize()
    if (showWorkspacePanel.value) closeWorkspacePanel()
    else toolPanelStore.closeWorkspaceDiff()
})

watch(() => store.currentRoomId, (roomId, previousRoomId) => {
    if (roomId !== previousRoomId && (filesStore.previewFile || toolPanelStore.workspaceDiff || showWorkspacePanel.value)) closeWorkspacePanel()
})

watch(() => filesStore.previewFile, previewFile => {
    if (previewFile?.workspaceRoomId === store.currentRoomId) showWorkspacePanel.value = true
})

watch(() => toolPanelStore.workspaceDiff, workspaceDiff => {
    if (workspaceDiff) showWorkspacePanel.value = true
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
        })
        showAddAgentModal.value = false
        selectedProfile.value = null
        agentName.value = ''
        agentDescription.value = ''
        message.success(t('groupChat.agentAdded'))
    } catch (err: any) {
        if (err.message?.includes('already')) {
            message.warning(t('groupChat.agentAlreadyInRoom'))
        } else {
            message.error(extractApiErrorMessage(err))
        }
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
    }
    showCompressionModal.value = true
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

async function handleSaveCompressionConfig() {
    if (!store.currentRoomId) return
    if (!currentRoomCanManage.value) return
    try {
        const res = await updateRoomConfig(store.currentRoomId, { ...compressionConfig.value })
        const idx = store.rooms.findIndex(r => r.id === store.currentRoomId)
        if (idx >= 0 && res.room) store.rooms[idx] = res.room
        showCompressionModal.value = false
        message.success(t('groupChat.compressionSaved'))
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
                    <NPopover v-if="store.agents.length" trigger="click" placement="bottom-end" :width="220">
                        <template #trigger>
                            <div class="avatar-stack-inner">
                                <!-- User avatar first -->
                                <span class="avatar-stack-item" :style="{ zIndex: store.agents.length + 1 }">
                                    <ProfileAvatar class="agent-avatar" :name="store.userName || store.userId" :avatar="userMemberAvatar" :size="24" />
                                </span>
                                <span
                                    v-for="(agent, index) in store.agents.slice(-4)"
                                    :key="agent.id"
                                    class="avatar-stack-item"
                                    :style="{ zIndex: store.agents.length - index }"
                                >
                                    <ProfileAvatar class="agent-avatar" :name="agentAvatarName(agent)" :avatar="profileAvatarFor(agent.profile)" :size="24" />
                                </span>
                                <span v-if="store.agents.length > 4" class="avatar-stack-more">+{{ store.agents.length - 4 }}</span>
                            </div>
                        </template>
                        <div class="agent-popover">
                            <div class="agent-popover-item" style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--n-border-color, #efeff5);">
                                <ProfileAvatar class="agent-avatar" :name="store.userName || store.userId" :avatar="userMemberAvatar" :size="28" />
                                <div class="agent-popover-info">
                                    <span class="agent-popover-name">{{ store.userName || 'You' }}</span>
                                    <span class="agent-popover-profile">{{ t('groupChat.you') }}</span>
                                </div>
                            </div>
                            <div class="agent-popover-title">{{ t('groupChat.agents') }} ({{ store.agents.length }})</div>
                            <div v-for="agent in store.agents" :key="agent.id" class="agent-popover-item">
                                <ProfileAvatar class="agent-avatar" :name="agentAvatarName(agent)" :avatar="profileAvatarFor(agent.profile)" :size="28" />
                                <div class="agent-popover-info">
                                    <span class="agent-popover-name">{{ agent.name }}</span>
                                    <span class="agent-popover-profile">{{ agent.profile }}</span>
                                </div>
                                <button v-if="currentRoomCanManage" class="agent-popover-remove" @click="handleRemoveAgent(agent.id)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                </button>
                            </div>
                        </div>
                    </NPopover>
                    <!-- Only user avatar, no agents -->
                    <div v-else-if="store.userName" class="avatar-stack-inner">
                        <span class="avatar-stack-item">
                            <ProfileAvatar class="agent-avatar" :name="store.userName || store.userId" :avatar="userMemberAvatar" :size="24" />
                        </span>
                    </div>
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
                        <GroupMessageList />
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
                    <div v-if="store.contextStatuses.size > 0 || (store.typingText && store.contextStatuses.size === 0)" class="status-bar">
                        <div v-if="store.contextStatuses.size > 0" class="context-status-list">
                            <div v-for="[name, status] in store.contextStatuses" :key="name" class="context-status">
                                <span class="typing-dots">
                                    <span /><span /><span />
                                </span>
                                <span v-if="status.status === 'compressing'">
                                    @{{ status.agentName }} {{ t('groupChat.agentCompressing') }}
                                </span>
                                <span v-else>
                                    @{{ status.agentName }} {{ t('groupChat.agentReplying') }}
                                </span>
                                <button v-if="currentRoomCanManage" class="context-stop-btn" :title="t('common.cancel')" @click="handleInterruptAgent(status.agentName)">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                        <line x1="18" y1="6" x2="6" y2="18" />
                                        <line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div v-else-if="store.typingText" class="typing-indicator">
                            <span class="typing-dots">
                                <span /><span /><span />
                            </span>
                            {{ store.typingText }}
                        </div>
                    </div>
                    <GroupChatInput ref="groupChatInputRef" @send="handleSendMessage" />
                </div>
                <aside
                    v-if="showWorkspacePanel && (toolPanelStore.workspaceDiff || currentRoom?.workspace || filesStore.previewFile?.workspaceRoomId === store.currentRoomId)"
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
                        <template v-else-if="currentRoom?.workspace">
                            <div class="group-workspace-panel-header">
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
                        <NSelect
                            v-model:value="selectedProfile"
                            :options="profileOptions"
                            :placeholder="t('groupChat.selectProfile')"
                            filterable
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
                    <div class="modal-actions">
                        <NSpace justify="end">
                            <NButton @click="showAddAgentModal = false">{{ t('common.cancel') }}</NButton>
                            <NButton type="primary" :disabled="!selectedProfile" @click="confirmAddAgent">{{ t('common.add') }}</NButton>
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
                            <NButton type="primary" @click="handleSaveCompressionConfig">{{ t('groupChat.saveCompression') }}</NButton>
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

// ─── Status Bar ──────────────────────────────────────────

.status-bar {
    flex-shrink: 0;
    padding: 6px 20px;
    overflow: hidden;
}

.context-status-list {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    flex-wrap: nowrap;

    &::-webkit-scrollbar {
        height: 0;
    }
}

.context-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: 12px;
    color: $text-secondary;
    background-color: $bg-card-hover;
    border-radius: $radius-sm;

    .dark & {
        background-color: rgba(255, 255, 255, 0.06);
    }
}

.context-stop-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: 1px solid rgba(var(--error-rgb), 0.18);
    border-radius: $radius-sm;
    background: rgba(var(--error-rgb), 0.06);
    color: $error;
    cursor: pointer;
    padding: 0;
    transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;

    &:hover {
        color: #ffffff;
        background: $error;
        border-color: $error;
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
        margin-left: 10px;
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
    border-left: 1px solid $border-color;
}

.group-workspace-resize-handle {
    position: absolute;
    left: -7px;
    top: 0;
    bottom: 0;
    width: 14px;
    cursor: col-resize;
    z-index: 20;

    &::after {
        content: '';
        position: absolute;
        left: 6px;
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
        left: 1px;
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
        border-left: none;
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
        margin-left: -10px;
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

.avatar-stack-item {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid $bg-card;
    margin-left: -12px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: $bg-secondary;
    transition: transform $transition-fast;

    &:first-child {
        margin-left: 0;
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
    margin-left: -12px;
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

// ─── Agent Popover ─────────────────────────────────────

.agent-popover {
    max-height: 300px;
    overflow-y: auto;
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
