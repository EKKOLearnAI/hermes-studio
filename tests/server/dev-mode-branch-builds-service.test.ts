import { describe, expect, it } from 'vitest'
import { commandSpecs } from '../../packages/server/src/services/hermes/dev-mode-branch-builds'

describe('dev-mode branch build service', () => {
  it('forces preview Vite builds to emit base-relative assets', () => {
    const viteBuild = commandSpecs().find(spec => spec.label === 'vite build')

    expect(viteBuild).toBeDefined()
    expect(viteBuild?.args).toContain('build')
    expect(viteBuild?.args).toContain('--base=./')
  })
})
