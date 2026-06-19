import type { Context } from 'koa'
import {
  approvePersonalStateProposal,
  checkInPersonalStateTask,
  getPersonalStateOverview,
  rejectPersonalStateProposal,
} from '../../services/hermes/personal-state'
import { listUserProfiles } from '../../db/hermes/users-store'

function profileFrom(ctx: Context): string | undefined {
  const queryProfile = typeof ctx.query.profile === 'string' ? ctx.query.profile : undefined
  const stateProfile = ctx.state?.profile?.name
  return queryProfile || stateProfile
}

function normalizedProfile(profile: string | undefined): string {
  return profile?.trim() || 'default'
}

function allowedProfileSet(ctx: Context): Set<string> | null {
  const user = ctx.state?.user
  if (!user || user.role === 'super_admin') return null
  return new Set(listUserProfiles(user.id).map(profile => profile.profile_name))
}

function denyProfileAccess(ctx: Context, profile: string | undefined): boolean {
  const allowed = allowedProfileSet(ctx)
  const name = normalizedProfile(profile)
  if (!allowed || allowed.has(name)) return false
  ctx.status = 403
  ctx.body = { error: `Profile "${name}" is not available for this user` }
  return true
}

function actorFrom(ctx: Context): string {
  const body = ctx.request.body as { actor?: unknown } | undefined
  const user = ctx.state?.user
  if (typeof body?.actor === 'string' && body.actor.trim()) return body.actor.trim()
  if (typeof user?.username === 'string' && user.username.trim()) return user.username.trim()
  return 'user'
}

function notFoundOrThrow(ctx: Context, error: unknown): void {
  if (error instanceof Error && error.message.includes('not found')) {
    ctx.status = 404
    ctx.body = { error: error.message }
    return
  }
  throw error
}

export async function overview(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  const query = typeof ctx.query.query === 'string' ? ctx.query.query : undefined
  ctx.body = { overview: getPersonalStateOverview({ profile, query }) }
}

export async function approve(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  try {
    ctx.body = { proposal: approvePersonalStateProposal(ctx.params.id, actorFrom(ctx), profile) }
  } catch (error) {
    notFoundOrThrow(ctx, error)
  }
}

export async function reject(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  try {
    ctx.body = { proposal: rejectPersonalStateProposal(ctx.params.id, actorFrom(ctx), profile) }
  } catch (error) {
    notFoundOrThrow(ctx, error)
  }
}

export async function checkInTask(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  try {
    ctx.body = { task: checkInPersonalStateTask(ctx.params.id, actorFrom(ctx), profile) }
  } catch (error) {
    notFoundOrThrow(ctx, error)
  }
}
