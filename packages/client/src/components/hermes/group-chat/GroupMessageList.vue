<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import GroupMessageItem from './GroupMessageItem.vue'

const store = useGroupChatStore()
const listRef = ref<HTMLDivElement>()
const isNearBottom = ref(true)

function checkNearBottom(): void {
    if (!listRef.value) return
    const { scrollTop, scrollHeight, clientHeight } = listRef.value
    isNearBottom.value = scrollHeight - scrollTop - clientHeight < 200
}

function scrollToBottom(): void {
    if (!listRef.value) return
    listRef.value.scrollTop = listRef.value.scrollHeight
}

function handleScroll(): void {
    checkNearBottom()
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
    <div ref="listRef" class="message-list" @scroll="handleScroll">
        <div v-if="store.sortedMessages.length === 0" class="empty-state">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p>No messages yet</p>
        </div>
        <GroupMessageItem
            v-for="msg in store.sortedMessages"
            :key="msg.id"
            :message="msg"
            :agents="store.agents"
            :current-user-id="store.userId"
        />
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.message-list {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background-color: $bg-card;
}

.empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: $text-muted;
    opacity: 0.4;

    p {
        font-size: 14px;
    }
}
</style>
