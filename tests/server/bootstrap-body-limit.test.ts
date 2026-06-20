import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('bootstrap body parser limits', () => {
  it('allows MiMo voice-clone JSON payloads advertised by the UI/docs', () => {
    const source = readFileSync('packages/server/src/index.ts', 'utf8')

    expect(source).toContain("jsonLimit: '20mb'")
    expect(source).toContain("formLimit: '20mb'")
  })

  it('parses DELETE request bodies for file operations', () => {
    const source = readFileSync('packages/server/src/index.ts', 'utf8')

    expect(source).toMatch(/parsedMethods:\s*\[\s*'POST',\s*'PUT',\s*'PATCH',\s*'DELETE'\s*\]/)
  })
})
