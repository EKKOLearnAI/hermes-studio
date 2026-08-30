import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('Runtime install restart wiring', () => {
  it('activates Runtime before completing the job and refreshes in-memory Agent status', () => {
    const manager = readFileSync('packages/server/src/modules/hermes/services/runtime/version-manager.ts', 'utf8')
    const completion = manager.slice(
      manager.indexOf("if (kind === 'runtime') {", manager.indexOf('runner(cleanVersion')),
      manager.indexOf("job.status = 'completed'", manager.indexOf('runner(cleanVersion')),
    )

    expect(completion).toContain('activateInstalledRuntimeVersion(result.version)')
    expect(completion).toContain("getRuntimeVersionStatus({ includeRemote: false })")
    expect(manager).toContain('runtimeInstallCompletedHandler(result as InstalledRuntimeVersion)')
  })

  it('restarts standalone Web UI and exits Desktop Web UI with the relaunch code', () => {
    const bootstrap = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')
    const desktopServer = readFileSync('packages/desktop/src/main/webui-server.ts', 'utf8')
    const desktopMain = readFileSync('packages/desktop/src/main/index.ts', 'utf8')

    expect(bootstrap).toContain("getShutdownHandler()('runtime-installed', 75)")
    expect(bootstrap).toContain('scheduleWebUiRestart()')
    expect(desktopServer).toContain('if (code === 75) {')
    expect(desktopServer).toContain('runtimeRestartHandler?.()')
    expect(desktopMain).toContain('setWebUiRuntimeRestartHandler(() => {')
    expect(desktopMain).toContain('app.relaunch()')
    expect(desktopMain).toContain('quitApp()')
  })

  it('gates Gateway and bridge startup on the probed in-memory Hermes inventory', () => {
    const bootstrap = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')

    expect(bootstrap).toContain('const hermesAgentAvailable = isHermesAgentAvailable()')
    expect(bootstrap).toContain('startRuntimeServicesBeforeListen(hermesAgentAvailable)')
    expect(bootstrap).toContain('startRuntimeServicesAfterListen(hermesAgentAvailable)')
    expect(bootstrap).toContain('Hermes Agent unavailable; skipping profile gateways and agent bridge')
  })
})
