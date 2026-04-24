// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { streamRunEvents, type RunEvent } from '@/api/hermes/chat'

class MockEventSource {
  static instances: MockEventSource[] = []

  url: string
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  emit(data: string) {
    this.onmessage?.({ data })
  }

  fail() {
    this.onerror?.()
  }
}

describe('streamRunEvents', () => {
  beforeEach(() => {
    window.localStorage.clear()
    MockEventSource.instances = []
    vi.stubGlobal('EventSource', MockEventSource)
  })

  it('maps non-JSON EventSource data to message.delta so raw text is rendered', () => {
    const events: RunEvent[] = []

    streamRunEvents('run-raw', event => events.push(event), vi.fn(), vi.fn())
    MockEventSource.instances[0].emit('原因：raw fallback')

    expect(events).toEqual([{ event: 'message.delta', delta: '原因：raw fallback' }])
  })

  it('parses colon-containing JSON deltas and closes on completion', () => {
    const events: RunEvent[] = []
    const onDone = vi.fn()

    streamRunEvents('run-json', event => events.push(event), onDone, vi.fn())
    const source = MockEventSource.instances[0]
    source.emit(JSON.stringify({ event: 'message.delta', delta: '让我直接读文件：A: B' }))
    source.emit(JSON.stringify({ event: 'run.completed' }))

    expect(events).toEqual([
      { event: 'message.delta', delta: '让我直接读文件：A: B' },
      { event: 'run.completed' },
    ])
    expect(source.close).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
