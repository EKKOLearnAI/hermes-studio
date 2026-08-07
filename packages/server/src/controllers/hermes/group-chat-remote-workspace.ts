import type { Context } from 'koa'
import { logger } from '../../services/logger'
import { getGroupChatRuntimeServer } from '../../services/hermes/group-chat/runtime'
import { beginRemoteWorkspaceGrantOperation } from '../../services/hermes/group-chat/remote-workspace-auth'
import { performRemoteWorkspaceAction } from '../../services/hermes/group-chat/remote-workspace-files'

function bearerToken(ctx: Context): string {
  const authorization = ctx.get('Authorization')
  const match = authorization.match(/^Bearer ([a-zA-Z0-9_-]+)$/)
  return match?.[1] || ''
}

export async function remoteWorkspaceAction(ctx: Context): Promise<void> {
  ctx.set('Cache-Control', 'no-store')
  const operation = beginRemoteWorkspaceGrantOperation(bearerToken(ctx))
  if (!operation) {
    ctx.status = 401
    ctx.body = { error: 'Remote workspace authorization is invalid or expired', code: 'invalid_grant' }
    return
  }
  const { grant } = operation
  try {
    const server = getGroupChatRuntimeServer()
    const room = server?.getStorage().getRoom(grant.roomId)
    if (
      !room
      || Number(room.allowRemoteWorkspaceAccess || 0) !== 1
      || String(room.workspace || '').trim() !== grant.workspace
    ) {
      ctx.status = 403
      ctx.body = { error: 'Remote workspace access is disabled', code: 'permission_denied' }
      return
    }
    const workspace = grant.workspace
    if (!workspace) {
      ctx.status = 404
      ctx.body = { error: 'Room workspace not found', code: 'workspace_not_found' }
      return
    }
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const action = String(body.action || '')
    ctx.body = await performRemoteWorkspaceAction(workspace, {
      ...body,
      action,
    } as any)
    logger.info({
      roomId: grant.roomId,
      agentId: grant.agentId,
      runId: grant.runId,
      action,
      path: String(body.path || '').slice(0, 500),
    }, '[GroupChat] remote workspace action')
  } catch (error: any) {
    ctx.status = Number(error?.status || (error?.code === 'ENOENT' ? 404 : 500))
    ctx.body = {
      error: error?.message || 'Remote workspace action failed',
      code: error?.code || 'remote_workspace_error',
    }
  } finally {
    operation.finish()
  }
}
