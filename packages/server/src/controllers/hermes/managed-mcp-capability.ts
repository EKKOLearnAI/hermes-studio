import type { Context } from 'koa'
import { authorizeManagedMcpCapability } from '../../services/hermes/managed-mcp-capability'
import { getGroupChatRuntimeServer } from '../../services/hermes/group-chat/runtime'

function isLoopback(ctx: Context): boolean {
  const values = [String(ctx.ip || ''), String(ctx.request.ip || ''), String(ctx.req.socket.remoteAddress || '')]
    .map(value => value.startsWith('::ffff:') ? value.slice(7) : value)
  return values.some(value => value === '::1' || value === 'localhost' || value.startsWith('127.'))
}

export async function authorize(ctx: Context): Promise<void> {
  if (!isLoopback(ctx)) {
    ctx.status = 403
    ctx.body = { error: 'Managed MCP capability validation is loopback-only' }
    return
  }
  const runtime = getGroupChatRuntimeServer()
  if (!runtime) {
    ctx.status = 503
    ctx.body = { error: 'Managed MCP capability authority is unavailable' }
    return
  }
  const body = (ctx.request.body || {}) as Record<string, unknown>
  try {
    const claims = await authorizeManagedMcpCapability(runtime.getStorage(), {
      token: String(body.capability || ''),
      server: String(body.server || ''),
      toolset: String(body.toolset || ''),
      tool: String(body.tool || ''),
    })
    ctx.body = {
      authorized: true,
      roomId: claims.roomId,
      jobId: claims.jobId,
      profile: claims.profile,
      expiresAt: claims.expiresAt,
    }
  } catch (error) {
    ctx.status = 403
    ctx.body = { error: error instanceof Error ? error.message : 'Managed MCP capability denied' }
  }
}
