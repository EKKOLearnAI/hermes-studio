// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildContentBlocks, type Attachment } from '../../packages/client/src/stores/hermes/chat'

describe('browser selection attachment context', () => {
  const attachment: Attachment = {
    id: 'browser-1',
    name: 'browser-selection.png',
    type: 'image/png',
    size: 128,
    url: 'blob:browser-selection',
    context: JSON.stringify({ browser_selection: { mode: 'element', region: { x: 10, y: 20, width: 30, height: 40 } } }, null, 2),
  }
  const uploaded = [{ name: attachment.name, path: '/tmp/browser-selection.png' }]

  it('adds tagged JSON to model input without mixing it into the visible text', async () => {
    const blocks = await buildContentBlocks('Make this clearer', [attachment], uploaded)

    expect(blocks[0]).toEqual({ type: 'text', text: 'Make this clearer' })
    expect(blocks[1]).toMatchObject({ type: 'image', context: attachment.context })
    expect(blocks[2]).toEqual({
      type: 'text',
      text: `<browser_selection_context format="json">\n${attachment.context}\n</browser_selection_context>`,
    })
  })

  it('keeps expandable metadata on display input but omits the hidden model text block', async () => {
    const blocks = await buildContentBlocks('Make this clearer', [attachment], uploaded, false)

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: 'Make this clearer' })
    expect(blocks[1]).toMatchObject({ type: 'image', context: attachment.context })
  })
})
