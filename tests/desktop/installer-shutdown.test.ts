import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('Windows installer shutdown hook', () => {
  it('stops child runtime processes that still reference the installed app', () => {
    const script = readFileSync(resolve('packages/desktop/build/installer.nsh'), 'utf8')

    expect(script).toContain('HERMES_STUDIO_INSTALL_DIR')
    expect(script).toContain('Get-HermesStudioRelatedProcess')
    expect(script).toContain('desktop-runtime\\active-version.json')
    expect(script).toContain('hermes-studio-mcp|hermes_bridge\\.py|hermes_cli\\.main gateway run')
    expect(script).toContain('Stop-Process -Id')
  })
})
