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
    expect(manager).not.toContain('runtimeInstallCompletedHandler')
  })

  it('does not auto-relaunch Desktop after a Runtime download and re-enter a restart loop', () => {
    const bootstrap = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')
    const desktopServer = readFileSync('packages/desktop/src/main/webui-server.ts', 'utf8')
    const desktopMain = readFileSync('packages/desktop/src/main/index.ts', 'utf8')

    expect(bootstrap).not.toContain("getShutdownHandler()('runtime-installed', 75)")
    expect(bootstrap).not.toContain('configureRuntimeInstallCompletedHandler')
    expect(desktopServer).not.toContain('runtimeRestartHandler')
    expect(desktopMain).toContain("ipcMain.handle('hermes-desktop:restart-app'")
  })

  it('routes authenticated App restart requests through the Desktop child IPC channel', () => {
    const routes = readFileSync('packages/server/src/modules/hermes/routes/runtime-versions.ts', 'utf8')
    const restart = readFileSync('packages/server/src/modules/studio/public/web-ui-restart.ts', 'utf8')
    const desktopServer = readFileSync('packages/desktop/src/main/webui-server.ts', 'utf8')
    const desktopMain = readFileSync('packages/desktop/src/main/index.ts', 'utf8')

    expect(routes).toContain("post('/api/hermes/runtime-versions/restart-webui', requireSuperAdmin")
    expect(restart).toContain("process.send({ type: DESKTOP_RESTART_REQUEST })")
    expect(desktopServer).toContain("stdio: ['ignore', 'pipe', 'pipe', 'ipc']")
    expect(desktopServer).toContain("launchedProc.on('message'")
    expect(desktopMain).toContain('setWebUiRestartRequestHandler(() => {')
    expect(desktopMain).toContain('scheduleAppRestart(250)')
  })

  it('routes source-development restarts through a nodemon watched trigger', () => {
    const restart = readFileSync('packages/server/src/modules/studio/public/web-ui-restart.ts', 'utf8')
    const trigger = readFileSync('packages/server/src/modules/studio/public/dev-restart-trigger.ts', 'utf8')
    const nodemon = readFileSync('nodemon.json', 'utf8')

    expect(restart).toContain("process.env.NODE_ENV === 'development'")
    expect(restart).toContain('utimesSync(trigger, now, now)')
    expect(trigger).toContain('nodemon')
    expect(nodemon).toContain('"watch": ["packages/server/src"')
  })

  it('gates Gateway and bridge startup on the probed in-memory Hermes inventory', () => {
    const bootstrap = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')

    expect(bootstrap).toContain('const hermesAgentAvailable = isHermesAgentAvailable()')
    expect(bootstrap).toContain('startRuntimeServicesBeforeListen(hermesAgentAvailable)')
    expect(bootstrap).toContain('startRuntimeServicesAfterListen(hermesAgentAvailable)')
    expect(bootstrap).toContain('Hermes Agent unavailable; skipping profile gateways and agent bridge')
  })
})
