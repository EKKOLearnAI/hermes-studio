import type { Context } from 'koa'
import { fetchPetdexManifest } from '../../services/hermes/petdex'

export async function manifest(ctx: Context) {
  const force = ctx.query.force === '1' || ctx.query.force === 'true'
  ctx.body = await fetchPetdexManifest({ force })
}
