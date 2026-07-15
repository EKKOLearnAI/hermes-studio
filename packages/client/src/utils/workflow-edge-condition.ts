const EXISTENCE_OPERATORS = new Set(['exists', 'not_exists'])

export type WorkflowConditionValueType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'

export function inferWorkflowConditionValueType(value: unknown): WorkflowConditionValueType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object') return 'object'
  return 'string'
}

const NUMERIC_OPERATORS = new Set([
  'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal',
])

export function requiredWorkflowConditionValueType(operator: string): WorkflowConditionValueType | null {
  if (NUMERIC_OPERATORS.has(operator)) return 'number'
  if (operator === 'in' || operator === 'not_in') return 'array'
  return null
}

export function serializeWorkflowConditionValue(value: unknown): string {
  if (value === undefined) return ''
  const serialized = JSON.stringify(value)
  return serialized === undefined ? '' : serialized
}

export function serializeWorkflowConditionValueForType(
  value: unknown,
  type: WorkflowConditionValueType,
): string {
  if (value === undefined || type === 'null') return ''
  if (type === 'string') return typeof value === 'string' ? value : String(value)
  return serializeWorkflowConditionValue(value)
}

function parseTypedWorkflowConditionValue(raw: string, type: WorkflowConditionValueType): unknown {
  if (type === 'string') return raw
  if (type === 'null') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    throw new Error(`workflow condition value must be a valid ${type}`)
  }

  const matches = type === 'array'
    ? Array.isArray(parsed)
    : type === 'object'
      ? parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      : type === 'number'
        ? typeof parsed === 'number' && Number.isFinite(parsed)
        : typeof parsed === 'boolean'
  if (!matches) throw new Error(`workflow condition value must be a valid ${type}`)
  return parsed
}

export function parseWorkflowConditionValue(
  raw: string,
  operator: string,
  type?: WorkflowConditionValueType,
): unknown {
  if (EXISTENCE_OPERATORS.has(operator)) return undefined
  if (type) return parseTypedWorkflowConditionValue(raw, type)

  const value = raw.trim()
  if (!value) throw new Error('workflow condition value must be valid JSON')
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('workflow condition value must be valid JSON')
  }
}

export function workflowConditionNeedsValue(operator: string): boolean {
  return !EXISTENCE_OPERATORS.has(operator)
}
