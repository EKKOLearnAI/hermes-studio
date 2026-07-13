import type { Context } from 'koa'
import { listUserProfiles } from '../../db/hermes/users-store'
import {
  createHealthCheckIn,
  createHealthFoodLog,
  createHealthRecord,
  createHealthScaleReading,
  createHealthWorkout,
  getHealthBodyMap,
  getHealthOverview,
  getHealthProfile,
  getTodayHealthPlan,
  listHealthFoodItems,
  listHealthFoodLogs,
  listHealthScaleReadings,
  listHealthRecords,
  listHealthWorkouts,
  updateHealthBodyMap,
  updateHealthProfile,
} from '../../services/hermes/health-state'
import {
  getScaleSyncSettings,
  runScaleSync,
  updateScaleSyncSettings,
} from '../../services/hermes/scale-sync'

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

function bodyFrom(ctx: Context): Record<string, unknown> {
  const body = ctx.request.body
  return body && typeof body === 'object' ? body as Record<string, unknown> : {}
}

export async function overview(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  const includeRecords = ctx.query.includeRecords === 'false' ? false : undefined
  ctx.body = { overview: getHealthOverview({ profile, includeRecords }) }
}

export async function getProfile(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { profile: getHealthProfile(profile) }
}

export async function updateProfile(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { profile: updateHealthProfile(bodyFrom(ctx), actorFrom(ctx), profile) }
}

export async function getBodyMap(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { bodyMap: getHealthBodyMap(profile) }
}

export async function updateBodyMap(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  const body = ctx.request.body
  const bodyMap = Array.isArray(body) ? body : bodyFrom(ctx).bodyMap
  ctx.body = { bodyMap: updateHealthBodyMap(bodyMap, actorFrom(ctx), profile) }
}

export async function listRecords(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { records: listHealthRecords(profile) }
}

export async function createRecord(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { record: createHealthRecord(bodyFrom(ctx), actorFrom(ctx), profile) }
}

export async function createScaleReading(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { reading: createHealthScaleReading(bodyFrom(ctx), actorFrom(ctx), profile) }
}

export async function listScaleReadings(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  const rawLimit = typeof ctx.query.limit === 'string' ? Number(ctx.query.limit) : 20
  ctx.body = listHealthScaleReadings({ profile, limit: Number.isFinite(rawLimit) ? rawLimit : 20 })
}

export async function getScaleSync(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { settings: await getScaleSyncSettings(normalizedProfile(profile)) }
}

export async function updateScaleSync(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { settings: await updateScaleSyncSettings(bodyFrom(ctx), normalizedProfile(profile)) }
}

export async function runScaleSyncNow(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { result: await runScaleSync(normalizedProfile(profile), actorFrom(ctx)) }
}

export async function listWorkouts(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { workouts: listHealthWorkouts(profile) }
}

export async function createWorkout(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { workout: createHealthWorkout(bodyFrom(ctx), actorFrom(ctx), profile) }
}

export async function listFoodItems(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { items: listHealthFoodItems(profile) }
}

export async function listFoodLogs(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { logs: listHealthFoodLogs(profile) }
}

export async function createFoodLog(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { log: createHealthFoodLog(bodyFrom(ctx), actorFrom(ctx), profile) }
}

export async function getTodayPlan(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { plan: getTodayHealthPlan(profile) }
}

export async function createCheckIn(ctx: Context): Promise<void> {
  const profile = profileFrom(ctx)
  if (denyProfileAccess(ctx, profile)) return
  ctx.body = { checkIn: createHealthCheckIn(bodyFrom(ctx), actorFrom(ctx), profile) }
}
