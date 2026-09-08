// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useMcpConfigInput } from '@/composables/useMcpConfigInput'

type McpInput = ReturnType<typeof useMcpConfigInput>

function mountInput(validateServer: (name: string, config: unknown) => string | null) {
  let input!: McpInput
  const wrapper = mount(defineComponent({
    setup() {
      input = useMcpConfigInput({
        messages: {
          invalidJson: () => 'invalid-json',
          invalidYaml: detail => detail ? `invalid-yaml: ${detail}` : 'invalid-yaml',
          invalidConfig: () => 'invalid-config',
        },
        validateServer,
      })
      return () => null
    },
  }))
  return { input, wrapper }
}

describe('shared MCP config input', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.useRealTimers()
  })

  it('automatically unwraps mcpServers and pretty-prints after the Hermes delay', () => {
    const mounted = mountInput(() => null)
    wrapper = mounted.wrapper
    const { input } = mounted
    const raw = '{"mcpServers":{"local-tools":{"command":"node","args":["server.mjs"]}}}'

    input.configText.value = raw
    input.handleInput(raw)

    expect(input.configError.value).toBe('')
    vi.advanceTimersByTime(1499)
    expect(input.configText.value).toBe(raw)
    vi.advanceTimersByTime(1)
    expect(input.configText.value).toBe(JSON.stringify({
      'local-tools': { command: 'node', args: ['server.mjs'] },
    }, null, 2))
  })

  it('validates syntax immediately and server fields before save', () => {
    const mounted = mountInput((name, config) => {
      const command = (config as Record<string, unknown>)?.command
      return typeof command === 'string' && command.trim() ? null : `${name}: command-required`
    })
    wrapper = mounted.wrapper
    const { input } = mounted

    input.handleInput('{')
    expect(input.configError.value).toBe('invalid-json')

    input.configText.value = '{"broken":{"args":[]}}'
    expect(input.parseAndValidate().error).toBe('broken: command-required')
  })

  it('accepts the mcp_servers YAML wrapper and converts it to JSON', () => {
    const mounted = mountInput(() => null)
    wrapper = mounted.wrapper
    const { input } = mounted
    input.inputMode.value = 'yaml'
    input.configText.value = 'mcp_servers:\n  local-tools:\n    command: node'

    const parsed = input.parseAndValidate()
    expect(parsed).toEqual({
      servers: { 'local-tools': { command: 'node' } },
      error: '',
    })

    input.inputMode.value = 'json'
    input.handleModeChange('json')
    expect(JSON.parse(input.configText.value)).toEqual({
      mcp_servers: { 'local-tools': { command: 'node' } },
    })
  })
})
