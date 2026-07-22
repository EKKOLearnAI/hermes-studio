// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queueBrowserAttachment, takeBrowserAttachments } from '../../packages/client/src/utils/pending-browser-attachments'

describe('pending browser attachments', () => {
  afterEach(() => {
    vi.useRealTimers()
    takeBrowserAttachments()
  })

  it('moves images and structured selection context into the next composer once', () => {
    const file = new File(['image'], 'browser-element.png', { type: 'image/png' })
    queueBrowserAttachment(file, '{"browser_selection":{"mode":"element"}}')

    expect(takeBrowserAttachments()).toEqual({
      files: [file],
      context: ['{"browser_selection":{"mode":"element"}}'],
    })
    expect(takeBrowserAttachments()).toEqual({ files: [], context: [] })
  })

  it('discards an annotation that was not consumed within five minutes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
    queueBrowserAttachment(new File(['png'], 'browser.png', { type: 'image/png' }), 'context')
    vi.advanceTimersByTime(5 * 60 * 1000)

    expect(takeBrowserAttachments()).toEqual({ files: [], context: [] })
  })
})
