import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBundledMcpArgs } from '../../packages/desktop/src/main/mcp-cli'

describe('legacy packaged MCP invocation', () => {
  const resources = join(process.cwd(), 'test-app', 'Resources')

  it.each(['hermes-studio-mcp.mjs', 'hermes-web-ui-mcp.mjs'])('preserves the arguments for %s', name => {
    const script = join(resources, 'webui', 'bin', name)
    expect(parseBundledMcpArgs(['Hermes Studio', script, 'devices'], resources)).toEqual([script, 'devices'])
  })

  it('leaves ordinary desktop, CLI, and arbitrary script invocations alone', () => {
    for (const args of [[], ['--hidden'], ['--quit'], ['--hermes-cli', 'status'], ['/tmp/hermes-studio-mcp.mjs']]) {
      expect(parseBundledMcpArgs(['Hermes Studio', ...args], resources)).toBeNull()
    }
  })
})
