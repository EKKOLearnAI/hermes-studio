<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage, NInput, NButton, NSpace, NSelect, NPopover, NPopconfirm, NInputNumber } from 'naive-ui'
import multiavatar from '@multiavatar/multiavatar'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { updateRoomConfig, forceCompress } from '@/api/hermes/group-chat'
import GroupMessageList from './GroupMessageList.vue'
import GroupChatInput from './GroupChatInput.vue'

const { t } = useI18n()
const message = useMessage()
const store = useGroupChatStore()
const profilesStore = useProfilesStore()

const showSidebar = ref(true)
const showCreateModal = ref(false)
const showAddAgentModal = ref(false)
const showCompressionModal = ref(false)
const compressionConfig = ref({ triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 20 })
const isCompressing = ref(false)
const selectedProfile = ref<string | null>(null)
const agentName = ref('')
const agentDescription = ref('')

const profileOptions = computed(() =>
    profilesStore.profiles.map(p => ({ label: p.name, value: p.name }))
)

const avatarCache = new Map<string, string>()

function agentAvatarUrl(name: string): string {
    if (avatarCache.has(name)) return avatarCache.get(name)!
    const uri = multiavatar(name)
    avatarCache.set(name, uri)
    return uri
}

const hasRoom = computed(() => !!store.currentRoomId)

