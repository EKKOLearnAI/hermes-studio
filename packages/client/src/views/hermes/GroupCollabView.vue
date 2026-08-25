<script setup lang="ts">
/**
 * 群协作 route shell. Deliberately a thin mirror of GroupChatView: the whole
 * point of this surface is that it looks and behaves like group chat, so it
 * reuses GroupChatPanel and only declares the room kind. The behavioural
 * difference lives server-side, where an @mention in a 'collab' room opens a
 * Kanban run instead of an agent turn.
 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GroupChatPanel from '@/components/hermes/group-chat/GroupChatPanel.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import { decideGroupRoomRoute } from './group-room-route'

const store = useGroupChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const route = useRoute()
const router = useRouter()

const routeRoomId = computed(() => {
    const value = route.params.roomId
    return typeof value === 'string' && value.trim() ? value : null
})

const routeProfile = computed(() => {
    const value = route.query?.profile
    return typeof value === 'string' && value.trim() ? value : null
})

/** Rooms are shared storage, so this surface must only auto-select its own. */
const collabRooms = computed(() => store.rooms.filter(room => room.roomKind === 'collab'))

async function applyRouteProfile() {
    const profile = routeProfile.value
    if (!profile || profile === profilesStore.activeProfileName) return
    if (!profilesStore.profiles.some(item => item.name === profile)) return
    await profilesStore.switchProfile(profile)
}

const COLLAB_ROUTE_NAMES = new Set(['hermes.groupCollab', 'hermes.groupCollabRoom'])

async function syncRouteRoom() {
    const decision = decideGroupRoomRoute({
        onSurface: COLLAB_ROUTE_NAMES.has(String(route.name || '')),
        roomId: routeRoomId.value,
        availableRoomIds: collabRooms.value.map(room => room.id),
        currentRoomId: store.currentRoomId,
    })

    switch (decision.kind) {
        case 'select':
            await router.replace({ name: 'hermes.groupCollabRoom', params: { roomId: decision.roomId } })
            return
        case 'reject':
            // A group-chat room id must not open here, or its @mentions would
            // silently run agent turns inside the collaboration surface.
            await router.replace({ name: 'hermes.groupCollab' })
            return
        case 'join':
            await store.joinRoom(decision.roomId)
            return
        case 'clear':
            store.closeRoom()
            return
        default:
            return
    }
}

onMounted(async () => {
    await profilesStore.fetchProfiles()
    await applyRouteProfile()
    await store.connect()
    await Promise.all([
        store.loadRooms(),
        settingsStore.fetchSettings(),
    ])
    await syncRouteRoom()
})

watch([routeRoomId, routeProfile], async () => {
    await applyRouteProfile()
    if (store.rooms.length === 0) return
    await syncRouteRoom()
})
</script>

<template>
    <div class="group-collab-view">
        <GroupChatPanel room-kind="collab" />
    </div>
</template>

<style scoped lang="scss">
.group-collab-view {
    height: calc(100 * var(--vh));
    display: flex;
    flex-direction: column;
}
</style>
