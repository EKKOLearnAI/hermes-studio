import { describe, expect, it } from 'vitest'
import { getSystemPrompt } from '../../packages/server/src/lib/llm-prompt'

describe('LLM prompt', () => {
  it('includes Hermes MCP usage guidance in every system prompt without runtime profile or resource URI values', () => {
    const prompt = getSystemPrompt('custom instructions')

    expect(prompt).toContain('custom instructions')
    expect(prompt).toContain('hermes_studio_api_openapi_get')
    expect(prompt).toContain('hermes_studio_api_request')
    expect(prompt).toContain('OpenAPI requestBody')
    expect(prompt).toContain('do not add Authorization headers')
    expect(prompt).not.toContain('hermes://openapi.json')
    expect(prompt).not.toContain('[Current Hermes profile:')
  })
})
