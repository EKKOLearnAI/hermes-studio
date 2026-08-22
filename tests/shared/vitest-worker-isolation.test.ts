import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Vitest worker state isolation', () => {
  it('assigns each worker an isolated Web UI state directory', () => {
    const appHome = process.env.HERMES_WEB_UI_HOME

    expect(appHome).toBeTruthy()
    expect(process.env.HERMES_WEBUI_STATE_DIR).toBe(appHome)
    expect(process.env.UPLOAD_DIR).toBe(join(appHome!, 'upload'))
    expect(appHome).toContain(`hermes-studio-vitest-${process.pid}-`)
  })
})
