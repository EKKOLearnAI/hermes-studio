import { describe, expect, it } from 'vitest'
import { hasManagedMcpNodeMode } from '../../scripts/managed-mcp-harness.mjs'

describe('managed MCP launch harness', () => {
  it.each([
    `function managed() { return { env: { ELECTRON_RUN_AS_NODE: '1' } } }`,
    `function managed() { const env = { ELECTRON_RUN_AS_NODE: '1' }; return { env } }`,
    `function managed() { return { env: { 'ELECTRON_RUN_AS_NODE': "1" } } }`,
  ])('accepts an explicit subprocess Node-mode flag', source => {
    expect(hasManagedMcpNodeMode(source, 'managed')).toBe(true)
  })

  it.each([
    `function managed() { return { env: {} } }`,
    `function managed() { return { env: { ELECTRON_RUN_AS_NODE: '0' } } }`,
    `function managed() { return { env: { ELECTRON_RUN_AS_NODE: 1 } } }`,
    `function managed() { return { env: { ...process.env } } }`,
    `// ELECTRON_RUN_AS_NODE: '1'\nfunction managed() { return { env: {} } }`,
    `function other() { return { env: { ELECTRON_RUN_AS_NODE: '1' } } }`,
    `function managed() { return { ELECTRON_RUN_AS_NODE: '1', env: {} } }`,
    `function managed() { return { env: { ELECTRON_RUN_AS_NODE: '1', ...overrides } } }`,
  ])('rejects a missing, ineffective, or overwritten flag', source => {
    expect(hasManagedMcpNodeMode(source, 'managed')).toBe(false)
  })
})
