import { describe, expect, it } from 'vitest'

import {
  normalizeMessageContentForStorage,
  normalizeMessageContentForStorageRole,
} from '../../packages/server/src/db/hermes/message-content'

describe('message content normalization', () => {
  it('summarizes multimodal envelopes without persisting base64 images', () => {
    const content = {
      _multimodal: true,
      content: [
        { type: 'text', text: 'Image loaded into context.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }

    const normalized = normalizeMessageContentForStorage(JSON.stringify(content))

    expect(normalized).toBe('Image loaded into context.\n[screenshot]')
    expect(normalized).not.toContain('data:image/')
    expect(normalized).not.toContain('AAAA')
  })

  it('summarizes OpenAI-style content part arrays', () => {
    const normalized = normalizeMessageContentForStorage([
      { type: 'text', text: 'Question: what is shown?' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB' },
    ])

    expect(normalized).toBe('Question: what is shown?\n[screenshot]')
  })

  it('redacts nested data images in non-envelope JSON without dropping other fields', () => {
    const normalized = normalizeMessageContentForStorage(JSON.stringify({
      output: {
        url: 'data:image/png;base64,CCCC',
        status: 'ok',
      },
    }))

    expect(JSON.parse(normalized)).toEqual({
      output: {
        url: '[screenshot]',
        status: 'ok',
      },
    })
  })

  it('does not parse or rewrite unrelated JSON strings', () => {
    const content = '{\n  "type": "event",\n  "payload": "ok"\n}'

    expect(normalizeMessageContentForStorage(content)).toBe(content)
  })

  it('keeps user-authored image data untouched and only cleans non-user messages', () => {
    const content = '{"content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,DDDD"}}]}'

    expect(normalizeMessageContentForStorageRole('user', content)).toBe(content)
    expect(normalizeMessageContentForStorageRole('tool', content)).not.toContain('data:image/')
  })
})