function formatTokens(tokens: number): string {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`
    return `${tokens} tokens`
}

function toggleSidebar() {
    showSidebar.value = !showSidebar.value
}

async function handleCreateRoom(name: string, inviteCode: string, userName: string, description: string, compression: { triggerTokens: number; maxHistoryTokens: number; tailMessageCount: number }) {
    try {
        store.setUserInfo(userName, description)
        const res = await store.createNewRoom(name, inviteCode, undefined, compression)
        showCreateModal.value = false
        message.success(t('groupChat.roomCreated'))
        await store.joinRoom(res.room.id)
    } catch {
        message.error(t('common.saveFailed'))
    }
}

async function handleDeleteRoom(roomId: string) {
    try {
        await store.deleteRoom(roomId)
        message.success(t('groupChat.roomDeleted'))
    } catch {
        message.error(t('common.saveFailed'))
    }
}

async function handleSelectRoom(roomId: string) {
    try {
        await store.joinRoom(roomId)
        if (window.innerWidth <= 768) showSidebar.value = false
    } catch {
        message.error(t('groupChat.joinFailed'))
    }
}

async function handleSendMessage(content: string) {
    try {
        await store.sendMessage(content)
    } catch (err: any) {
        message.error(err.message)
    }
}

async function handleAddAgent() {
    await profilesStore.fetchProfiles()
    showAddAgentModal.value = true
}

async function confirmAddAgent() {
    if (!selectedProfile.value || !store.currentRoomId) return
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
            message.error(t('common.saveFailed'))
        }
    }
}

function handleOpenCompressionConfig() {
    const room = store.rooms.find(r => r.id === store.currentRoomId)
    if (room) {
        compressionConfig.value = {
            triggerTokens: room.triggerTokens ?? 100000,
            maxHistoryTokens: room.maxHistoryTokens ?? 32000,
            tailMessageCount: room.tailMessageCount ?? 20,
        }
    }
    showCompressionModal.value = true
}

async function handleSaveCompressionConfig() {
    if (!store.currentRoomId) return
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
    try {
        await store.removeAgentFromRoom(store.currentRoomId, agentId)
    } catch {
        message.error(t('common.deleteFailed'))
    }
}

// Auto-scroll on new messages
const messageListRef = ref()
watch(() => store.sortedMessages.length, async () => {
    await nextTick()
    messageListRef.value?.scrollToBottom()
})
</script>

<template>
    <div class="group-chat-panel">
        <!-- Mobile backdrop -->
        <div class="sidebar-backdrop" :class="{ active: showSidebar }" @click="showSidebar = false" />
        <!-- Room sidebar -->
        <div v-if="showSidebar" class="room-sidebar">
            <div class="sidebar-header">
                <span class="sidebar-title">{{ t('groupChat.title') }}</span>
                <div class="sidebar-actions">
                    <button class="icon-btn" :title="t('groupChat.createRoom')" @click="showCreateModal = true">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                    </button>
                </div>
            </div>
            <div class="room-list">
                <div
                    v-for="room in store.rooms"
                    :key="room.id"
                    class="room-item"
                    :class="{ active: store.currentRoomId === room.id }"
                    @click="handleSelectRoom(room.id)"
                >
                    <svg class="room-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <div class="room-info">
                        <span class="room-name">{{ room.name || room.id }}</span>
                        <span v-if="room.inviteCode" class="room-code">{{ room.inviteCode }}</span>
                        <span class="room-tokens">{{ formatTokens(room.totalTokens || 0) }}</span>
                    </div>
                    <NPopconfirm @positive-click="handleDeleteRoom(room.id)">
                        <template #trigger>
                            <button class="room-delete-btn" @click.stop>
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
        </div>

        <!-- Main chat area -->
        <div class="chat-main">
            <div class="chat-header">
                <button class="icon-btn" @click="toggleSidebar">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" />
                    </svg>
                </button>
                <span class="room-title-text">{{ store.roomName || (store.currentRoomId || t('groupChat.title')) }}</span>
                <div class="header-info">
                    <!-- Stacked avatars (user + agents) -->
                    <NPopover v-if="store.agents.length" trigger="click" placement="bottom-end" :width="220">
                        <template #trigger>
                            <div class="avatar-stack-inner">
                                <!-- User avatar first -->
                                <span class="avatar-stack-item" :style="{ zIndex: store.agents.length + 1 }">
                                    <span class="agent-avatar" v-html="agentAvatarUrl(store.userName || store.userId)" />
                                </span>
                                <span
                                    v-for="(agent, index) in store.agents.slice(-4)"
                                    :key="agent.id"
                                    class="avatar-stack-item"
                                    :style="{ zIndex: store.agents.length - index }"
                                >
                                    <span class="agent-avatar" v-html="agentAvatarUrl(agent.name)" />
                                </span>
                                <span v-if="store.agents.length > 4" class="avatar-stack-more">+{{ store.agents.length - 4 }}</span>
                            </div>
                        </template>
                        <div class="agent-popover">
                            <div class="agent-popover-item" style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--n-border-color, #efeff5);">
                                <span class="agent-avatar" v-html="agentAvatarUrl(store.userName || store.userId)" />
                                <div class="agent-popover-info">
                                    <span class="agent-popover-name">{{ store.userName || 'You' }}</span>
                                    <span class="agent-popover-profile">{{ t('groupChat.you') }}</span>
                                </div>
                            </div>
                            <div class="agent-popover-title">{{ t('groupChat.agents') }} ({{ store.agents.length }})</div>
                            <div v-for="agent in store.agents" :key="agent.id" class="agent-popover-item">
                                <span class="agent-avatar" v-html="agentAvatarUrl(agent.name)" />
                                <div class="agent-popover-info">
                                    <span class="agent-popover-name">{{ agent.name }}</span>
                                    <span class="agent-popover-profile">{{ agent.profile }}</span>
                                </div>
                                <button class="agent-popover-remove" @click="handleRemoveAgent(agent.id)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                </button>
                            </div>
                        </div>
                    </NPopover>
                    <!-- Only user avatar, no agents -->
                    <div v-else-if="store.userName" class="avatar-stack-inner">
                        <span class="avatar-stack-item">
                            <span class="agent-avatar" v-html="agentAvatarUrl(store.userName || store.userId)" />
                        </span>
                    </div>
                    <button class="icon-btn" :title="t('groupChat.addAgent')" @click="handleAddAgent">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
                    <button class="icon-btn" :title="t('groupChat.compressionConfig')" @click="handleOpenCompressionConfig">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 4.6a1.65 1.65 0 0 0 1.51 1V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1.51 1z"/></svg>
                    </button>
                    <span v-if="store.members.length" class="member-count">
                        {{ store.members.length }} {{ t('groupChat.members') }}
                    </span>
                    <span class="connection-dot" :class="{ connected: store.connected, disconnected: !store.connected }"></span>
                </div>
            </div>

            <template v-if="hasRoom">
                <GroupMessageList ref="messageListRef" />
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
                        </div>
                    </div>
                    <div v-else-if="store.typingText" class="typing-indicator">
                        <span class="typing-dots">
                            <span /><span /><span />
                        </span>
                        {{ store.typingText }}
                    </div>
                </div>
                <GroupChatInput @send="handleSendMessage" />
            </template>

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
            <div v-if="showCompressionModal" class="modal-backdrop" @click.self="showCompressionModal = false">
                <div class="modal">
                    <h3>{{ t('groupChat.compressionConfig') }}</h3>
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
                            <NButton type="primary" @click="handleSaveCompressionConfig">{{ t('common.save') }}</NButton>
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
}

.sidebar-backdrop {
    display: none;
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
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid $border-color;
    display: flex;
    flex-direction: column;
}

.sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
    flex-shrink: 0;

    .sidebar-title {
        font-size: 15px;
        font-weight: 600;
        color: $text-primary;
    }

    .sidebar-actions {
        display: flex;
        gap: 4px;
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

    .room-delete-btn {
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
            color: $error;
            background-color: rgba(var(--error-rgb), 0.1);
        }
    }

    &:hover .room-delete-btn {
        opacity: 1;
    }
}

.empty-rooms {
    padding: 20px 12px;
    text-align: center;
    font-size: 13px;
    color: $text-muted;
}

// ─── Chat Main ──────────────────────────────────────────

.chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background-color: transparent;
}

.chat-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 21px 20px;
    border-bottom: 1px solid $border-color;

    .room-title-text {
        font-size: 16px;
        font-weight: 600;
        color: $text-primary;
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .header-info {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
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

.form-group {
    margin-bottom: 16px;
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
    .room-sidebar {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        z-index: 100;
        box-shadow: 4px 0 16px rgba(0, 0, 0, 0.1);
    }

    .chat-header {
        padding-left: 56px;
    }
}
</style>
