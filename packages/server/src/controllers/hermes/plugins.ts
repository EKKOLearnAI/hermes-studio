import { listHermesPlugins } from '../../services/hermes/plugins'

export async function list(ctx: any) {
  try {
    ctx.body = await listHermesPlugins()
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to discover Hermes plugins' }
  }
}
