import { describe, expect, it } from 'vitest'
import { getClipboardPathForEntry } from '@/utils/file-path'

const baseEntry = {
  name: 'app.log',
  path: 'logs/app.log',
  isDir: false,
  size: 12,
  modTime: '2026-05-20T00:00:00.000Z',
}

describe('file path clipboard helpers', () => {
  it('prefers absolute path metadata when available', () => {
    expect(getClipboardPathForEntry({
      ...baseEntry,
      absolutePath: '/home/agent/.hermes/logs/app.log',
    })).toBe('/home/agent/.hermes/logs/app.log')
  })

  it('falls back to the relative operation path for older API responses', () => {
    expect(getClipboardPathForEntry(baseEntry)).toBe('logs/app.log')
  })
})
