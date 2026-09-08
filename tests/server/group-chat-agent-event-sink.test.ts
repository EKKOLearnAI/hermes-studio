import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OutboundRelayEventSink, supportsAgentEventBatching } from '../../packages/server/src/modules/studio/services/group-chat/agent-relay-event-sink'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function harness(batching = true) {
  const packets: Array<{ event: string; payload: any; ack: (error: Error | null, response?: any) => void }> = []
  const socket: any = { connected: true, id: 'source', timeout: () => socket,
    emit: (event: string, payload: any, ack: any) => packets.push({ event, payload, ack }) }
  const failed = vi.fn()
  const sink = new OutboundRelayEventSink(socket, data => data, failed)
  sink.setBatching(batching)
  sink.begin('run-1')
  return { sink, socket, packets, failed }
}

it('batches a burst at the source and sends the next packet only after target acknowledgement', async () => {
  const { sink, packets } = harness()
  for (let i = 0; i < 1000; i++) sink.emit('message_reasoning_delta', { id: 'message', delta: '字' })
  expect(packets).toHaveLength(1)
  const drained = sink.drain()
  const sequences: number[] = []
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i]
    expect(Buffer.byteLength(JSON.stringify(packet.payload))).toBeLessThanOrEqual(16 * 1024)
    sequences.push(...(packet.event === 'agent.events' ? packet.payload.events : [packet.payload]).map((event: any) => event.seq))
    packet.ack(null, { ok: true })
  }
  await drained
  expect(sequences).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1))
  expect(packets.length).toBeLessThan(25)
  sink.end('run-1')
})

it('flushes sparse output within 40 ms and flushes approval events without another batching delay', async () => {
  const { sink, packets } = harness()
  sink.emit('message_stream_start', { id: 'm' })
  await vi.advanceTimersByTimeAsync(39)
  expect(packets).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(packets).toHaveLength(1)
  packets[0].ack(null, { ok: true })
  sink.emit('message_reasoning_delta', { id: 'm', delta: 'thinking' })
  sink.emit('approval.requested', { approval_id: 'approval' })
  expect(packets).toHaveLength(2)
  expect(packets[1].payload.events.map((event: any) => event.event)).toEqual(['message_reasoning_delta', 'approval.requested'])
  packets[1].ack(null, { ok: true })
  sink.end('run-1')
})

it('waits for the final message and trailing stream end to be acknowledged before draining', async () => {
  const { sink, packets } = harness()
  sink.emit('message_reasoning_delta', { id: 'm', delta: 'thought' })
  const saved = sink.sendMessage('room', 'answer', 'm')
  sink.emit('message_stream_end', { id: 'm' })
  const finished = vi.fn()
  const drained = sink.drain().then(finished)
  expect(packets).toHaveLength(1)
  packets[0].ack(null, { ok: true })
  await expect(saved).resolves.toBe('m')
  expect(finished).not.toHaveBeenCalled()
  expect(packets).toHaveLength(2)
  packets[1].ack(null, { ok: true })
  await drained
  expect(finished).toHaveBeenCalledOnce()
  sink.end('run-1')
})

it('negotiates both cloud and target capabilities and serializes legacy single events', async () => {
  expect(supportsAgentEventBatching({}, false)).toBe(false)
  expect(supportsAgentEventBatching({ capabilities: ['agent.events.v1'] }, false)).toBe(true)
  expect(supportsAgentEventBatching({ capabilities: ['agent.events.v1'] }, true)).toBe(false)
  expect(supportsAgentEventBatching({ capabilities: ['agent.events.v1'], relayCapabilities: ['agent.events.v1'] }, true)).toBe(true)
  const { sink, packets } = harness(false)
  sink.emit('message_stream_start', { id: 'm' })
  sink.emit('message_stream_delta', { id: 'm', delta: 'answer' })
  expect(packets).toHaveLength(1)
  packets[0].ack(null, { ok: true })
  expect(packets).toHaveLength(2)
  expect(packets.every(packet => packet.event === 'agent.event')).toBe(true)
  packets[1].ack(null, { ok: true })
  await sink.drain()
  sink.end('run-1')
})

it('bounds pending output and explicitly fails instead of silently dropping sequence numbers', async () => {
  const { sink, packets, failed } = harness()
  for (let i = 0; i < 2200; i++) sink.emit('message_stream_delta', { id: 'm', delta: 'x' })
  expect(packets).toHaveLength(1)
  expect(failed).toHaveBeenCalledOnce()
  await expect(sink.drain()).rejects.toThrow('queue limit')
  sink.end('run-1')
})

it('rejects queued final messages on failure and ignores late ACKs from a previous run', async () => {
  const { sink, packets, failed } = harness()
  const saved = sink.sendMessage('room', 'old answer', 'old')
  const rejected = expect(saved).rejects.toThrow('timed out')
  packets[0].ack(new Error('timeout'))
  await rejected
  expect(failed).toHaveBeenCalledOnce()
  sink.begin('run-2')
  const next = sink.sendMessage('room', 'new answer', 'new')
  packets[0].ack(null, { ok: true })
  expect(packets[1].payload).toMatchObject({ runId: 'run-2', seq: 1 })
  packets[1].ack(null, { ok: true })
  await expect(next).resolves.toBe('new')
  sink.end('run-2')
})
