import { describe, expect, it } from 'vitest'
import { decideGroupRoomRoute } from '../../packages/client/src/views/hermes/group-room-route'

describe('decideGroupRoomRoute', () => {
    it('never navigates once the browser has left the surface', () => {
        // Clicking "设置" from inside a room clears roomId and wakes the route
        // watcher while the app is already navigating to the settings page. The
        // old store-state-only guard replaced the route back to the room here,
        // which made the settings page unreachable.
        expect(decideGroupRoomRoute({
            onSurface: false,
            roomId: null,
            availableRoomIds: ['r1', 'r2'],
            currentRoomId: null,
        })).toEqual({ kind: 'none' })
    })

    it('stays put when leaving the surface with a room still open', () => {
        expect(decideGroupRoomRoute({
            onSurface: false,
            roomId: null,
            availableRoomIds: ['r1'],
            currentRoomId: 'r1',
        })).toEqual({ kind: 'none' })
    })

    it('opens the first room when landing on the index with nothing open', () => {
        expect(decideGroupRoomRoute({
            onSurface: true,
            roomId: null,
            availableRoomIds: ['r1', 'r2'],
            currentRoomId: null,
        })).toEqual({ kind: 'select', roomId: 'r1' })
    })

    it('leaves the user on the index when they still have a room open', () => {
        expect(decideGroupRoomRoute({
            onSurface: true,
            roomId: null,
            availableRoomIds: ['r1'],
            currentRoomId: 'r1',
        })).toEqual({ kind: 'none' })
    })

    it('does nothing on an empty surface', () => {
        expect(decideGroupRoomRoute({
            onSurface: true,
            roomId: null,
            availableRoomIds: [],
            currentRoomId: null,
        })).toEqual({ kind: 'none' })
    })

    it('releases a room from the other surface when this one has none', () => {
        // `currentRoomId` is shared, so a 群协作 room left open kept rendering
        // its transcript on the 群聊 index — which has no rooms of its own yet.
        expect(decideGroupRoomRoute({
            onSurface: true,
            roomId: null,
            availableRoomIds: [],
            currentRoomId: 'collab-room',
        })).toEqual({ kind: 'clear' })
    })

    it('replaces a room from the other surface with one of its own', () => {
        expect(decideGroupRoomRoute({
            onSurface: true,
            roomId: null,
            availableRoomIds: ['chat-room'],
            currentRoomId: 'collab-room',
        })).toEqual({ kind: 'select', roomId: 'chat-room' })
    })

    it('joins a room named in the URL', () => {
        expect(decideGroupRoomRoute({
            onSurface: true,
            roomId: 'r2',
            availableRoomIds: ['r1', 'r2'],
            currentRoomId: 'r1',
        })).toEqual({ kind: 'join', roomId: 'r2' })
    })

    it('does not rejoin the room that is already open', () => {
        expect(decideGroupRoomRoute({
            onSurface: true,
            roomId: 'r1',
            availableRoomIds: ['r1'],
            currentRoomId: 'r1',
        })).toEqual({ kind: 'none' })
    })

    it('rejects a room belonging to the other surface', () => {
        // A group-chat room opened under /group-collab would route its
        // @mentions through the wrong pipeline entirely.
        expect(decideGroupRoomRoute({
            onSurface: true,
            roomId: 'chat-room',
            availableRoomIds: ['collab-room'],
            currentRoomId: null,
        })).toEqual({ kind: 'reject' })
    })

    it('rejects an unknown room id rather than joining it', () => {
        expect(decideGroupRoomRoute({
            onSurface: true,
            roomId: 'deleted-room',
            availableRoomIds: ['r1'],
            currentRoomId: 'r1',
        })).toEqual({ kind: 'reject' })
    })
})
