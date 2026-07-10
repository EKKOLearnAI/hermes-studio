import type { Context } from 'koa'
import {
  getPersonalTwinContext, getPersonalTwinOverview, listTwinEntities, listTwinEvents,
  listTwinObservations, syncLegacyTwinSources,
} from '../../services/hermes/personal-twin'

function stringQuery(ctx: Context, key: string): string | undefined {
  const value = ctx.query[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function integerQuery(ctx: Context, key: string): number | undefined {
  const raw = stringQuery(ctx, key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  return Math.max(1, Math.min(200, Math.floor(value)))
}

export async function overview(ctx: Context): Promise<void> {
  ctx.body = { overview: getPersonalTwinOverview() }
}

export async function entities(ctx: Context): Promise<void> {
  ctx.body = { entities: listTwinEntities({ type: stringQuery(ctx, 'type'), source: stringQuery(ctx, 'source'), limit: integerQuery(ctx, 'limit') }) }
}

export async function observations(ctx: Context): Promise<void> {
  ctx.body = { observations: listTwinObservations({ entityId: stringQuery(ctx, 'entityId'), metric: stringQuery(ctx, 'metric'), limit: integerQuery(ctx, 'limit') }) }
}

export async function events(ctx: Context): Promise<void> {
  ctx.body = { events: listTwinEvents({ subjectId: stringQuery(ctx, 'subjectId'), eventType: stringQuery(ctx, 'eventType'), limit: integerQuery(ctx, 'limit') }) }
}

export async function context(ctx: Context): Promise<void> {
  const domains = stringQuery(ctx, 'domains')?.split(',').map(value => value.trim()).filter(Boolean)
  ctx.body = { context: getPersonalTwinContext({ domains, query: stringQuery(ctx, 'query'), limit: integerQuery(ctx, 'limit') }) }
}

export async function importLegacy(ctx: Context): Promise<void> {
  const body = ctx.request.body as { profiles?: unknown } | undefined
  let profiles: string[] | undefined
  if (body && Object.prototype.hasOwnProperty.call(body, 'profiles')) {
    if (!Array.isArray(body.profiles) || body.profiles.some(profile => typeof profile !== 'string')) {
      ctx.status = 400
      ctx.body = { error: 'profiles must be an array of strings' }
      return
    }
    profiles = [...new Set(body.profiles.map(profile => profile.trim()).filter(Boolean))]
  }
  ctx.body = { result: syncLegacyTwinSources({ profiles }) }
}
