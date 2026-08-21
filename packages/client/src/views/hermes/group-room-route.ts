/**
 * Route-syncing decision shared by the group chat and 群协作 surfaces.
 *
 * Both views watch the route for a room id and reconcile it against the store.
 * Doing that inline made it easy to navigate from a watcher that fires while
 * the user is already on their way somewhere else — clicking "设置" from a room
 * clears `roomId`, wakes the watcher, and a store-state-only guard would then
 * replace the route back to the room, pinning the user on the surface.
 *
 * Hence `onSurface`: no decision may cause navigation once the browser has left
 * this surface's routes.
 */

export type GroupRoomRouteDecision =
    /** Do nothing. */
    | { kind: 'none' }
    /** No room in the URL and none open — open this one. */
    | { kind: 'select'; roomId: string }
    /** The URL names a room that does not belong to this surface. */
    | { kind: 'reject' }
    /** The URL names a valid room that is not the open one. */
    | { kind: 'join'; roomId: string }
    /**
     * A room from the other surface is open and this one has nothing to put in
     * its place, so the open room must be released rather than left rendering.
     */
    | { kind: 'clear' }

export interface GroupRoomRouteInput {
    /** False once the browser has navigated away from this surface. */
    onSurface: boolean
    /** Room id in the current URL, if any. */
    roomId: string | null
    /** Ids of the rooms belonging to this surface, in display order. */
    availableRoomIds: readonly string[]
    /** Room the store currently has open, across both surfaces. */
    currentRoomId: string | null
}

export function decideGroupRoomRoute(input: GroupRoomRouteInput): GroupRoomRouteDecision {
    if (!input.onSurface) return { kind: 'none' }

    if (!input.roomId) {
        // Landing on the index with one of this surface's own rooms open is a
        // deliberate act — leave the user alone. An open room belonging to the
        // OTHER surface is different: `currentRoomId` is shared state, so it
        // would keep that room's transcript on screen here.
        if (input.currentRoomId && input.availableRoomIds.includes(input.currentRoomId)) {
            return { kind: 'none' }
        }
        const first = input.availableRoomIds[0]
        if (first) return { kind: 'select', roomId: first }
        return input.currentRoomId ? { kind: 'clear' } : { kind: 'none' }
    }

    if (!input.availableRoomIds.includes(input.roomId)) return { kind: 'reject' }

    return input.currentRoomId === input.roomId
        ? { kind: 'none' }
        : { kind: 'join', roomId: input.roomId }
}
