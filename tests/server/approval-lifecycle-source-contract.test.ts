import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('approval lifecycle source contract - #2558', () => {
  it('preserves authoritative bridge resolution metadata through chat-run', () => {
    const source = readFileSync(
      'packages/server/src/services/hermes/run-chat/handle-bridge-run.ts',
      'utf8',
    )

    expect(source).toContain('resolved: ev.resolved === true')
    expect(source).toContain("ev.expired === true ? { expired: true }")
    expect(source).toContain("ev.stale === true ? { stale: true }")
    expect(source).toContain('String(ev.error || ev.reason)')
  })

  it('uses structured Coding Agent approval adapters without dangerous bypass or text parsing', () => {
    const launch = readFileSync('packages/server/src/services/coding-agents/index.ts', 'utf8')
    const manager = readFileSync('packages/server/src/services/coding-agents/runtime/run-manager.ts', 'utf8')
    const packageJson = readFileSync('package.json', 'utf8')

    expect(`${launch}\n${manager}\n${packageJson}`).not.toMatch(
      /dangerously-(?:skip-permissions|bypass-approvals-and-sandbox)/,
    )
    expect(launch).toContain("'--permission-mode', 'manual'")
    expect(launch).toContain('PermissionRequest')
    expect(manager).toContain("['app-server', '--listen', 'stdio://']")
    expect(manager).toContain("method === 'item/commandExecution/requestApproval'")
    expect(manager).toContain("method === 'item/fileChange/requestApproval'")
    expect(manager).toContain("method === 'serverRequest/resolved'")
    expect(manager).toContain("runtime: 'pi'")
    expect(manager).not.toMatch(/(?:允许|同意|allow|approve).*approval\\.respond/i)
  })
})
