import type { ContentBlock } from './types'

/**
 * Convert ContentBlock[] to string for display/storage
 */
export function contentBlocksToString(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input
  return JSON.stringify(input)
}

/**
 * Extract text content from ContentBlock[] for title preview
 */
export function extractTextForPreview(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input
  return input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Check if input is ContentBlock array
 */
export function isContentBlockArray(input: any): input is ContentBlock[] {
  return Array.isArray(input) && input.length > 0 && ('type' in input[0])
}

/**
 * Convert ContentBlock[] to multimodal format for /v1/responses API.
 */
export async function convertContentBlocks(blocks: ContentBlock[]): Promise<Array<{ type: string; text?: string; image_url?: string }>> {
  const parts: Array<{ type: string; text?: string; image_url?: string }> = []
  const fs = await import('fs/promises')
  const path = await import('path')

  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      try {
        const buf = await fs.readFile(block.path)
        const ext = path.extname(block.path).toLowerCase().replace('.', '')
        const mime = ext === 'jpg' ? 'jpeg' : ext || 'png'
        const base64 = buf.toString('base64')
        parts.push({ type: 'input_image', image_url: `data:image/${mime};base64,${base64}` })
      } catch {
        parts.push({ type: 'input_text', text: `[Image: ${block.path}]` })
      }
    } else if (block.type === 'file') {
      parts.push({ type: 'input_text', text: `[File: ${block.name || block.path}]` })
    }
  }

  return parts
}

/**
 * Convert ContentBlock[] to the normalized multimodal shape Hermes agent
 * receives after /v1/responses input normalization.
 */
export async function convertContentBlocksForAgent(blocks: ContentBlock[]): Promise<Array<{ type: string; text?: string; image_url?: { url: string } }>> {
  const responseParts = await convertContentBlocks(blocks)
  return responseParts.map((part) => {
    if (part.type === 'input_text') {
      return { type: 'text', text: part.text || '' }
    }
    if (part.type === 'input_image') {
      return { type: 'image_url', image_url: { url: part.image_url || '' } }
    }
    return { type: 'text', text: part.text || '' }
  })
}
