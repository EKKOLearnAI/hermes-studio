// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserAnnotationAttachment } from '../../packages/client/src/utils/browser-annotation-submit'

describe('browser annotation submission', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:browser-annotation'),
    })
  })

  it('builds a sendable attachment without staging it in the composer', () => {
    const file = new File(['image'], 'browser-annotations.png', { type: 'image/png' })
    const attachment = createBrowserAnnotationAttachment({
      file,
      context: '  {"browser_selection":{"annotations":[]}}  ',
    })

    expect(attachment).toMatchObject({
      name: 'browser-annotations.png',
      type: 'image/png',
      size: file.size,
      url: 'blob:browser-annotation',
      file,
      context: '{"browser_selection":{"annotations":[]}}',
    })
    expect(attachment.id).toBeTruthy()
  })
})
