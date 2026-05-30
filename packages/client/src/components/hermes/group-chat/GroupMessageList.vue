<script setup lang="ts">
import { computed, onMounted, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import GroupMessageItem from './GroupMessageItem.vue'
import VirtualMessageList from '../chat/VirtualMessageList.vue'

const store = useGroupChatStore()
const { t } = useI18n()
const { toolTraceVisible } = useToolTraceVisibility()
const listRef = ref<InstanceType<typeof VirtualMessageList> | null>(null)
const displayMessages = computed(() => store.sortedMessages.filter(msg => msg.role !== 'tool' || toolTraceVisible.value || msg.toolStatus === 'running'))
let pendingInitialBottomRoomId: string | null = store.currentRoomId

type BottomScrollOptions = number | {
    frames?: number
    keepAliveMs?: number
}

function scrollToBottom(options?: BottomScrollOptions): void {
    const list = listRef.value as (InstanceType<typeof VirtualMessageList> & {
        scrollToBottom: (options?: BottomScrollOptions) => void
    }) | null
    list?.scrollToBottom(options)
}

async function handleTopReach(): Promise<void> {
    if (!store.hasMoreBefore || store.isLoadingOlderMessages) return
    const snapshot = listRef.value?.captureScrollPosition() ?? null
    const loaded = await store.loadOlderMessages()
    if (!loaded) return
    await nextTick()
    listRef.value?.restoreScrollPosition(snapshot)
}

watch(() => store.currentRoomId, (roomId) => {
    pendingInitialBottomRoomId = roomId
})

watch(() => displayMessages.value.map(msg => [
    msg.id,
    msg.content?.length ?? 0,
    msg.reasoning?.length ?? 0,
    msg.reasoning_content?.length ?? 0,
    msg.toolStatus ?? '',
].join(':')).join('|'), async () => {
    const shouldForceInitialBottom = !!store.currentRoomId &&
        pendingInitialBottomRoomId === store.currentRoomId &&
        displayMessages.value.length > 0
    const shouldScroll = shouldForceInitialBottom || (listRef.value?.isNearBottom(200) ?? true)
    await nextTick()
    if (shouldScroll) {
        scrollToBottom(shouldForceInitialBottom ? { frames: 5, keepAliveMs: 700 } : { frames: 1, keepAliveMs: 120 })
        if (shouldForceInitialBottom) pendingInitialBottomRoomId = null
    }
})

onMounted(async () => {
    if (!store.currentRoomId || displayMessages.value.length === 0) return
    pendingInitialBottomRoomId = null
    await nextTick()
    scrollToBottom({ frames: 5, keepAliveMs: 700 })
})

defineExpose({ scrollToBottom })
</script>

<template>
    <VirtualMessageList
        ref="listRef"
        :messages="displayMessages"
        :estimated-item-height="170"
        :row-gap="12"
        padding="16px 20px"
        @top-reach="handleTopReach"
    >
        <template #empty>
            <div class="empty-state">
            <img src="/logo.png" alt="Hermes" class="empty-logo" />
            <p>{{ t("chat.emptyState") }}</p>
        </div>
        </template>
        <template #before>
            <div
                v-if="store.hasMoreBefore || store.isLoadingOlderMessages"
                class="history-loader"
            >
                <span v-if="store.isLoadingOlderMessages" class="history-loader-spinner"></span>
            </div>
        </template>
        <template #item="{ message: msg }">
            <GroupMessageItem
                :message="msg"
                :agents="store.agents"
                :current-user-id="store.userId"
            />
        </template>
    </VirtualMessageList>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: $text-muted;

    .empty-logo {
        width: 48px;
        height: 48px;
        opacity: 0.25;
    }

    p {
        font-size: 14px;
    }
}

.history-loader {
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
}

.history-loader-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(0, 0, 0, 0.16);
    border-top-color: $accent-primary;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;

    .dark & {
        border-color: rgba(255, 255, 255, 0.18);
        border-top-color: $accent-primary;
    }
}

@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}
</style>
