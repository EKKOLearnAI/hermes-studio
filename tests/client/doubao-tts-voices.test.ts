import { describe, expect, it } from 'vitest'
import {
  DOUBAO_TTS_ICL_RESOURCE_ID,
  parseDoubaoTtsCloneVoices,
  serializeDoubaoTtsCloneVoices,
} from '../../packages/client/src/constants/doubaoTtsVoices'

describe('Doubao TTS clone voices', () => {
  it('parses and deduplicates persisted clone voices while preserving a legacy voice', () => {
    expect(parseDoubaoTtsCloneVoices('[{"id":"S_one","name":" One "},{"id":"S_one","name":"duplicate"}]', 'S_legacy')).toEqual([
      { id: 'S_legacy', name: 'S_legacy' },
      { id: 'S_one', name: 'One' },
    ])
  })

  it('round trips clone voice records and keeps the ICL resource ID explicit', () => {
    const voices = [{ id: 'S_one', name: 'My voice' }, { id: 'S_two', name: '客服女声' }]
    expect(JSON.parse(serializeDoubaoTtsCloneVoices(voices))).toEqual(voices)
    expect(DOUBAO_TTS_ICL_RESOURCE_ID).toBe('seed-icl-2.0')
  })
})
