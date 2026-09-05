import { createServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { expect, it, vi } from 'vitest'
import { startAppRelayClient, stopAppRelayClient } from '../../packages/server/src/modules/studio/services/app-relay/client'

vi.mock('../../packages/server/src/modules/studio/public/system-info', () => ({
  createDeviceSignature: async () => 'test-signature',
}))

it('keeps Agent payloads intact across a real Socket.IO connection with recovery enabled', async () => {
  const targetHttp = createServer()
  const cloudHttp = createServer()
  const target = new Server(targetHttp, { connectionStateRecovery: {} })
  const cloud = new Server(cloudHttp)
  const agent = { agent: 'hermes', profile: 'default', name: 'Remote Agent' }
  const ready = { connectorId: 'connector-1', agent }
  const run = { runId: 'run-1', room: { id: 'room-1' } }
  const forwarded: Array<{ event: string; payload: unknown }> = []
  let relaySocket: Socket | undefined
  const batches: unknown[] = []
  target.of('/group-chat-agent-relay').on('connection', socket => {
    relaySocket = socket
    socket.on('agent.events', (batch, ack) => { batches.push(batch); ack({ ok: true }) })
    socket.emit('relay.ready', ready)
    socket.emit('run.request', run)
  })
  let host: Socket | undefined
  cloud.of('/app-relay').on('connection', socket => {
    host = socket
    socket.on('app.socket.event', (event, ack) => {
      forwarded.push(event)
      if (event.event === 'approval.respond') ack?.({ ok: true })
    })
  })
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  try {
    const targetOrigin = await listen(targetHttp)
    const cloudOrigin = await listen(cloudHttp)
    startAppRelayClient({ relayUrl: cloudOrigin, machineId: 'hwui_machine_1234567890', publicKey: 'test-key', localBaseUrl: targetOrigin })
    await vi.waitFor(() => expect(host?.connected).toBe(true))
    const opened = await new Promise(resolve => host!.emit('app.socket.open', {
      id: 'agent-bridge', namespace: '/group-chat-agent-relay', stream: true,
    }, resolve))
    expect(opened).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(forwarded).toContainEqual(expect.objectContaining({ event: 'run.request', payload: run })))
    expect(forwarded).toContainEqual(expect.objectContaining({ event: 'relay.ready', payload: ready }))
    const batch = { events: [{ runId: 'run-1', seq: 1, event: 'message_reasoning_delta', data: { id: 'm', delta: '思考' } }] }
    const batchAck = await new Promise(resolve => host!.emit('app.socket.event', {
      id: 'agent-bridge', event: 'agent.events', payload: batch, ack: true, stream: true,
    }, resolve))
    expect(batchAck).toMatchObject({ ok: true, payload: { ok: true } })
    expect(batches).toEqual([batch])
    const approvalAck = vi.fn()
    relaySocket!.emit('approval.respond', { decision: 'allow' }, approvalAck)
    await vi.waitFor(() => expect(approvalAck).toHaveBeenCalledWith({ ok: true }))
    expect(forwarded).toContainEqual(expect.objectContaining({ event: 'approval.respond', payload: { decision: 'allow' } }))
  } finally {
    stopAppRelayClient()
    await Promise.all([new Promise<void>(resolve => target.close(() => resolve())), new Promise<void>(resolve => cloud.close(() => resolve()))])
  }
})
