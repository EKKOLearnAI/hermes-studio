import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('desktop Runtime bootstrap', () => {
  it('starts Studio without requiring Runtime and keeps explicit Runtime automation', () => {
    const source = readFileSync(resolve(process.cwd(), 'packages/desktop/src/main/index.ts'), 'utf8')
    const bootstrap = source.slice(
      source.indexOf('async function bootstrap('),
      source.indexOf("ipcMain.handle('hermes-desktop:get-token'"),
    )

    expect(bootstrap).toContain('const explicitRuntimeRequest =')
    expect(bootstrap).toContain('if (needsRuntimeWork && explicitRuntimeRequest)')
    expect(bootstrap).toContain('await ensureDesktopRuntime(updateSplash, selectedSource)')
    expect(bootstrap).not.toContain('await mainWindow.loadURL(runtimeSourceHtml())')
    expect(bootstrap.indexOf('await startWebUiServer(PORT)')).toBeGreaterThan(
      bootstrap.indexOf('if (needsRuntimeWork && explicitRuntimeRequest)'),
    )
  })

  it('selects Hermes before constructing the Web UI Server environment', () => {
    const source = readFileSync(resolve(process.cwd(), 'packages/desktop/src/main/webui-server.ts'), 'utf8')
    const start = source.slice(
      source.indexOf('export async function startWebUiServer'),
      source.indexOf('async function launchWebUiServer'),
    )

    expect(start.indexOf('await resolveDesktopHermesSelection')).toBeGreaterThan(-1)
    expect(start.indexOf('withDesktopHermesSelection')).toBeGreaterThan(
      start.indexOf('await resolveDesktopHermesSelection'),
    )
    expect(start).not.toContain('HERMES_BIN: hermesBin()')
  })
})
