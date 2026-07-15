import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('desktop preload auth', () => {
  it('does not auto-login with default credentials', () => {
    const source = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf-8')

    expect(source).not.toContain('/api/auth/login')
    expect(source).not.toContain('DEFAULT_PASSWORD')
    expect(source).not.toContain('DEFAULT_USERNAME')
    expect(source).not.toContain('autoLogin')
  })
})
