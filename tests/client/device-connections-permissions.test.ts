import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('Device connections permissions', () => {
  it('lets authenticated users enter connections while reserving Devices for super admins', () => {
    const router = readFileSync('packages/client/src/router/index.ts', 'utf8')
    const sidebar = readFileSync('packages/client/src/components/layout/PageSidebarNav.vue', 'utf8')
    const panel = readFileSync('packages/client/src/components/hermes/connections/ConnectionsPanel.vue', 'utf8')
    const appRoutes = readFileSync('packages/server/src/routes/app-connections.ts', 'utf8')
    const mcuRoutes = readFileSync('packages/server/src/routes/mcu-devices.ts', 'utf8')
    const deviceRoutes = readFileSync('packages/server/src/routes/devices.ts', 'utf8')

    const connectionsRoute = router.slice(
      router.indexOf("path: '/hermes/connections'"),
      router.indexOf("path: '/hermes/devices'"),
    )
    expect(connectionsRoute).not.toContain('requiresSuperAdmin')
    expect(sidebar).not.toContain('v-if="isSuperAdmin"\n        class="page-sidebar-tab"')
    expect(panel).toContain('value === \'devices\' && isSuperAdmin.value')
    expect(panel).toContain('<NTabPane v-if="isSuperAdmin" name="devices"')
    expect(appRoutes).not.toContain('requireSuperAdmin')
    expect(mcuRoutes).not.toContain('requireSuperAdmin')
    expect(deviceRoutes).toContain('deviceRoutes.use(requireSuperAdmin)')
  })
})
