import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = {
  settings: vi.fn(async (ctx: any) => { ctx.body = { settings: {} } }),
  updateSettings: vi.fn(async (ctx: any) => { ctx.body = { settings: {} } }),
  deliveries: vi.fn(async (ctx: any) => { ctx.body = { deliveries: [] } }),
  testReminder: vi.fn(async (ctx: any) => { ctx.body = { result: {} } }),
}

vi.mock('../../packages/server/src/controllers/hermes/autopilot-reminders', () => handlers)

describe('autopilot reminder routes', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(handlers).forEach(handler => handler.mockClear())
  })

  it('registers autopilot reminder routes', async () => {
    const { autopilotReminderRoutes } = await import('../../packages/server/src/routes/hermes/autopilot-reminders')
    const paths = autopilotReminderRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/autopilot-reminders/settings',
      '/api/hermes/autopilot-reminders/deliveries',
      '/api/hermes/autopilot-reminders/test',
    ]))
  })

  it('delegates each route to the controller', async () => {
    const { autopilotReminderRoutes } = await import('../../packages/server/src/routes/hermes/autopilot-reminders')
    const ctx: any = { params: {}, request: { body: {} }, query: {}, body: null }

    for (const path of [
      '/api/hermes/autopilot-reminders/settings',
      '/api/hermes/autopilot-reminders/deliveries',
      '/api/hermes/autopilot-reminders/test',
    ]) {
      const layer = autopilotReminderRoutes.stack.find((entry: any) => entry.path === path)
      await layer.stack[0](ctx)
    }

    expect(handlers.settings).toHaveBeenCalled()
    expect(handlers.deliveries).toHaveBeenCalled()
    expect(handlers.testReminder).toHaveBeenCalled()
  })

  it('registers PUT settings separately from GET settings', async () => {
    const { autopilotReminderRoutes } = await import('../../packages/server/src/routes/hermes/autopilot-reminders')
    const settingsLayers = autopilotReminderRoutes.stack.filter((entry: any) => entry.path === '/api/hermes/autopilot-reminders/settings')
    const putLayer = settingsLayers.find((entry: any) => entry.methods.includes('PUT'))
    const ctx: any = { params: {}, request: { body: { enabled: true } }, query: {}, body: null }

    await putLayer.stack[0](ctx)

    expect(handlers.updateSettings).toHaveBeenCalledWith(ctx)
  })
})
