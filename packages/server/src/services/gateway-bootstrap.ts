let gatewayManager: any = null

export function getGatewayManagerInstance(): any {
  return gatewayManager
}

export async function initGatewayManager(): Promise<void> {
  const { GatewayManager } = await import('./hermes/gateway-manager')
  const { getActiveProfileName } = await import('./hermes/hermes-profile')
  const activeProfile = getActiveProfileName()
  gatewayManager = new GatewayManager(activeProfile)

  await gatewayManager.detectAllOnStartup()
  if (process.env.HERMES_WEB_UI_SKIP_GATEWAY_START?.trim() === '1') {
    console.log('[bootstrap] gateway auto-start skipped')
    return
  }
  await gatewayManager.startAll()
}
