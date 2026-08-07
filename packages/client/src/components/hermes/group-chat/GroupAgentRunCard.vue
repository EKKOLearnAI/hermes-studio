<script setup lang="ts">
import { computed } from 'vue'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { formatChatTimestamp } from '@/utils/chat-timestamp'
import type { ChatMessage, MemberInfo, RoomAgent } from '@/api/hermes/group-chat'
import GroupMessageItem from './GroupMessageItem.vue'
import GroupAgentMessageAvatar from './GroupAgentMessageAvatar.vue'

const props = withDefaults(defineProps<{
    message: ChatMessage
    agents: RoomAgent[]
    members?: MemberInfo[]
    currentUserId?: string
    allowSpeech?: boolean
}>(), {
    allowSpeech: true,
})

const emit = defineEmits<{
    mentionAgent: [agent: RoomAgent]
}>()

const items = computed(() => props.message.runItems || [])
const agentInfo = computed(() => props.agents.find(agent =>
    agent.agentId === props.message.senderId || agent.name === props.message.senderName
))
const lastTimestamp = computed(() => items.value.at(-1)?.timestamp || props.message.timestamp)
const timeText = computed(() => formatChatTimestamp(lastTimestamp.value))
</script>

<template>
    <div class="group-agent-run" :data-run-id="message.run_id || undefined">
        <div class="run-avatar">
            <GroupAgentMessageAvatar
                v-if="agentInfo"
                :agent="agentInfo"
                :size="36"
                @mention="emit('mentionAgent', $event)"
            />
            <ProfileAvatar v-else name="hermes" :size="36" />
        </div>
        <div class="run-column">
            <div class="run-header">
                <span class="run-agent-name">{{ message.senderName }}</span>
            </div>
            <div class="run-card" :class="{ streaming: message.isStreaming }">
                <GroupMessageItem
                    v-for="item in items"
                    :key="item.id"
                    :message="item"
                    :agents="agents"
                    :members="members"
                    :current-user-id="currentUserId"
                    :allow-speech="props.allowSpeech"
                    embedded
                />
            </div>
            <span class="run-time">{{ timeText }}</span>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.group-agent-run {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
    max-width: 100%;
    padding: 2px 0;
    box-sizing: border-box;
}

.run-avatar {
    width: 36px;
    height: 36px;
    flex: 0 0 36px;
    margin-top: 2px;
    overflow: hidden;
    border-radius: 8px;
}

.run-column {
    display: flex;
    flex-direction: column;
    min-width: 0;
    width: min(85%, 920px);
}

.run-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 2px;
}

.run-agent-name {
    color: $text-primary;
    font-size: 13px;
    font-weight: 600;
}

.run-card {
    position: relative;
    min-width: 0;
    overflow: visible;
    box-sizing: border-box;
    border: none;
    border-radius: 10px;
    background: rgba(var(--accent-primary-rgb), 0.055);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.035);

    > :deep(.group-message + .group-message) {
        border-top: 1px solid rgba(var(--text-primary-rgb), 0.08);
    }
}

.run-time {
    align-self: flex-start;
    padding: 3px 4px 0;
    color: var(--text-muted);
    font-size: 12px;
    opacity: 0.6;
    user-select: none;
}

:global(html.theme-has-custom-background .run-card) {
    background: rgba(var(--bg-main-surface-rgb), 0.78);
    -webkit-backdrop-filter: blur(8px) saturate(110%);
    backdrop-filter: blur(8px) saturate(110%);
}

@media (max-width: 768px) {
    .run-column {
        width: calc(100% - 46px);
    }
}
</style>
