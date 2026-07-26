import type { GroupChatServer } from './index'
import {
  createAuthenticatedGroupChatSubject,
  createLocalGroupChatSubject,
  evaluateGroupChatAccessPolicy,
  groupChatUserProfiles,
  type GroupChatAccessDecision,
  type GroupChatAuthenticatedUserLike,
  type GroupChatSubject,
} from './access-policy'

type GroupChatStorage = ReturnType<GroupChatServer['getStorage']>

export function createGroupChatRequestSubject(
  user: GroupChatAuthenticatedUserLike | null | undefined,
  localSubjectId?: string | null,
): GroupChatSubject | null {
  const authenticatedSubject = createAuthenticatedGroupChatSubject(user)
  if (authenticatedSubject) return authenticatedSubject
  if (typeof localSubjectId !== 'string' || !localSubjectId.trim()) return null
  return createLocalGroupChatSubject(localSubjectId.trim())
}

export function evaluateGroupChatRequestAccess(
  storage: GroupChatStorage,
  roomId: string,
  user: GroupChatAuthenticatedUserLike | null | undefined,
  localSubjectId?: string | null,
): GroupChatAccessDecision | null {
  const subject = createGroupChatRequestSubject(user, localSubjectId)
  return subject ? evaluateGroupChatAccessPolicy(storage, roomId, subject) : null
}

export function canManageGroupChatRoom(
  storage: GroupChatStorage,
  roomId: string,
  user: GroupChatAuthenticatedUserLike | null | undefined,
  localSubjectId?: string | null,
): boolean {
  return Boolean(evaluateGroupChatRequestAccess(storage, roomId, user, localSubjectId)?.canManage)
}

export function canReadGroupChatRoom(
  storage: GroupChatStorage,
  roomId: string,
  user: GroupChatAuthenticatedUserLike | null | undefined,
  localSubjectId?: string | null,
): boolean {
  return Boolean(evaluateGroupChatRequestAccess(storage, roomId, user, localSubjectId)?.canRead)
}

export { groupChatUserProfiles }
