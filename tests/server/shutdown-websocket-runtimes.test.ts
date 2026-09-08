import { EventEmitter } from 'events'
import type { Server as HttpServer } from 'http'
import { describe, expect, it } from 'vitest'
import { setupKanbanEventsWebSocket } from '../../packages/server/src/modules/hermes/sockets/kanban-events'

describe('shutdown-owned WebSocket runtimes', () => {
  it('detaches the Kanban upgrade handler and closes idempotently', async () => {
    const httpServer = new EventEmitter() as HttpServer
    const runtime = setupKanbanEventsWebSocket(httpServer)

    expect(httpServer.listenerCount('upgrade')).toBe(1)

    await Promise.all([runtime.close(), runtime.close()])

    expect(httpServer.listenerCount('upgrade')).toBe(0)
  })
})
