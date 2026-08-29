import type { Context } from 'koa'
import { getAgentStatusSnapshot } from '../public/agent-status-registry'

export function status(ctx: Context) {
  ctx.body = getAgentStatusSnapshot()
}
