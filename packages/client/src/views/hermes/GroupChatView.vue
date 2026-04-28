<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import GroupChatPanel from '@/components/hermes/group-chat/GroupChatPanel.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'

const store = useGroupChatStore()

onMounted(() => {
    store.connect()
    store.loadRooms()
})

onUnmounted(() => {
    store.disconnect()
})
</script>

<template>
    <div class="group-chat-view">
        <GroupChatPanel />
    </div>
</template>

<style scoped lang="scss">
.group-chat-view {
    height: calc(100 * var(--vh));
    display: flex;
    flex-direction: column;
}
</style>
