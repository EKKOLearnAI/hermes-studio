import type { Context } from 'koa'
import { listUserProfiles } from '../../db/hermes/users-store'
import { getPersonalAutopilotOverview } from '../../services/hermes/personal-autopilot'

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

export async function overview(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { overview: getPersonalAutopilotOverview({ profile }) }
}
