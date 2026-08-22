import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { windowsNpmShimExecution } from '../../packages/server/src/services/windows-command'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows command execution', () => {
  it('bypasses cmd.exe for npm-generated shims so argv keeps shell metacharacters intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-windows-command-'))
    roots.push(root)
    const command = join(root, 'codex.cmd')
    const script = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')

    writeFileSync(command, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n')
    mkdirSync(join(root, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
    writeFileSync(script, '')

    expect(windowsNpmShimExecution(command, ['-c', 'developer_instructions="hello & world"'])).toEqual({
      command: 'node',
      args: [script, '-c', 'developer_instructions="hello & world"'],
      windowsVerbatimArguments: false,
    })
  })

  it.skipIf(process.platform !== 'win32')('passes npm shim arguments through Node without cmd.exe reparsing', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-windows-command-'))
    roots.push(root)
    const command = join(root, 'fixture.cmd')
    const script = join(root, 'node_modules', 'fixture', 'bin', 'fixture.js')
    mkdirSync(join(root, 'node_modules', 'fixture', 'bin'), { recursive: true })
    writeFileSync(command, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\fixture\\bin\\fixture.js" %*\r\n')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')

    const args = ['-c', 'developer_instructions="hello & world 中文"', 'value with spaces']
    const execution = windowsNpmShimExecution(command, args)
    expect(execution).toBeTruthy()
    const result = spawnSync(execution!.command, execution!.args, {
      encoding: 'utf8',
      windowsVerbatimArguments: execution!.windowsVerbatimArguments,
    })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(args)
  })
})
