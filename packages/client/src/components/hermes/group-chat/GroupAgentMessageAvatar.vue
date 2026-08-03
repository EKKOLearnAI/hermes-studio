<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NPopover } from 'naive-ui'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import type { RoomAgent } from '@/api/hermes/group-chat'
import { groupAgentAvatar } from '@/utils/group-agent-avatar'

const props = defineProps<{
    agent: RoomAgent
    size?: number
}>()

const emit = defineEmits<{
    mention: [agent: RoomAgent]
}>()

const { t } = useI18n()
const avatarSize = computed(() => props.size || 36)
const avatarStyle = computed(() => ({
    width: `${avatarSize.value}px`,
    height: `${avatarSize.value}px`,
}))

function runtimeValue(value: string): string {
    return String(value || '').trim() || t('common.notConfigured')
}
</script>

<template>
    <NPopover trigger="hover" placement="right" :show-arrow="false">
        <template #trigger>
            <span
                class="message-agent-avatar"
                :aria-label="agent.name"
                :style="avatarStyle"
            >
                <ProfileAvatar
                    :name="agent.agent || 'hermes'"
                    :avatar="groupAgentAvatar(agent)"
                    :size="avatarSize"
                />
            </span>
        </template>
        <div class="message-agent-popover">
            <div class="message-agent-popover-header">
                <span class="message-agent-name">@{{ agent.name }}</span>
                <span class="message-agent-type">
                    {{ t(`groupChat.agentTypes.${agent.agent || 'hermes'}`) }}
                </span>
            </div>
            <div class="message-agent-runtime">
                <div class="message-agent-runtime-row">
                    <span>{{ t('workflow.profile') }}</span>
                    <strong :title="runtimeValue(agent.profile)">{{ runtimeValue(agent.profile) }}</strong>
                </div>
                <div class="message-agent-runtime-row">
                    <span>{{ t('profiles.provider') }}</span>
                    <strong :title="runtimeValue(agent.provider)">{{ runtimeValue(agent.provider) }}</strong>
                </div>
                <div class="message-agent-runtime-row">
                    <span>{{ t('profiles.model') }}</span>
                    <strong :title="runtimeValue(agent.model)">{{ runtimeValue(agent.model) }}</strong>
                </div>
            </div>
            <button
                type="button"
                class="message-agent-mention"
                :aria-label="`@${agent.name}`"
                @click.stop="emit('mention', agent)"
            >
                @{{ agent.name }}
            </button>
        </div>
    </NPopover>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.message-agent-avatar {
    display: inline-flex;
    flex: 0 0 auto;
    overflow: hidden;
    border-radius: 8px;
    cursor: pointer;
}

.message-agent-popover {
    display: flex;
    flex-direction: column;
    gap: 9px;
    width: 248px;
    min-width: 0;
}

.message-agent-popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
}

.message-agent-name {
    min-width: 0;
    overflow: hidden;
    color: $text-primary;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.message-agent-type {
    flex: 0 0 auto;
    padding: 2px 6px;
    border-radius: 999px;
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.1);
    font-size: 10px;
    line-height: 1.4;
}

.message-agent-runtime {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 9px;
    border: 1px solid rgba(var(--text-primary-rgb), 0.08);
    border-radius: $radius-sm;
    background: rgba(var(--text-primary-rgb), 0.025);
}

.message-agent-runtime-row {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-size: 11px;
    line-height: 1.45;

    > span {
        color: $text-muted;
    }

    > strong {
        min-width: 0;
        overflow: hidden;
        color: $text-secondary;
        font-weight: 500;
        text-align: end;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
}

.message-agent-mention {
    align-self: flex-end;
    height: 27px;
    padding: 0 10px;
    overflow: hidden;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.28);
    border-radius: $radius-sm;
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.08);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    text-overflow: ellipsis;
    transition: color $transition-fast, border-color $transition-fast, background $transition-fast;
    white-space: nowrap;

    &:hover {
        border-color: rgba(var(--accent-primary-rgb), 0.58);
        background: rgba(var(--accent-primary-rgb), 0.14);
    }

    &:focus-visible {
        outline: 2px solid rgba(var(--accent-primary-rgb), 0.24);
        outline-offset: 1px;
    }
}
</style>
