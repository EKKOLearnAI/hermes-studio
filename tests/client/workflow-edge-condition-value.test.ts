import { describe, expect, it } from 'vitest'
import {
  inferWorkflowConditionValueType,
  parseWorkflowConditionValue,
  requiredWorkflowConditionValueType,
  serializeWorkflowConditionValue,
  serializeWorkflowConditionValueForType,
} from '../../packages/client/src/utils/workflow-edge-condition'

describe('workflow edge condition values', () => {
  it('round-trips typed JSON operands without coercing them to strings', () => {
    expect(serializeWorkflowConditionValue(42)).toBe('42')
    expect(serializeWorkflowConditionValue(['ready', 2])).toBe('["ready",2]')
    expect(parseWorkflowConditionValue('42', 'greater_than')).toBe(42)
    expect(parseWorkflowConditionValue('["ready",2]', 'in')).toEqual(['ready', 2])
    expect(parseWorkflowConditionValue('true', 'equals')).toBe(true)
    expect(parseWorkflowConditionValue('"ready"', 'equals')).toBe('ready')
  })

  it('infers editable value types from existing persisted JSON values', () => {
    expect(inferWorkflowConditionValueType('ready')).toBe('string')
    expect(inferWorkflowConditionValueType(42)).toBe('number')
    expect(inferWorkflowConditionValueType(true)).toBe('boolean')
    expect(inferWorkflowConditionValueType(null)).toBe('null')
    expect(inferWorkflowConditionValueType(['ready'])).toBe('array')
    expect(inferWorkflowConditionValueType({ status: 'ready' })).toBe('object')
    expect(inferWorkflowConditionValueType(undefined)).toBe('string')
  })

  it('requires operator-compatible value types where runtime semantics are type-specific', () => {
    expect(requiredWorkflowConditionValueType('greater_than')).toBe('number')
    expect(requiredWorkflowConditionValueType('less_than_or_equal')).toBe('number')
    expect(requiredWorkflowConditionValueType('in')).toBe('array')
    expect(requiredWorkflowConditionValueType('not_in')).toBe('array')
    expect(requiredWorkflowConditionValueType('equals')).toBeNull()
    expect(requiredWorkflowConditionValueType('contains')).toBeNull()
  })

  it('parses and serializes values according to the selected type', () => {
    expect(parseWorkflowConditionValue('ready', 'equals', 'string')).toBe('ready')
    expect(parseWorkflowConditionValue('42', 'equals', 'number')).toBe(42)
    expect(parseWorkflowConditionValue('false', 'equals', 'boolean')).toBe(false)
    expect(parseWorkflowConditionValue('', 'equals', 'null')).toBeNull()
    expect(parseWorkflowConditionValue('["ready",2]', 'equals', 'array')).toEqual(['ready', 2])
    expect(parseWorkflowConditionValue('{"status":"ready"}', 'equals', 'object')).toEqual({ status: 'ready' })

    expect(serializeWorkflowConditionValueForType('ready', 'string')).toBe('ready')
    expect(serializeWorkflowConditionValueForType({ status: 'ready' }, 'object')).toBe('{"status":"ready"}')
  })

  it('rejects values that do not match the selected type', () => {
    expect(() => parseWorkflowConditionValue('"42"', 'equals', 'number')).toThrow('number')
    expect(() => parseWorkflowConditionValue('1', 'equals', 'boolean')).toThrow('boolean')
    expect(() => parseWorkflowConditionValue('{}', 'equals', 'array')).toThrow('array')
    expect(() => parseWorkflowConditionValue('[]', 'equals', 'object')).toThrow('object')
    expect(() => parseWorkflowConditionValue('{', 'equals', 'object')).toThrow('object')
  })

  it('omits operands for existence operators', () => {
    expect(parseWorkflowConditionValue('ignored', 'exists')).toBeUndefined()
    expect(parseWorkflowConditionValue('ignored', 'not_exists')).toBeUndefined()
    expect(parseWorkflowConditionValue('ignored', 'exists', 'object')).toBeUndefined()
  })

  it('rejects malformed JSON operands instead of saving string fallbacks', () => {
    expect(() => parseWorkflowConditionValue('ready', 'equals')).toThrow('valid JSON')
    expect(() => parseWorkflowConditionValue('{', 'in')).toThrow('valid JSON')
  })
})
