// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isVideoFile, representativeVideoFrameTimes } from '@/utils/video-frame-extraction'

describe('video frame extraction helpers', () => {
  it('recognizes videos by MIME type or common file extension', () => {
    expect(isVideoFile(new File([], 'clip.bin', { type: 'video/mp4' }))).toBe(true)
    expect(isVideoFile(new File([], 'clip.MOV'))).toBe(true)
    expect(isVideoFile(new File([], 'notes.txt', { type: 'text/plain' }))).toBe(false)
  })

  it('samples representative points without seeking beyond the video', () => {
    expect(representativeVideoFrameTimes(100)).toEqual([10, 50, 90])
    expect(representativeVideoFrameTimes(0)).toEqual([])
    expect(representativeVideoFrameTimes(Number.POSITIVE_INFINITY)).toEqual([])
    expect(representativeVideoFrameTimes(0.05)).toEqual([0])
  })
})
