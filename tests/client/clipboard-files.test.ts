// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { extractClipboardFiles } from '@/utils/clipboard-files'

function clipboardData(items: Array<{ kind: string; type: string; getAsFile: () => File | null }>, files: File[] = []) {
  return { items, files } as unknown as DataTransfer
}

describe('clipboard file extraction', () => {
  it('keeps pasted non-image files and ignores text clipboard items', () => {
    const documentFile = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const files = extractClipboardFiles(clipboardData([
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'text/plain', getAsFile: () => documentFile },
    ]))

    expect(files).toEqual([documentFile])
  })

  it('gives pasted images unique generated names', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    const image = new File(['image'], 'image.png', { type: 'image/png' })

    const files = extractClipboardFiles(clipboardData([
      { kind: 'file', type: 'image/png', getAsFile: () => image },
    ]))

    expect(files[0]).toMatchObject({ name: 'pasted-1234.png', type: 'image/png' })
  })

  it('falls back to clipboardData.files when item files are unavailable', () => {
    const archive = new File(['zip'], 'archive.zip', { type: 'application/zip' })
    expect(extractClipboardFiles(clipboardData([], [archive]))).toEqual([archive])
  })
})
