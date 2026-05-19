<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import GroupMessageItem from './GroupMessageItem.vue'

const store = useGroupChatStore()
const { t } = useI18n()
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
            <img src="/logo.png" alt="Hermes" class="empty-logo" />
            <p>{{ t("chat.emptyState") }}</p>
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
    position: relative;

    .dark & {
        background-color: #333333;
    }
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
</style>
