import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getSystemPrompt } from '../../packages/server/src/lib/llm-prompt'

describe('LLM prompt', () => {
  it('includes Hermes MCP usage guidance in every system prompt without runtime profile or resource URI values', () => {
    const prompt = getSystemPrompt('custom instructions')

    expect(prompt).toContain('custom instructions')
    expect(prompt).toContain('hermes_api_openapi_get')
    expect(prompt).toContain('hermes_api_request')
    expect(prompt).toContain('OpenAPI requestBody')
    expect(prompt).toContain('do not add Authorization headers')
    expect(prompt).not.toContain('hermes://openapi.json')
    expect(prompt).not.toContain('[Current Hermes profile:')
  })

  it('advertises Action Fabric discovery and its Phase 3 execution boundary', () => {
    const source = readFileSync(resolve(process.cwd(), 'bin/hermes-web-ui-mcp.mjs'), 'utf8')

    expect(source).toContain("'Action Fabric': {")
    expect(source).toContain('capability discovery')
    expect(source).toContain('intent creation')
    expect(source).toContain('workflow review')
    expect(source).toContain('audit inspection')
    expect(source).toContain('emergency stop')
    expect(source).toContain('Phase 3 supports simulator and reversible internal executors only.')
    expect(source).toContain('No real MCP, browser, payment, device, Home Assistant, desktop, or Android execution is available.')
  })
})
