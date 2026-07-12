// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  createMcuSpeechSegmenter,
  mcuEventsFromRunEvent,
  startMcuVoiceInteraction,
  type McuInteractionTransport,
} from '@/api/hermes/mcu-interaction'
import type { RunEvent } from '@/api/hermes/chat'

describe('mcu interaction helpers', () => {
  it('segments assistant output for speech without tool content', () => {
    const segmenter = createMcuSpeechSegmenter({ maxChars: 24 })

    expect(segmenter.pushDelta('你好，')).toEqual([])
    expect(segmenter.pushDelta('我开始处理了。\n下一步')).toEqual(['你好，我开始处理了。'])
    expect(segmenter.flush()).toBe('下一步')
  })

  it('keeps unfinished paragraphs together and ignores max character soft splits', () => {
    const segmenter = createMcuSpeechSegmenter({ maxChars: 24 })

    expect(segmenter.pushDelta('第一段没结束\n')).toEqual([])
    expect(segmenter.pushDelta('第二段结束了。\n')).toEqual(['第一段没结束 第二段结束了。'])
    expect(segmenter.pushDelta('这是一段很长很长的内容，没有句末换行，也不会按长度提前切')).toEqual([])
    expect(segmenter.pushDelta('，直到段落结束。\n')).toEqual([
      '这是一段很长很长的内容，没有句末换行，也不会按长度提前切，直到段落结束。',
    ])
  })

  it('maps tool events to MCU display events', () => {
    expect(mcuEventsFromRunEvent({
      event: 'tool.started',
      tool: 'browser.search',
      preview: '搜索设备',
    }, 'mcu-session')).toEqual([
      {
        type: 'interaction.status',
        interactionId: 'mcu-session',
        status: 'tool',
        text: 'browser.search',
      },
      {
        type: 'tool.started',
        interactionId: 'mcu-session',
        tool: 'browser.search',
        preview: '搜索设备',
      },
    ])

    expect(mcuEventsFromRunEvent({
      event: 'tool.completed',
      tool: 'browser.search',
    }, 'mcu-session')).toEqual([
      {
        type: 'tool.completed',
        interactionId: 'mcu-session',
        tool: 'browser.search',
      },
      {
        type: 'interaction.status',
        interactionId: 'mcu-session',
        status: 'thinking',
      },
    ])
  })

  it('runs MCU voice interaction without touching the chat store flow', async () => {
    let onRunEvent: ((event: RunEvent) => void) | null = null
    let finishRun: (() => void) | null = null

    const transport: McuInteractionTransport = {
      clearAudio: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      enqueueAudio: vi.fn().mockResolvedValue(undefined),
    }

    const startRun = vi.fn((_body, onEvent, onDone) => {
      onRunEvent = onEvent
      finishRun = onDone
      return { abort: vi.fn() }
    })

    const handle = startMcuVoiceInteraction({
      audio: new Blob(['voice'], { type: 'audio/webm' }),
      sttProvider: 'doubao',
      ttsProvider: 'doubao',
      sessionId: 'mcu-session',
      transport,
      deps: {
        transcribe: vi.fn().mockResolvedValue({
          text: '打开灯',
          provider: 'doubao',
          model: 'test-model',
          durationMs: 12,
        }),
        synthesize: vi.fn().mockResolvedValue({
          audio: new Blob(['mp3'], { type: 'audio/mpeg' }),
          engine: 'doubao',
          provider: 'doubao',
        }),
        startRun,
      },
    })

    await vi.waitFor(() => {
      expect(startRun).toHaveBeenCalledTimes(1)
    })

    expect(startRun.mock.calls[0][0]).toEqual(expect.objectContaining({
      input: '打开灯',
      session_id: 'mcu-session',
      source: 'global_agent',
      session_source: 'global_agent',
    }))

    onRunEvent?.({ event: 'tool.started', tool: 'udp.discovery', preview: '扫描局域网' })
    onRunEvent?.({ event: 'message.delta', delta: '已经找到设备。' })
    finishRun?.()

    await handle.done

    expect(transport.clearAudio).toHaveBeenCalledWith('mcu-session')
    expect(transport.enqueueAudio).toHaveBeenCalledWith(expect.objectContaining({
      interactionId: 'mcu-session',
      segmentId: 'mcu-session-1',
      text: '已经找到设备。',
      mimeType: 'audio/mpeg',
    }))
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool.started',
      tool: 'udp.discovery',
      preview: '扫描局域网',
    }))
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'interaction.status',
      status: 'completed',
    }))
  })
})
