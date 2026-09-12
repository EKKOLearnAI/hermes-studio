import { describe, expect, it } from 'vitest'
import {
  filterReasoningEffortValues,
  getModelReasoningPolicy,
} from '@/utils/reasoning-effort'

const chatEffortValues = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const auxiliaryEffortValues = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

describe('model reasoning effort policies', () => {
  it('exposes the supported Kimi K2 levels and removes unsupported ladder entries', () => {
    expect(getModelReasoningPolicy('kimi-coding', 'kimi-k2.5')).toEqual({
      official: ['low', 'medium', 'high'],
      extensions: [],
    })
    expect(filterReasoningEffortValues(chatEffortValues, 'kimi-coding', 'kimi-k2.5')).toEqual([
      '', 'none', 'low', 'medium', 'high',
    ])
    expect(filterReasoningEffortValues(auxiliaryEffortValues, 'kimi-coding', 'kimi-k2.5')).toEqual([
      'none', 'low', 'medium', 'high',
    ])
  })

  it('keeps Grok 4.6 official levels and marks max as an extension', () => {
    expect(getModelReasoningPolicy('xai', 'grok-4.6-0309')).toEqual({
      official: ['low', 'medium', 'high', 'xhigh'],
      extensions: ['max'],
    })
    expect(filterReasoningEffortValues(auxiliaryEffortValues, 'xai', 'grok-4.6-0309')).toEqual([
      'none', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
  })

  it('preserves the workflow default sentinel while filtering model levels', () => {
    expect(filterReasoningEffortValues(
      ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      'kimi-coding',
      'kimi-k2.5',
    )).toEqual(['default', 'none', 'low', 'medium', 'high'])
  })

  it('keeps all existing choices for models without a policy', () => {
    expect(getModelReasoningPolicy('custom:gateway', 'model-a')).toBeNull()
    expect(getModelReasoningPolicy('custom:gateway', 'k3')).toBeNull()
    expect(filterReasoningEffortValues(auxiliaryEffortValues, 'custom:gateway', 'model-a')).toEqual(auxiliaryEffortValues)
  })
})
