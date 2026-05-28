import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getApiKey } from '@/api/client'
import { getDownloadUrl } from '@/api/hermes/download'
import type { Attachment, ContentBlock } from './chat'
import {
    connectGroupChat,
    disconnectGroupChat,
    getSocket,
    getStoredUserId,
    getStoredUserName,
    type RoomInfo,
    type RoomAgent,
    type ChatMessage,
    type MemberInfo,
    createRoom,
    listRooms,
    getRoomDetail,
    joinRoomByCode,
    addAgent,
    listAgents,
    removeAgent,
    cloneRoom as cloneRoomApi,
    deleteRoom as deleteRoomApi,
    clearRoomContext,
} from '@/api/hermes/group-chat'

async function uploadGroupFiles(attachments: Attachment[]): Promise<{ name: string; path: string }[]> {
    const formData = new FormData()
    for (const att of attachments) {
        if (att.file) formData.append('file', att.file, att.name)
    }
    const token = getApiKey()
    const res = await fetch('/upload', {
        method: 'POST',
        body: formData,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    const data = await res.json() as { files: { name: string; path: string }[] }
    return data.files
}

function buildGroupContentBlocks(content: string, attachments: Attachment[], files: { name: string; path: string }[]): ContentBlock[] {
    const blocks: ContentBlock[] = []
    if (content.trim()) blocks.push({ type: 'text', text: content.trim() })
    for (let i = 0; i < files.length; i += 1) {
        const file = files[i]
        const attachment = attachments[i]
        if (attachment?.type.startsWith('image/')) {
            blocks.push({
                type: 'image',
                name: file.name,
                path: file.path,
                media_type: attachment.type,
            })
        } else {
            blocks.push({
                type: 'file',
                name: file.name,
                path: file.path,
                media_type: attachment?.type,
            })
        }
    }
    return blocks
}

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

const STREAM_FINAL_CONTENT_RECOVERY_DELAY_MS = 300

function normalizeLocalFilePath(path: string): string {
    return /^[a-zA-Z]:\\/.test(path) ? path.replace(/\\/g, '/') : path
}

function hasText(value?: string | null): boolean {
    return !!value?.trim()
}

function hasToolCalls(message: ChatMessage): boolean {
    return !!message.tool_calls?.length
}

function needsFinalContentRecovery(message: ChatMessage): boolean {
    return message.role === 'assistant' && !hasText(message.content) && hasText(message.reasoning) && !hasToolCalls(message)
}

function mergeFinalMessage(existing: ChatMessage | null, msg: ChatMessage): ChatMessage {
    return {
        ...msg,
        content: hasText(msg.content) ? msg.content : existing?.content || msg.content || '',
        reasoning: hasText(msg.reasoning) ? msg.reasoning : existing?.reasoning ?? msg.reasoning ?? null,
        reasoning_content: hasText(msg.reasoning_content) ? msg.reasoning_content : existing?.reasoning_content ?? msg.reasoning_content ?? null,
        isStreaming: false,
        attachments: existing?.attachments || msg.attachments,
    }
}

export interface GroupPendingApproval {
    roomId: string
    agentName: string
    approvalId: string
    command: string
    description: string
    choices: Array<'once' | 'session' | 'always' | 'deny'>
    allowPermanent: boolean
    requestedAt: number
}

export const useGroupChatStore = defineStore('groupChat', () => {
    // ─── State ─────────────────────────────────────────────
    const connected = ref(false)
    const currentRoomId = ref<string | null>(null)
    const rooms = ref<RoomInfo[]>([])
    const messages = ref<ChatMessage[]>([])
    const members = ref<MemberInfo[]>([])
    const agents = ref<RoomAgent[]>([])
    const roomName = ref('')
    const isJoining = ref(false)
    const error = ref<string | null>(null)
    const typingUsers = ref<Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>>(new Map())
    const contextStatuses = ref<Map<string, { agentName: string; status: string }>>(new Map())
    const autoPlaySpeechEnabled = ref(false)
    const pendingApprovals = ref<Map<string, GroupPendingApproval>>(new Map())
    const totalMessages = ref(0)
    const loadedMessageCount = ref(0)
    const hasMoreBefore = ref(false)
    const isLoadingOlderMessages = ref(false)

    function resetMessagePaging() {
        totalMessages.value = 0
        loadedMessageCount.value = 0
        hasMoreBefore.value = false
        isLoadingOlderMessages.value = false
    }

    function applyMessagePaging(res: { messages: ChatMessage[]; total?: number; hasMore?: boolean }) {
        loadedMessageCount.value = res.messages.length
        totalMessages.value = res.total ?? res.messages.length
        hasMoreBefore.value = res.hasMore ?? loadedMessageCount.value < totalMessages.value
    }

    function setAutoPlaySpeech(enabled: boolean) {
        autoPlaySpeechEnabled.value = enabled
    }

    function playMessageSpeech(messageId: string, content: string) {
        window.dispatchEvent(new CustomEvent('auto-play-speech', {
            detail: { messageId, content },
        }))
    }

    async function recoverMissingFinalContent(roomId: string, messageId: string) {
        if (currentRoomId.value !== roomId) return
        const idx = messages.value.findIndex(m => m.id === messageId)
        if (idx < 0 || !needsFinalContentRecovery(messages.value[idx])) return

        try {
            const res = await getRoomDetail(roomId)
            const recovered = res.messages.find(m => m.id === messageId)
            if (!recovered || !hasText(recovered.content)) return

            const currentIdx = messages.value.findIndex(m => m.id === messageId)
            if (currentIdx < 0 || !needsFinalContentRecovery(messages.value[currentIdx])) return
            messages.value[currentIdx] = mergeFinalMessage(messages.value[currentIdx], recovered)
            messages.value = [...messages.value]
        } catch {
            // Keep the reasoning-only bubble visible; a later final message event can still merge it.
        }
    }

    function scheduleMissingFinalContentRecovery(roomId: string, messageId: string) {
        setTimeout(() => {
            void recoverMissingFinalContent(roomId, messageId)
        }, STREAM_FINAL_CONTENT_RECOVERY_DELAY_MS)
    }

    // Computed: returns first active status for backward compat
    const contextStatus = computed(() => {
        for (const [, status] of contextStatuses.value) {
            return status
        }
        return null
    })
    const activePendingApproval = computed(() => {
        if (!currentRoomId.value) return null
        for (const approval of pendingApprovals.value.values()) {
            if (approval.roomId === currentRoomId.value) return approval
        }
        return null
    })
    const userId = ref(getStoredUserId())
    const userName = ref(getStoredUserName() || '')

    // ─── Computed ───────────────────────────────────────────
    const sortedMessages = computed(() => mapGroupMessages([...messages.value].sort((a, b) => a.timestamp - b.timestamp)))

    const memberNames = computed(() => {
        return members.value.map(m => m.name)
    })

    const typingNames = computed(() => {
        return Array.from(typingUsers.value.values()).map(u => u.name)
    })

    const typingText = computed(() => {
        const names = typingNames.value
        if (names.length === 0) return ''
        if (names.length === 1) return `${names[0]} is typing...`
        if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`
        return `${names[0]} and ${names.length - 1} others are typing...`
    })

    // ─── Connection ────────────────────────────────────────
    function connect() {
        const socket = connectGroupChat({
            userId: userId.value,
            userName: userName.value || undefined,
        })
        console.log('[GroupChat] connecting...', { userId: userId.value, userName: userName.value })

        socket.on('connect', () => {
            console.log('[GroupChat] connected, socket id:', socket.id)
            connected.value = true
            error.value = null
        })

        socket.on('disconnect', (reason) => {
            console.log('[GroupChat] disconnected:', reason)
            connected.value = false
        })

        socket.on('connect_error', (err: Error) => {
            console.error('[GroupChat] connect_error:', err.message)
            error.value = err.message
            connected.value = false
        })

        socket.on('message', (msg: ChatMessage) => {
            if (msg.roomId === currentRoomId.value) {
                const idx = messages.value.findIndex(m => m.id === msg.id)
                const existing = idx >= 0 ? messages.value[idx] : null
                const resolvedMsg = mergeFinalMessage(existing, msg)
                if (idx >= 0) {
                    messages.value[idx] = resolvedMsg
                    messages.value = [...messages.value]
                } else {
                    messages.value.push(resolvedMsg)
                    loadedMessageCount.value += 1
                    totalMessages.value = Math.max(totalMessages.value + 1, loadedMessageCount.value)
                }
                if (autoPlaySpeechEnabled.value && resolvedMsg.role === 'assistant' && resolvedMsg.content?.trim()) {
                    setTimeout(() => playMessageSpeech(resolvedMsg.id, resolvedMsg.content), 300)
                }
            }
        })

        socket.on('message_stream_start', (msg: ChatMessage) => {
            if (msg.roomId !== currentRoomId.value) return
            messages.value = messages.value.filter(m => !(
                m.roomId === msg.roomId &&
                m.senderId === msg.senderId &&
                m.id !== msg.id &&
                m.isStreaming &&
                !m.content?.trim() &&
                !m.reasoning?.trim() &&
                !m.tool_calls?.length
            ))
            msg.isStreaming = true
            const idx = messages.value.findIndex(m => m.id === msg.id)
            if (idx >= 0) {
                const existing = messages.value[idx]
                if (!existing.isStreaming) return
                messages.value[idx] = {
                    ...existing,
                    ...msg,
                    content: hasText(msg.content) ? msg.content : existing.content || '',
                    reasoning: hasText(msg.reasoning) ? msg.reasoning : existing.reasoning,
                    reasoning_content: hasText(msg.reasoning_content) ? msg.reasoning_content : existing.reasoning_content,
                    isStreaming: true,
                }
                messages.value = [...messages.value]
            } else {
                messages.value.push(msg)
                loadedMessageCount.value += 1
                totalMessages.value = Math.max(totalMessages.value + 1, loadedMessageCount.value)
            }
        })

        socket.on('message_stream_delta', (data: { roomId: string; id: string; delta: string }) => {
            if (data.roomId !== currentRoomId.value) return
            const idx = messages.value.findIndex(m => m.id === data.id)
            if (idx < 0 || !messages.value[idx].isStreaming) return
            messages.value[idx] = {
                ...messages.value[idx],
                content: messages.value[idx].content + data.delta,
            }
            messages.value = [...messages.value]
        })

        socket.on('message_reasoning_delta', (data: { roomId: string; id: string; delta: string }) => {
            if (data.roomId !== currentRoomId.value) return
            const idx = messages.value.findIndex(m => m.id === data.id)
            if (idx < 0 || !messages.value[idx].isStreaming) return
            messages.value[idx] = {
                ...messages.value[idx],
                reasoning: (messages.value[idx].reasoning || '') + data.delta,
                reasoning_content: (messages.value[idx].reasoning_content || '') + data.delta,
                isStreaming: true,
            }
            messages.value = [...messages.value]
        })

        socket.on('message_stream_end', (data: { roomId: string; id: string }) => {
            if (data.roomId !== currentRoomId.value) return
            const idx = messages.value.findIndex(m => m.id === data.id)
            if (
                idx >= 0 &&
                !messages.value[idx].content?.trim() &&
                !messages.value[idx].reasoning?.trim() &&
                !messages.value[idx].tool_calls?.length
            ) {
                messages.value.splice(idx, 1)
            } else if (idx >= 0) {
                messages.value[idx] = {
                    ...messages.value[idx],
                    isStreaming: false,
                }
                messages.value = [...messages.value]
                if (needsFinalContentRecovery(messages.value[idx])) {
                    scheduleMissingFinalContentRecovery(data.roomId, data.id)
                }
            }
        })

        socket.on('member_joined', (data: { roomId: string; members: MemberInfo[] }) => {
            if (data.roomId === currentRoomId.value) {
                members.value = data.members
            }
        })

        socket.on('member_left', (data: { roomId: string; members: MemberInfo[] }) => {
            if (data.roomId === currentRoomId.value) {
                members.value = data.members
            }
        })

        socket.on('typing', (data: { roomId: string; userId: string; userName: string }) => {
            if (data.roomId === currentRoomId.value && !typingUsers.value.has(data.userId)) {
                const timer = setTimeout(() => typingUsers.value.delete(data.userId), 5000)
                typingUsers.value.set(data.userId, { name: data.userName, timer })
            }
        })

        socket.on('stop_typing', (data: { roomId: string; userId: string }) => {
            if (data.roomId === currentRoomId.value && typingUsers.value.has(data.userId)) {
                const entry = typingUsers.value.get(data.userId)!
                clearTimeout(entry.timer)
                typingUsers.value.delete(data.userId)
            }
        })

        socket.on('context_status', (data: { roomId: string; agentName: string; status: string }) => {
            if (data.roomId === currentRoomId.value) {
                if (data.status === 'ready') {
                    contextStatuses.value.delete(data.agentName)
                    messages.value = messages.value
                        .map(m => (
                            m.senderName === data.agentName && m.isStreaming
                                ? { ...m, isStreaming: false }
                                : m
                        ))
                        .filter(m => !(
                            m.senderName === data.agentName &&
                            !m.content?.trim() &&
                            !m.reasoning?.trim() &&
                            !m.tool_calls?.length
                        ))
                } else {
                    contextStatuses.value.set(data.agentName, { agentName: data.agentName, status: data.status })
                }
                // Trigger reactivity
                contextStatuses.value = new Map(contextStatuses.value)
            }
        })

        socket.on('approval.requested', (data: { roomId: string; agentName?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean }) => {
            if (!data.approval_id) return
            const choices = (Array.isArray(data.choices) ? data.choices : ['once', 'session', 'deny'])
                .filter((choice): choice is GroupPendingApproval['choices'][number] =>
                    choice === 'once' || choice === 'session' || choice === 'always' || choice === 'deny')
            pendingApprovals.value.set(data.approval_id, {
                roomId: data.roomId,
                agentName: data.agentName || '',
                approvalId: data.approval_id,
                command: data.command || '',
                description: data.description || '',
                choices: choices.length ? choices : ['once', 'session', 'deny'],
                allowPermanent: Boolean(data.allow_permanent),
                requestedAt: Date.now(),
            })
            pendingApprovals.value = new Map(pendingApprovals.value)
        })

        socket.on('approval.resolved', (data: { approval_id?: string }) => {
            if (!data.approval_id) return
            pendingApprovals.value.delete(data.approval_id)
            pendingApprovals.value = new Map(pendingApprovals.value)
        })

        socket.on('room_updated', (data: { roomId: string; totalTokens: number }) => {
            const room = rooms.value.find(r => r.id === data.roomId)
            if (room) room.totalTokens = data.totalTokens
        })

        socket.on('room_cleared', (data: { roomId: string; totalTokens: number }) => {
            const room = rooms.value.find(r => r.id === data.roomId)
            if (room) room.totalTokens = data.totalTokens
            if (data.roomId === currentRoomId.value) {
                messages.value = []
                resetMessagePaging()
                typingUsers.value.clear()
                contextStatuses.value.clear()
                pendingApprovals.value.clear()
            }
        })
    }

    function disconnect() {
        disconnectGroupChat()
        connected.value = false
        currentRoomId.value = null
        messages.value = []
        resetMessagePaging()
        members.value = []
        agents.value = []
        roomName.value = ''
        typingUsers.value.clear()
        contextStatuses.value.clear()
        pendingApprovals.value.clear()
    }

    function setUserInfo(name: string, description: string) {
        userName.value = name
        localStorage.setItem('gc_user_name', name)
        localStorage.setItem('gc_user_description', description)
    }

    // ─── Room Actions ──────────────────────────────────────
    async function joinRoom(roomId: string) {
        isJoining.value = true
        error.value = null

        try {
            const res = await getRoomDetail(roomId)
            currentRoomId.value = res.room.id
            roomName.value = res.room.name
            messages.value = res.messages
            applyMessagePaging(res)
            agents.value = res.agents
            members.value = res.members || []
        } catch (err: any) {
            error.value = err.message
            throw err
        } finally {
            isJoining.value = false
        }

        // Join via socket for real-time updates
        const socket = getSocket()
        if (socket) {
            await new Promise<void>((resolve) => {
                socket.emit('join', {
                    roomId,
                    name: userName.value || undefined,
                    description: localStorage.getItem('gc_user_description') || undefined,
                }, (res: any) => {
                    if (!res?.error) {
                        members.value = res.members || []
                        if (res.agents) agents.value = res.agents

                        // Restore typing state from server
                        if (res.typingUsers) {
                            for (const u of res.typingUsers) {
                                if (!typingUsers.value.has(u.userId)) {
                                    const timer = setTimeout(() => typingUsers.value.delete(u.userId), 5000)
                                    typingUsers.value.set(u.userId, { name: u.userName, timer })
                                }
                            }
                        }

                        // Restore context statuses from server
                        if (res.contextStatuses) {
                            contextStatuses.value = new Map(
                                res.contextStatuses.map((s: any) => [s.agentName, s])
                            )
                        }
                    }
                    resolve()
                })
            })
        }
    }

    async function loadOlderMessages(): Promise<boolean> {
        const roomId = currentRoomId.value
        if (!roomId || isLoadingOlderMessages.value || !hasMoreBefore.value) return false
        const offset = loadedMessageCount.value
        isLoadingOlderMessages.value = true
        try {
            const res = await getRoomDetail(roomId, { offset, limit: 300 })
            const existingIds = new Set(messages.value.map(message => message.id))
            const olderMessages = res.messages.filter(message => !existingIds.has(message.id))
            messages.value = [...olderMessages, ...messages.value]
            loadedMessageCount.value = offset + res.messages.length
            totalMessages.value = res.total ?? totalMessages.value
            hasMoreBefore.value = res.hasMore ?? loadedMessageCount.value < totalMessages.value
            return olderMessages.length > 0
        } catch (err: any) {
            error.value = err.message
            return false
        } finally {
            isLoadingOlderMessages.value = false
        }
    }

    async function sendMessage(content: string, attachments?: Attachment[]) {
        const socket = getSocket()
        if (!socket || !currentRoomId.value) return
        emitStopTyping()
        const messageId = uid()
        let finalContent: string | ContentBlock[] = content.trim()
        if (attachments?.length) {
            const uploaded = await uploadGroupFiles(attachments)
            finalContent = buildGroupContentBlocks(content, attachments, uploaded)
            const urlMap = new Map(uploaded.map(f => {
                return [f.name, getDownloadUrl(normalizeLocalFilePath(f.path), f.name)]
            }))
            messages.value.push({
                id: messageId,
                roomId: currentRoomId.value,
                senderId: userId.value,
                senderName: userName.value || 'You',
                content: JSON.stringify(finalContent),
                timestamp: Date.now(),
                role: 'user',
                attachments: attachments.map(att => ({ ...att, url: urlMap.get(att.name) || att.url, file: undefined })),
            })
            loadedMessageCount.value += 1
            totalMessages.value = Math.max(totalMessages.value + 1, loadedMessageCount.value)
        }

        return new Promise<void>((resolve, reject) => {
            socket!.emit('message', { roomId: currentRoomId.value, id: messageId, content: finalContent }, (res: { id?: string; error?: string }) => {
                if (res.error) {
                    messages.value = messages.value.filter(m => m.id !== messageId)
                    reject(new Error(res.error))
                    return
                }
                resolve()
            })
        })
    }

    async function loadRooms() {
        try {
            const res = await listRooms()
            rooms.value = res.rooms
        } catch (err: any) {
            error.value = err.message
        }
    }

    async function createNewRoom(name: string, inviteCode: string, agentList?: { profile: string; name?: string; description?: string; invited?: boolean }[], compression?: { triggerTokens: number; maxHistoryTokens: number; tailMessageCount: number }) {
        try {
            const res = await createRoom({
                name,
                inviteCode,
                agents: agentList,
                compression: compression || { triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10 },
            })
            rooms.value.push(res.room)
            return res
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function joinByCode(code: string) {
        try {
            const res = await joinRoomByCode(code)
            await joinRoom(res.room.id)
            return res.room
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function deleteRoom(roomId: string) {
        try {
            await deleteRoomApi(roomId)
            rooms.value = rooms.value.filter(r => r.id !== roomId)
            if (currentRoomId.value === roomId) {
                currentRoomId.value = null
                messages.value = []
                resetMessagePaging()
                members.value = []
                agents.value = []
                roomName.value = ''
            }
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function cloneRoom(roomId: string, data?: { name?: string; inviteCode?: string }) {
        try {
            const res = await cloneRoomApi(roomId, data)
            rooms.value.push(res.room)
            return res
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function clearCurrentRoomContext() {
        if (!currentRoomId.value) return
        try {
            const res = await clearRoomContext(currentRoomId.value)
            messages.value = []
            resetMessagePaging()
            typingUsers.value.clear()
            contextStatuses.value.clear()
            const idx = rooms.value.findIndex(r => r.id === currentRoomId.value)
            if (idx >= 0 && res.room) rooms.value[idx] = res.room
            return res
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Agent Actions ─────────────────────────────────────
    async function loadAgents(roomId: string) {
        try {
            const res = await listAgents(roomId)
            agents.value = res.agents
        } catch { /* ignore */ }
    }

    async function addAgentToRoom(roomId: string, data: { profile: string; name?: string; description?: string; invited?: boolean }) {
        try {
            const res = await addAgent(roomId, data)
            agents.value.push(res.agent)
            return res.agent
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function removeAgentFromRoom(roomId: string, agentId: string) {
        try {
            const res = await removeAgent(roomId, agentId)
            agents.value = res.agents ?? agents.value.filter(a => a.id !== agentId && a.agentId !== agentId)
            if (res.members) members.value = res.members
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Typing ────────────────────────────────────────────
    let _typingTimer: ReturnType<typeof setTimeout> | null = null

    function emitTyping() {
        const socket = getSocket()
        if (!socket || !currentRoomId.value) return
        socket.emit('typing', { roomId: currentRoomId.value })
        if (_typingTimer) clearTimeout(_typingTimer)
        _typingTimer = setTimeout(() => emitStopTyping(), 4000)
    }

    function emitStopTyping() {
        const socket = getSocket()
        if (!socket || !currentRoomId.value) return
        socket.emit('stop_typing', { roomId: currentRoomId.value })
        if (_typingTimer) { clearTimeout(_typingTimer); _typingTimer = null }
    }

    async function interruptAgent(agentName: string) {
        const socket = getSocket()
        if (!socket || !currentRoomId.value) return
        await new Promise<void>((resolve, reject) => {
            socket.emit('interrupt_agent', { roomId: currentRoomId.value, agentName }, (res: any) => {
                if (res?.error) reject(new Error(res.error))
                else resolve()
            })
        })
    }

    async function respondApproval(choice: GroupPendingApproval['choices'][number]) {
        const socket = getSocket()
        const pending = activePendingApproval.value
        if (!socket || !pending) return
        await new Promise<void>((resolve, reject) => {
            socket.emit('approval.respond', {
                roomId: pending.roomId,
                approval_id: pending.approvalId,
                choice,
            }, (res: any) => {
                if (res?.error) reject(new Error(res.error))
                else resolve()
            })
        })
        pendingApprovals.value.delete(pending.approvalId)
        pendingApprovals.value = new Map(pendingApprovals.value)
    }

    return {
        // State
        connected,
        currentRoomId,
        rooms,
        messages,
        members,
        agents,
        roomName,
        isJoining,
        error,
        contextStatus,
        contextStatuses,
        pendingApprovals,
        activePendingApproval,
        autoPlaySpeechEnabled,
        totalMessages,
        loadedMessageCount,
        hasMoreBefore,
        isLoadingOlderMessages,
        userId,
        userName,
        // Computed
        sortedMessages,
        memberNames,
        typingNames,
        typingText,
        // Actions
        connect,
        disconnect,
        setUserInfo,
        setAutoPlaySpeech,
        joinRoom,
        loadOlderMessages,
        sendMessage,
        loadRooms,
        emitTyping,
        emitStopTyping,
        interruptAgent,
        respondApproval,
        createNewRoom,
        joinByCode,
        deleteRoom,
        cloneRoom,
        clearCurrentRoomContext,
        loadAgents,
        addAgentToRoom,
        removeAgentFromRoom,
    }
})

function mapGroupMessages(msgs: ChatMessage[]): ChatMessage[] {
    const toolNameMap = new Map<string, string>()
    const toolArgsMap = new Map<string, string>()
    for (const msg of msgs) {
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
                if (!tc?.id) continue
                if (tc.function?.name) toolNameMap.set(tc.id, tc.function.name)
                if (tc.function?.arguments) toolArgsMap.set(tc.id, tc.function.arguments)
            }
        }
    }

    const result: ChatMessage[] = []
    for (const msg of msgs) {
        if (
            msg.role !== 'tool' &&
            !msg.tool_calls?.length &&
            !msg.content?.trim() &&
            !msg.reasoning?.trim() &&
            (!msg.isStreaming || msg.finish_reason === 'streaming')
        ) {
            continue
        }

        if (msg.role === 'assistant' && msg.tool_calls?.length && !msg.content?.trim()) {
            for (const tc of msg.tool_calls) {
                result.push({
                    ...msg,
                    id: `${msg.id}_${tc.id}`,
                    role: 'tool',
                    content: '',
                    toolName: tc.function?.name || undefined,
                    toolCallId: tc.id,
                    toolArgs: tc.function?.arguments || undefined,
                    toolStatus: 'running',
                })
            }
            continue
        }

        if (msg.role === 'tool') {
            const tcId = msg.tool_call_id || ''
            const toolName = msg.tool_name || toolNameMap.get(tcId) || undefined
            const toolArgs = toolArgsMap.get(tcId) || undefined
            let preview = ''
            if (msg.content) {
                try {
                    const parsed = JSON.parse(msg.content)
                    preview = parsed.url || parsed.title || parsed.preview || parsed.summary || ''
                } catch {
                    preview = msg.content.slice(0, 80)
                }
            }
            const placeholderIdx = result.findIndex(
                m => m.role === 'tool' && m.toolCallId === tcId && !m.toolResult
            )
            const merged: ChatMessage = {
                ...msg,
                id: placeholderIdx !== -1 ? result[placeholderIdx].id : msg.id,
                senderId: placeholderIdx !== -1 ? result[placeholderIdx].senderId : msg.senderId,
                senderName: placeholderIdx !== -1 ? result[placeholderIdx].senderName : msg.senderName,
                timestamp: placeholderIdx !== -1 ? result[placeholderIdx].timestamp : msg.timestamp,
                role: 'tool',
                content: '',
                toolName: toolName || (placeholderIdx !== -1 ? result[placeholderIdx].toolName : undefined),
                toolCallId: tcId || undefined,
                toolArgs: toolArgs || (placeholderIdx !== -1 ? result[placeholderIdx].toolArgs : undefined),
                toolPreview: typeof preview === 'string' ? preview.slice(0, 100) || undefined : undefined,
                toolResult: msg.content || undefined,
                toolStatus: 'done',
            }
            if (placeholderIdx !== -1) result[placeholderIdx] = merged
            else result.push(merged)
            continue
        }

        result.push(msg)
    }
    return result
}
