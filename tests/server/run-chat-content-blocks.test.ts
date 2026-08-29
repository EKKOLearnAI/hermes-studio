import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  convertContentBlocks,
  convertContentBlocksForAgent,
  convertContentBlocksForCodingAgent,
} from '../../packages/server/src/modules/studio/services/chat-run/content-blocks'

let tempDir = ''

describe('run chat content blocks', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hermes-content-blocks-'))
  })

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it('keeps API image conversion as base64 input_image only', async () => {
    const imagePath = join(tempDir, 'image.png')
    await writeFile(imagePath, Buffer.from([1, 2, 3]))

    const parts = await convertContentBlocks([
      { type: 'text', text: 'animate this' },
      { type: 'image', name: 'image.png', path: imagePath, media_type: 'image/png' },
    ])

    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'input_text', text: 'animate this' })
    expect(parts[1].type).toBe('input_image')
    expect(parts[1].image_url).toMatch(/^data:image\/png;base64,/)
    expect(JSON.stringify(parts)).not.toContain('Local image path for tools')
  })

  it('adds local file path text for bridge agents while preserving the image data', async () => {
    const imagePath = join(tempDir, 'image.png')
    await writeFile(imagePath, Buffer.from([1, 2, 3]))

    const parts = await convertContentBlocksForAgent([
      { type: 'text', text: 'animate this' },
      { type: 'image', name: 'image.png', path: imagePath, media_type: 'image/png' },
    ])

    expect(parts).toHaveLength(3)
    expect(parts[0]).toEqual({ type: 'text', text: 'animate this' })
    expect(parts[1]).toEqual({
      type: 'text',
      text: `[Attached image: image.png]\nLocal image path for tools: ${imagePath}`,
    })
    expect(parts[2].type).toBe('image_url')
    expect(parts[2].image_url?.url).toMatch(/^data:image\/png;base64,/)
  })

  it('separates coding-agent prompt text from native image attachments', () => {
    const imagePath = join(tempDir, 'image.png')

    expect(convertContentBlocksForCodingAgent([
      { type: 'text', text: '  inspect this  ' },
      { type: 'image', name: 'image.png', path: imagePath, media_type: 'image/png' },
      { type: 'file', name: 'notes.txt', path: join(tempDir, 'notes.txt'), media_type: 'text/plain' },
    ])).toEqual({
      text: [
        'inspect this',
        `[Attached image: image.png]\nLocal image path for tools: ${imagePath}`,
        `[Attached file: notes.txt]\nLocal file path for tools: ${join(tempDir, 'notes.txt')}`,
      ].join('\n\n'),
      images: [{
        name: 'image.png',
        path: imagePath,
        mediaType: 'image/png',
      }],
    })
  })

  it('labels representative video frames for API, bridge, and coding-agent inputs', async () => {
    const framePath = join(tempDir, 'clip-video-frame-01.jpg')
    await writeFile(framePath, Buffer.from([1, 2, 3]))
    const block = {
      type: 'image' as const,
      name: 'clip-video-frame-01.jpg',
      path: framePath,
      media_type: 'image/jpeg',
      video_frame: true,
    }
    const label = '[Representative frame extracted from the attached video: clip-video-frame-01.jpg]'

    const apiParts = await convertContentBlocks([block])
    expect(apiParts).toHaveLength(2)
    expect(apiParts[0]).toEqual({ type: 'input_text', text: label })
    expect(apiParts[1].type).toBe('input_image')

    const agentParts = await convertContentBlocksForAgent([block])
    expect(agentParts[0]).toEqual({
      type: 'text',
      text: `${label}\nLocal image path for tools: ${framePath}`,
    })
    expect(agentParts[1].type).toBe('image_url')

    expect(convertContentBlocksForCodingAgent([block])).toMatchObject({
      text: `${label}\nLocal image path for tools: ${framePath}`,
      images: [{ path: framePath, mediaType: 'image/jpeg' }],
    })
  })
})
