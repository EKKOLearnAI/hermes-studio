import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getModelRuntimeCapabilities } from '../../packages/server/src/modules/hermes/services/models/context'

const homes: string[] = []

afterEach(() => {
  delete process.env.HERMES_HOME
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('model runtime capability fallback', () => {
  it('keeps unknown custom models reasoning- and image-capable when metadata is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-model-capabilities-'))
    homes.push(home)
    process.env.HERMES_HOME = home

    expect(getModelRuntimeCapabilities({
      profile: 'default',
      provider: 'custom:private-proxy',
      model: 'future-private-model',
    })).toMatchObject({
      reasoning: true,
      input: ['text', 'image'],
    })
  })
})
