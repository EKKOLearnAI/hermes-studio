<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GroupChatPanel from '@/components/hermes/group-chat/GroupChatPanel.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'

const store = useGroupChatStore()
const route = useRoute()
const router = useRouter()

const routeRoomId = computed(() => {
    const value = route.params.roomId
    return typeof value === 'string' && value.trim() ? value : null
})

async function syncRouteRoom() {
    const roomId = routeRoomId.value
    if (!roomId) {
        if (!store.currentRoomId && store.rooms.length > 0) {
            await router.replace({ name: 'hermes.groupChatRoom', params: { roomId: store.rooms[0].id } })
        }
        return
    }

    if (!store.rooms.some(room => room.id === roomId)) {
        await router.replace({ name: 'hermes.groupChat' })
        return
    }

    if (store.currentRoomId !== roomId) {
        await store.joinRoom(roomId)
    }
}

onMounted(async () => {
    store.connect()
    await store.loadRooms()
    await syncRouteRoom()
})

watch(routeRoomId, async () => {
    if (store.rooms.length === 0) return
    await syncRouteRoom()
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
