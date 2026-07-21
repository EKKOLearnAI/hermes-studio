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

  it('does not terminate the installer or uninstaller process tree', () => {
    const script = readFileSync(resolve('packages/desktop/build/installer.nsh'), 'utf8')

    expect(script).toContain("New-Object 'System.Collections.Generic.HashSet[int]'")
    expect(script).toContain('$$current.ParentProcessId')
    expect(script).toContain('if ($$currentExe -and $$currentExe -ieq $$target) { break }')
    expect(script).toContain('$$protectedProcessIds.Contains([int]$$_.ProcessId)')
    expect(script.indexOf('$$protectedProcessIds.Contains')).toBeLessThan(script.indexOf('$$cmd.IndexOf($$installDir'))
  })

  it('replaces the broken installed uninstaller before upgrading', () => {
    const script = readFileSync(resolve('packages/desktop/build/installer.nsh'), 'utf8')

    expect(script).toContain('!macro repairHermesStudioUninstaller')
    expect(script).toContain('${UNINSTALL_FILENAME}.hermes-repair')
    expect(script).toContain('${UNINSTALL_FILENAME}.hermes-backup')
    expect(script).toContain('!insertmacro repairHermesStudioUninstaller')
  })
})
