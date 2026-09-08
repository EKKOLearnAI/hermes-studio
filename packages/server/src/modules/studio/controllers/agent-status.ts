import type { Context } from 'koa'
import {
  getAgentAvailabilitySnapshot,
  getAgentStatusSnapshot,
} from '../public/agent-status-registry'

export function availability(ctx: Context) {
  ctx.body = getAgentAvailabilitySnapshot()
}

export function status(ctx: Context) {
  ctx.body = getAgentStatusSnapshot()
}
