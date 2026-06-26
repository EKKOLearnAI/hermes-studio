import { describe, it, expect } from 'vitest'
import {
  isRecord,
  ompAssistantReasoning,
  ompAssistantText,
  ompToolResultText,
  ompToolResultImagePaths,
  ompUsageTokens,
} from '../../packages/server/src/services/hermes/run-chat/omp-transforms'

describe('omp transforms', () => {
  describe('ompAssistantText', () => {
    it('concatenates only text content blocks', () => {
      const message = {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'Hello' },
          { type: 'toolCall', id: 't1', name: 'bash', arguments: {} },
          { type: 'text', text: ' world' },
        ],
      }
      expect(ompAssistantText(message)).toBe('Hello world')
    })

    it('returns empty string for non-record or missing content', () => {
      expect(ompAssistantText(undefined)).toBe('')
      expect(ompAssistantText('nope')).toBe('')
      expect(ompAssistantText({ role: 'assistant' })).toBe('')
      expect(ompAssistantText({ content: 'notarray' })).toBe('')
    })
  })

  describe('ompAssistantReasoning', () => {
    it('concatenates only thinking content blocks', () => {
      const message = {
        content: [
          { type: 'thinking', thinking: 'step 1 ' },
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'step 2' },
        ],
      }
      expect(ompAssistantReasoning(message)).toBe('step 1 step 2')
    })

    it('returns empty string when no thinking blocks', () => {
      expect(ompAssistantReasoning({ content: [{ type: 'text', text: 'x' }] })).toBe('')
    })
  })

  describe('ompToolResultText', () => {
    it('flattens text blocks from an omp tool result object', () => {
      const result = { content: [{ type: 'text', text: 'line1\n' }, { type: 'text', text: 'line2' }], isError: false }
      expect(ompToolResultText(result)).toBe('line1\nline2')
    })

    it('returns a raw string result unchanged', () => {
      expect(ompToolResultText('plain output')).toBe('plain output')
    })

    it('prefers a top-level text field when present', () => {
      expect(ompToolResultText({ text: 'direct' })).toBe('direct')
    })

    it('returns empty string for unusable shapes', () => {
      expect(ompToolResultText(undefined)).toBe('')
      expect(ompToolResultText({ content: 'nope' })).toBe('')
      expect(ompToolResultText(42)).toBe('')
    })
  })

  describe('ompToolResultImagePaths', () => {
    it('extracts absolute image paths from result details', () => {
      const result = {
        content: [{ type: 'text', text: 'Generated 1 image(s):\n  /tmp/omp-image-abc.png' }],
        details: { imagePaths: ['/tmp/omp-image-abc.png'], images: [{ data: 'AAA', mimeType: 'image/png' }] },
      }
      expect(ompToolResultImagePaths(result)).toEqual(['/tmp/omp-image-abc.png'])
    })

    it('drops blank or non-string entries and unusable shapes', () => {
      expect(ompToolResultImagePaths({ details: { imagePaths: ['/a.png', '', 3, null] } })).toEqual(['/a.png'])
      expect(ompToolResultImagePaths({ details: { imagePaths: 'nope' } })).toEqual([])
      expect(ompToolResultImagePaths({ content: [] })).toEqual([])
      expect(ompToolResultImagePaths('x')).toEqual([])
    })
  })

  describe('ompUsageTokens', () => {
    it('reads omp Usage fields', () => {
      expect(ompUsageTokens({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125 }))
        .toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 125 })
    })

    it('derives total from parts when totalTokens missing', () => {
      expect(ompUsageTokens({ input: 10, output: 4, cacheRead: 1, cacheWrite: 2 }))
        .toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 17 })
    })

    it('defaults to zeros for non-record usage', () => {
      expect(ompUsageTokens(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    })
  })

  describe('isRecord', () => {
    it('distinguishes plain objects from arrays and primitives', () => {
      expect(isRecord({})).toBe(true)
      expect(isRecord({ a: 1 })).toBe(true)
      expect(isRecord([])).toBe(false)
      expect(isRecord(null)).toBe(false)
      expect(isRecord('s')).toBe(false)
      expect(isRecord(3)).toBe(false)
    })
  })
})
