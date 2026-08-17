import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

function clientSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return clientSourceFiles(path)
    return ['.ts', '.vue'].includes(extname(entry.name)) ? [path] : []
  })
}

describe('Ekko display name', () => {
  it('uses Ekko everywhere in the client without changing the internal runtime id', () => {
    const occurrences = clientSourceFiles('packages/client/src')
      .flatMap(path => readFileSync(path, 'utf8').includes('Ekko Agent') ? [path] : [])

    expect(occurrences).toEqual([])
    expect(readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8'))
      .toContain('{ label: "Ekko", value: "ekko-agent" }')
  })

  it.each([
    ['single chat', 'packages/client/src/components/hermes/chat/ChatPanel.vue',
      '{ label: "Hermes", value: "hermes" }', '{ label: "Ekko", value: "ekko-agent" }', '{ label: "Claude", value: "claude-code" }'],
    ['group chat', 'packages/client/src/components/hermes/group-chat/GroupChatPanel.vue',
      "{ label: 'Hermes', value: 'hermes' }", "{ label: 'Ekko', value: 'ekko' }", "{ label: 'Claude', value: 'claude' }"],
    ['group chat link', 'packages/client/src/views/hermes/GroupChatLinkView.vue',
      "{ label: 'Hermes', value: 'hermes' }", "{ label: 'Ekko', value: 'ekko' }", "{ label: 'Claude', value: 'claude' }"],
    ['workflow', 'packages/client/src/views/hermes/WorkflowView.vue',
      "{ label: 'Hermes', value: 'hermes' }", "{ label: 'Ekko', value: 'ekko-agent' }", "{ label: 'Claude', value: 'claude-code' }"],
  ])('places Ekko second in the %s Agent dropdown', (_name, path, hermes, ekko, claude) => {
    const source = readFileSync(path, 'utf8')
    const hermesIndex = source.indexOf(hermes)
    const ekkoIndex = source.indexOf(ekko)
    const claudeIndex = source.indexOf(claude)

    expect(hermesIndex).toBeGreaterThanOrEqual(0)
    expect(ekkoIndex).toBeGreaterThan(hermesIndex)
    expect(claudeIndex).toBeGreaterThan(ekkoIndex)
  })

  it('keeps server-managed provider choices available for Ekko workflow nodes', () => {
    const view = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')
    const node = readFileSync('packages/client/src/components/hermes/workflow/WorkflowAgentNode.vue', 'utf8')

    expect(view).toContain('canScopedCodingAgentUseProvider(')
    expect(node).toContain('canScopedCodingAgentUseProvider(')
  })

  it('keeps the log API id internal while displaying Ekko', () => {
    const logs = readFileSync('packages/client/src/views/hermes/LogsView.vue', 'utf8')

    expect(logs).toContain("name.replace(/^ekko-agent(?=\\/|$)/, 'Ekko')")
    expect(logs).toContain('`${displayLogName(f.name)} (${f.size})`')
    expect(logs).toContain('{{ displayLogName(entry.logger) }}')
  })

  it('uses Claude everywhere in the client without changing the internal runtime id', () => {
    const occurrences = clientSourceFiles('packages/client/src')
      .flatMap(path => readFileSync(path, 'utf8').includes('Claude Code') ? [path] : [])

    expect(occurrences).toEqual([])
    expect(readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8'))
      .toContain('{ label: "Claude", value: "claude-code" }')
  })
})
