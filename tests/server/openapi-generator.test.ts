import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../..')
const temporaryRoots: string[] = []

function createGeneratorFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-openapi-generator-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'packages/server/src'), { recursive: true })
  cpSync(join(repoRoot, 'scripts/generate-openapi.mjs'), join(root, 'scripts/generate-openapi.mjs'))
  cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'))
  cpSync(join(repoRoot, 'docs/openapi.json'), join(root, 'docs/openapi.json'))
  cpSync(join(repoRoot, 'packages/server/src/routes'), join(root, 'packages/server/src/routes'), { recursive: true })
  cpSync(join(repoRoot, 'packages/server/src/controllers'), join(root, 'packages/server/src/controllers'), { recursive: true })
  return root
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
})

describe('OpenAPI generator', () => {
  it('preserves the explicit Group Chat Room config request schema without generated drift', () => {
    const root = createGeneratorFixture()
    const openapiPath = join(root, 'docs/openapi.json')
    const committed = readFileSync(openapiPath)

    execFileSync(process.execPath, [join(root, 'scripts/generate-openapi.mjs')], { cwd: root })
    const firstGeneration = readFileSync(openapiPath)
    const openapi = JSON.parse(firstGeneration.toString('utf8'))
    const schema = openapi.paths['/api/hermes/group-chat/rooms/{roomId}/config'].put.requestBody.content['application/json'].schema

    expect(schema).toEqual({
      type: 'object',
      properties: {
        handoffMode: { type: 'string' },
        handoffOrder: { type: 'array', items: { type: 'string' } },
        maxAgentMentionDepth: { nullable: true, type: 'number' },
        maxHistoryTokens: { type: 'number' },
        tailMessageCount: { type: 'number' },
        triggerTokens: { type: 'number' },
      },
    })
    expect(firstGeneration).toEqual(committed)

    execFileSync(process.execPath, [join(root, 'scripts/generate-openapi.mjs')], { cwd: root })
    expect(readFileSync(openapiPath)).toEqual(firstGeneration)
  })
})
