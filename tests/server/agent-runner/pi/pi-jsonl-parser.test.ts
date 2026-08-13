import { PassThrough } from 'stream'
import { describe, expect, it } from 'vitest'
import { attachPiJsonlReader } from '../../../../packages/server/src/services/agent-runner/pi/pi-jsonl-parser'

describe('attachPiJsonlReader', () => {
  it('splits records only on LF and preserves Unicode separators inside JSON strings', () => {
    const stream = new PassThrough()
    const values: any[] = []
    attachPiJsonlReader(stream, value => values.push(value))

    stream.write(Buffer.from('{"text":"before\u2028after"}\n{"ok":'))
    stream.end(Buffer.from('true}\r\n'))

    expect(values).toEqual([
      { text: 'before\u2028after' },
      { ok: true },
    ])
  })

  it('handles UTF-8 characters split across chunks', () => {
    const stream = new PassThrough()
    const values: any[] = []
    attachPiJsonlReader(stream, value => values.push(value))
    const encoded = Buffer.from('{"text":"你好"}\n')

    stream.write(encoded.subarray(0, encoded.length - 3))
    stream.end(encoded.subarray(encoded.length - 3))

    expect(values).toEqual([{ text: '你好' }])
  })
})
