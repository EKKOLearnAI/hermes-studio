import type { Context } from 'koa'
import { listUserProfiles } from '../../db/hermes/users-store'
import {
  dispatchAutopilotReminder,
  getReminderSettings,
  listRecentReminderDeliveries,
  updateReminderSettings,
} from '../../services/hermes/autopilot-reminders'

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

function bodyFrom(ctx: Context): Record<string, unknown> {
  const body = ctx.request.body
  return body && typeof body === 'object' ? body as Record<string, unknown> : {}
}

function limitFrom(ctx: Context): number {
  const parsed = typeof ctx.query.limit === 'string' ? Number.parseInt(ctx.query.limit, 10) : 20
  return Number.isFinite(parsed) ? parsed : 20
}

export async function settings(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { settings: getReminderSettings(normalizedProfile(profile)) }
}

export async function updateSettings(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { settings: updateReminderSettings(normalizedProfile(profile), bodyFrom(ctx)) }
}

export async function deliveries(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { deliveries: listRecentReminderDeliveries(normalizedProfile(profile), limitFrom(ctx)) }
}

export async function testReminder(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { result: await dispatchAutopilotReminder({ profile: normalizedProfile(profile), force: true }) }
}
