import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'

export async function list(ctx: any) {
  const mgr = getGatewayManagerInstance()
  if (!mgr) { ctx.status = 503; ctx.body = { error: 'GatewayManager not initialized' }; return }
  const gateways = await mgr.listAll()
  ctx.body = { gateways }
}

export async function start(ctx: any) {
  const mgr = getGatewayManagerInstance()
  if (!mgr) { ctx.status = 503; ctx.body = { error: 'GatewayManager not initialized' }; return }
  try {
    const status = await mgr.start(ctx.params.name)
    ctx.body = { success: true, gateway: status }
  } catch (err: any) { ctx.status = 500; ctx.body = { error: err.message } }
}

export async function stop(ctx: any) {
  const mgr = getGatewayManagerInstance()
  if (!mgr) { ctx.status = 503; ctx.body = { error: 'GatewayManager not initialized' }; return }
  try {
    await mgr.stop(ctx.params.name)
    ctx.body = { success: true }
  } catch (err: any) { ctx.status = 500; ctx.body = { error: err.message } }
}

export async function health(ctx: any) {
  const mgr = getGatewayManagerInstance()
  if (!mgr) { ctx.status = 503; ctx.body = { error: 'GatewayManager not initialized' }; return }
  const status = await mgr.detectStatus(ctx.params.name)
  ctx.body = { gateway: status }
}
