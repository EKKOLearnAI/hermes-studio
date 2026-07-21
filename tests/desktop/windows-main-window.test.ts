import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('Windows desktop main window', () => {
  it('keeps the main BrowserWindow opaque to avoid transparent compositor black screens', () => {
    const source = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf8')
    const createWindowBody = source.match(/async function createWindow\(\): Promise<void> \{([\s\S]*?)\n\}/)?.[1] || ''
    const petWindowBody = source.match(/function ensurePetWindow\(\): BrowserWindow \{([\s\S]*?)\n\}/)?.[1] || ''

    expect(createWindowBody).toContain("backgroundColor: '#1a1a1a'")
    expect(createWindowBody).not.toContain('transparent: true')
    expect(petWindowBody).toContain('transparent: true')
  })
})
