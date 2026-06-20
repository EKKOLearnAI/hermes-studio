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
const showScrollBottomButton = ref(false)
const displayMessages = computed(() => store.sortedMessages.filter(msg => msg.role !== 'tool' || toolTraceVisible.value || msg.toolStatus === 'running'))
const listPadding = computed(() => store.activePendingApproval ? '16px 20px 260px' : '16px 20px')
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
    showScrollBottomButton.value = false
}

function updateScrollBottomButton(): void {
    showScrollBottomButton.value = displayMessages.value.length > 0 && !(listRef.value?.isNearBottom(1000) ?? true)
}

function handleListScroll(): void {
    updateScrollBottomButton()
}

function handleScrollBottomClick(): void {
    scrollToBottom({ frames: 4, keepAliveMs: 600 })
}

async function handleTopReach(): Promise<void> {
    if (!store.hasMoreBefore || store.isLoadingOlderMessages || store.hasReachedMessageDisplayLimit) return
    const snapshot = listRef.value?.captureScrollPosition() ?? null
    const loaded = await store.loadOlderMessages()
    if (!loaded) return
    await nextTick()
    listRef.value?.restoreScrollPosition(snapshot)
    updateScrollBottomButton()
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
    updateScrollBottomButton()
})

onMounted(async () => {
    if (!store.currentRoomId || displayMessages.value.length === 0) return
    pendingInitialBottomRoomId = null
    await nextTick()
    scrollToBottom({ frames: 5, keepAliveMs: 700 })
    updateScrollBottomButton()
})

defineExpose({ scrollToBottom })
</script>

<template>
    <div class="group-message-list-shell">
        <VirtualMessageList
            class="group-message-list"
            ref="listRef"
            :messages="displayMessages"
            :virtualized="false"
            :estimated-item-height="170"
            :row-gap="12"
            :padding="listPadding"
            @scroll="handleListScroll"
            @top-reach="handleTopReach"
        >
            <template #empty>
                <div class="empty-state">
                <img :src="'/coding-agents/hermes.png'" alt="Hermes" class="empty-logo" />
                <p>{{ t("chat.emptyState") }}</p>
            </div>
            </template>
            <template #before>
                <div
                    v-if="store.hasReachedMessageDisplayLimit"
                    class="history-limit-notice"
                >
                    {{ t('groupChat.messageDisplayLimit') }}
                </div>
                <div
                    v-else-if="store.hasMoreBefore || store.isLoadingOlderMessages"
                    class="history-loader"
                >
                    <span v-if="store.isLoadingOlderMessages" class="history-loader-spinner"></span>
                </div>
            </template>
            <template #item="{ message: msg }">
                <GroupMessageItem
                    :message="msg"
                    :agents="store.agents"
                    :members="store.members"
                    :current-user-id="store.userId"
                />
            </template>
        </VirtualMessageList>
        <button
            v-if="showScrollBottomButton"
            type="button"
            class="scroll-bottom-button"
            :aria-label="t('chat.scrollToBottom')"
            :title="t('chat.scrollToBottom')"
            @click="handleScrollBottomClick"
        >
            <svg
                class="scroll-bottom-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
            >
                <path d="m7 10 5 5 5-5" />
                <path d="M6 19h12" />
            </svg>
        </button>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.group-message-list-shell {
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
    display: flex;
}

.group-message-list {
    min-width: 0;
    max-width: 100%;
}

.scroll-bottom-button {
    position: absolute;
    right: 18px;
    bottom: 18px;
    z-index: 7;
    width: 38px;
    height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
    background: rgba(255, 255, 255, 0.94);
    color: var(--accent-primary);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
    padding: 0;
    cursor: pointer;

    .dark & {
        background: rgba(38, 38, 38, 0.94);
    }
}

.scroll-bottom-button:hover {
    background: rgba(var(--accent-primary-rgb), 0.1);
}

.scroll-bottom-icon {
    width: 19px;
    height: 19px;
}

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

.history-limit-notice {
    width: fit-content;
    max-width: min(100%, 420px);
    margin: 0 auto 8px;
    padding: 6px 10px;
    border: 1px solid rgba(var(--accent-info-rgb), 0.22);
    border-radius: 999px;
    background: rgba(var(--accent-info-rgb), 0.08);
    color: $text-secondary;
    font-size: 12px;
    line-height: 1.3;
    text-align: center;
}

@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}
</style>
