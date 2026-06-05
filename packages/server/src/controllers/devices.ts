import { getLanDiscoveryCache, scanLanDevices } from '../services/lan-discovery'

export async function listDevices(ctx: any) {
  ctx.body = getLanDiscoveryCache()
}

export async function scanDevices(ctx: any) {
  ctx.body = await scanLanDevices()
}
