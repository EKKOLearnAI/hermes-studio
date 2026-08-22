<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RoomAgentSummary } from '@/api/hermes/group-chat'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { groupAgentAvatar } from '@/utils/group-agent-avatar'

const { t } = useI18n()
const props = defineProps<{
    agents: RoomAgentSummary[]
    activeAgentIds: string[]
    label: string
}>()

const visibleAgents = computed(() => (
    props.agents.length > 4 ? props.agents.slice(0, 3) : props.agents.slice(0, 4)
))
const hiddenAgents = computed(() => (
    props.agents.length > 4 ? props.agents.slice(3) : []
))
const activeAgentIds = computed(() => new Set(props.activeAgentIds))
const visibleCount = computed(() => (
    props.agents.length > 4 ? 4 : props.agents.length
))
const avatarSize = computed(() => {
    if (visibleCount.value <= 1) return 28
    if (visibleCount.value === 2) return 17
    return 15
})
const overflowActive = computed(() => (
    hiddenAgents.value.some(agent => activeAgentIds.value.has(agent.id))
))
const rosterNames = computed(() => props.agents.map(agent => agent.name).join(', '))
const runningNames = computed(() => (
    props.agents
        .filter(agent => activeAgentIds.value.has(agent.id))
        .map(agent => agent.name)
        .join(', ')
))
const accessibleSummary = computed(() => {
    if (!props.agents.length) {
        return t('groupChat.roomAgentAvatarEmpty', { room: props.label })
    }
    if (!runningNames.value) {
        return t('groupChat.roomAgentAvatarIdle', {
            room: props.label,
            agents: rosterNames.value,
        })
    }
    return t('groupChat.roomAgentAvatarRunning', {
        room: props.label,
        agents: rosterNames.value,
        running: runningNames.value,
    })
})
</script>

<template>
    <div
        class="room-agent-grid"
        :data-agent-count="visibleCount"
        role="img"
        :aria-label="accessibleSummary"
        :title="accessibleSummary"
    >
        <span
            v-if="agents.length === 0"
            class="room-agent-grid-cell room-agent-grid-neutral"
            aria-hidden="true"
        >
            <span />
            <span />
            <span />
            <span />
        </span>
        <span
            v-for="agent in visibleAgents"
            v-else
            :key="agent.id"
            class="room-agent-grid-cell agent"
            :class="{ 'is-active': activeAgentIds.has(agent.id) }"
            :data-agent-id="agent.id"
            :title="agent.name"
            :aria-label="agent.name"
            :aria-busy="activeAgentIds.has(agent.id)"
        >
            <ProfileAvatar
                :name="agent.agent || agent.name"
                :avatar="groupAgentAvatar(agent)"
                :size="avatarSize"
            />
        </span>
        <span
            v-if="hiddenAgents.length"
            class="room-agent-grid-cell room-agent-grid-overflow"
            :class="{ 'is-active': overflowActive }"
            :title="hiddenAgents.map(agent => agent.name).join(', ')"
            :aria-label="hiddenAgents.map(agent => agent.name).join(', ')"
            :aria-busy="overflowActive"
        >
            +{{ hiddenAgents.length }}
        </span>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.room-agent-grid {
    position: relative;
    display: block;
    flex: 0 0 36px;
    width: 36px;
    height: 36px;
    overflow: visible;
    box-sizing: border-box;
    border: 1px solid $border-color;
    border-radius: 8px;
    background: $bg-secondary;
}

.room-agent-grid-cell {
    position: absolute;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: visible;
    box-sizing: border-box;
    border-radius: 5px;

    :deep(.profile-avatar-view) {
        border-radius: 4px;
    }

    &.is-active::before {
        position: absolute;
        z-index: 2;
        inset: -1px;
        border: 1px solid #fff;
        border-radius: 6px;
        box-shadow: 0 0 0 2px rgba(var(--accent-primary-rgb), 0.9);
        content: '';
        pointer-events: none;
    }

    &.is-active::after {
        position: absolute;
        z-index: 1;
        inset: -5px;
        border-radius: 9px;
        box-shadow: 0 0 5px 2px rgba(var(--accent-primary-rgb), 0.72);
        content: '';
        animation: room-agent-grid-breathe 1.6s ease-in-out infinite;
        pointer-events: none;
    }
}

.room-agent-grid[data-agent-count='0'] .room-agent-grid-cell,
.room-agent-grid[data-agent-count='1'] .room-agent-grid-cell {
    inset: 4px;
    width: 28px;
    height: 28px;
}

.room-agent-grid[data-agent-count='2'] {
    .room-agent-grid-cell {
        width: 17px;
        height: 17px;

        &:nth-child(1) {
            top: 2px;
            left: 2px;
        }

        &:nth-child(2) {
            right: 2px;
            bottom: 2px;
        }
    }
}

.room-agent-grid[data-agent-count='3'] {
    .room-agent-grid-cell {
        width: 15px;
        height: 15px;

        &:nth-child(1) {
            top: 2px;
            left: 10px;
        }

        &:nth-child(2) {
            bottom: 2px;
            left: 2px;
        }

        &:nth-child(3) {
            right: 2px;
            bottom: 2px;
        }
    }
}

.room-agent-grid[data-agent-count='4'] {
    .room-agent-grid-cell {
        width: 15px;
        height: 15px;

        &:nth-child(1) {
            top: 2px;
            left: 2px;
        }

        &:nth-child(2) {
            top: 2px;
            right: 2px;
        }

        &:nth-child(3) {
            bottom: 2px;
            left: 2px;
        }

        &:nth-child(4) {
            right: 2px;
            bottom: 2px;
        }
    }
}

.room-agent-grid-overflow {
    background: $bg-main-surface;
    color: $text-secondary;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
}

.room-agent-grid-neutral {
    display: grid;
    grid-template-columns: repeat(2, 6px);
    grid-template-rows: repeat(2, 6px);
    gap: 2px;
    background: rgba(var(--text-muted-rgb), 0.08);

    span {
        border-radius: 2px;
        background: rgba(var(--text-muted-rgb), 0.42);
    }
}

@keyframes room-agent-grid-breathe {
    0%, 100% {
        opacity: 0.35;
        box-shadow: 0 0 4px 1px rgba(var(--accent-primary-rgb), 0.58);
    }

    50% {
        opacity: 0.9;
        box-shadow: 0 0 7px 3px rgba(var(--accent-primary-rgb), 0.8);
    }
}

@media (prefers-reduced-motion: reduce) {
    .room-agent-grid-cell.is-active::after {
        opacity: 0.7;
        animation: none;
    }
}
</style>
