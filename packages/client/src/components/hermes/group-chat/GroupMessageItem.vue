<script setup lang="ts">
import { computed } from 'vue'
import multiavatar from '@multiavatar/multiavatar'
import MarkdownRenderer from '../chat/MarkdownRenderer.vue'
import type { ChatMessage, RoomAgent } from '@/api/hermes/group-chat'

const props = defineProps<{
    message: ChatMessage
    agents: RoomAgent[]
    currentUserId?: string
}>()

const isAgent = computed(() => {
    return props.agents.some(a => a.agentId === props.message.senderId)
})

const isSelf = computed(() => {
    return !!props.currentUserId && props.message.senderId === props.currentUserId
})

const agentInfo = computed(() => {
    return props.agents.find(a => a.agentId === props.message.senderId)
})

const timeStr = computed(() => {
    const d = new Date(props.message.timestamp)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
})

const avatarSvg = computed(() => {
    return multiavatar(props.message.senderName || props.message.senderId)
})

const mentionNames = computed(() => props.agents.map(a => a.name).filter(Boolean))
</script>

<template>
    <div class="group-message" :class="{ agent: isAgent, self: isSelf }">
        <!-- Avatar -->
        <div class="avatar">
            <span v-html="avatarSvg" />
        </div>

        <div class="msg-body">
            <div class="msg-header">
                <span class="sender-name">{{ message.senderName }}</span>
                <span v-if="isAgent && agentInfo?.description" class="agent-desc">{{ agentInfo.description }}</span>
            </div>
            <div class="msg-content" :class="{ 'agent-content': isAgent }">
                <MarkdownRenderer :content="message.content" :mention-names="mentionNames" />
            </div>
            <span class="msg-time">{{ timeStr }}</span>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.group-message {
    display: flex;
    gap: 10px;
    padding: 2px 0;

    &.agent,
    &.self {
        flex-direction: row-reverse;

        .msg-body {
            align-items: flex-end;
        }

        .msg-header {
            flex-direction: row-reverse;
        }
    }

    &.agent .msg-content.agent-content {
        background-color: rgba(var(--accent-primary-rgb), 0.06);
    }

    &.self .msg-content {
        background-color: rgba(var(--accent-primary-rgb), 0.1);
    }
}

.avatar {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    margin-top: 2px;
    overflow: hidden;
    border-radius: 8px;

    :deep(svg) {
        width: 36px;
        height: 36px;
    }
}

.msg-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 85%;
}

.msg-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 2px;

    .sender-name {
        font-size: 13px;
        font-weight: 600;
        color: $text-primary;
    }

    .agent-desc {
        font-size: 11px;
        color: $text-muted;
        font-style: italic;
    }
}

.msg-time {
    font-size: 12px;
    color: var(--text-muted);
    opacity: 0.6;
    margin-top: 2px;
}

.msg-content {
    padding: 10px 14px;
    font-size: 14px;
    line-height: 1.65;
    color: $text-primary;
    border-radius: 10px;
    background-color: $msg-user-bg;
    word-break: break-word;
    overflow-wrap: break-word;

    :deep(.mention-highlight) {
        color: #409eff;
        font-weight: 600;
        cursor: default;
    }
}
</style>
