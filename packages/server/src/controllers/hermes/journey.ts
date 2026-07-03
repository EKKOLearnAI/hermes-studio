import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { getJourneyGraph } from '../../services/hermes/journey'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

export async function graph(ctx: any) {
  try {
    ctx.body = await getJourneyGraph(requestedProfile(ctx))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: { message: err?.message || String(err) } }
  }
}
