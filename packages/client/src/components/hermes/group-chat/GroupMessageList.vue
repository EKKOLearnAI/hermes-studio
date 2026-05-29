<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import GroupMessageItem from './GroupMessageItem.vue'
import VirtualMessageList from '../chat/VirtualMessageList.vue'

const store = useGroupChatStore()
const { t } = useI18n()
const { toolTraceVisible } = useToolTraceVisibility()
const listRef = ref<InstanceType<typeof VirtualMessageList> | null>(null)
const isNearBottom = ref(true)
const displayMessages = computed(() => store.sortedMessages.filter(msg => msg.role !== 'tool' || toolTraceVisible.value || msg.toolStatus === 'running'))

function checkNearBottom(): void {
    isNearBottom.value = listRef.value?.isNearBottom(200) ?? true
}

function scrollToBottom(): void {
    listRef.value?.scrollToBottom()
}

async function handleTopReach(): Promise<void> {
    if (!store.hasMoreBefore || store.isLoadingOlderMessages) return
    const snapshot = listRef.value?.captureScrollPosition() ?? null
    const loaded = await store.loadOlderMessages()
    if (!loaded) return
    await nextTick()
    listRef.value?.restoreScrollPosition(snapshot)
}

watch(() => store.messages.length, async () => {
    await nextTick()
    if (isNearBottom.value) {
        scrollToBottom()
    }
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
        @scroll="checkNearBottom"
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
