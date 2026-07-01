import { describe, expect, it } from 'vitest'
import {
  createMcuSpeechSegmenter,
  normalizeMcuSpeechText,
} from '../../packages/server/src/services/global-agent/mcu-speech-segmenter'

describe('MCU speech segmenter', () => {
  it('waits for markdown links to close before emitting speech', () => {
    const segmenter = createMcuSpeechSegmenter({ maxChars: 24 })

    expect(segmenter.pushDelta('请打开 [控制台')).toEqual([])
    expect(segmenter.pushDelta('](https://example.com)。')).toEqual([
      '请打开 控制台。',
    ])
  })

  it('skips fenced code and table rows when flushing readable text', () => {
    const segmenter = createMcuSpeechSegmenter({ maxChars: 24 })

    const segments = [
      ...segmenter.pushDelta('结果如下：\n```ts\nconst value = 1;\n```\n'),
      ...segmenter.pushDelta('| 名称 | 值 |\n| --- | --- |\n| foo | 1 |\n请确认。'),
    ]
    expect(segments.join(' ')).toContain('结果如下')
    expect(segments.join(' ')).toContain('请确认')
    expect(segments.join(' ')).not.toContain('const value')
    expect(segments.join(' ')).not.toContain('foo')
  })

  it('normalizes markdown without preserving table syntax', () => {
    const normalized = normalizeMcuSpeechText('结果如下：\n| 名称 | 值 |\n| --- | --- |\n| foo | 1 |\n[详情](https://example.com)。参考 https://example.com/a?b=1 和 www.example.com/path')
    expect(normalized).toContain('结果如下')
    expect(normalized).toContain('详情')
    expect(normalized).not.toContain('https')
    expect(normalized).not.toContain('www.')
    expect(normalized).not.toContain('foo')
  })
})
