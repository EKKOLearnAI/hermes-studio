import type { GroupChatServer } from './index'

type GroupChatStorage = ReturnType<GroupChatServer['getStorage']>

function userProfiles(user: any): string[] {
    return Array.isArray(user?.profiles) ? user.profiles.map(String).filter(Boolean) : []
}

function isRoomOwner(room: any, user: any): boolean {
    return typeof user?.id === 'number' && Number(room?.ownerAuthUserId || 0) === user.id
}

function hasProfileRoomAccess(storage: GroupChatStorage, roomId: string, user: any): boolean {
    const profiles = userProfiles(user)
    if (!profiles.length || typeof storage.getRoomsForProfiles !== 'function') return false
    return storage.getRoomsForProfiles(profiles).some(room => room.id === roomId)
}

export function canManageGroupChatRoom(storage: GroupChatStorage, roomId: string, user: any): boolean {
    if (!user || user.role === 'super_admin') return true
    const room = typeof storage.getRoom === 'function' ? storage.getRoom(roomId) : null
    if (room && isRoomOwner(room, user)) return true
    return hasProfileRoomAccess(storage, roomId, user)
}

export function canReadGroupChatRoom(storage: GroupChatStorage, roomId: string, user: any): boolean {
    if (canManageGroupChatRoom(storage, roomId, user)) return true
    return typeof user?.id === 'number' && typeof storage.getMemberByAuthUserId === 'function' && !!storage.getMemberByAuthUserId(roomId, user.id)
}

export function groupChatUserProfiles(user: any): string[] {
    return userProfiles(user)
}

export function publicGroupChatInviteRoom(room: any) {
    return {
        id: String(room.id || ''),
        name: String(room.name || ''),
        inviteCode: null,
        canManage: false,
        summaryProfile: '',
        summaryProvider: '',
        summaryModel: '',
        summaryApiMode: '',
        summaryEveryTurns: 0,
        totalTokens: 0,
        workspace: '',
    }
}
