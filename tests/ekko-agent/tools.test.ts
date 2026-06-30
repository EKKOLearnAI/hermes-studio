import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentToolError,
  ReadFileTool,
  TerminalExecTool,
  WriteFileTool,
  createDefaultToolRegistry,
} from '../../packages/ekko-agent/src/index'

let workspaceRoot = ''

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ekko-agent-tools-'))
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('ekko-agent tools', () => {
  it('writes and reads files inside the workspace', async () => {
    const writer = new WriteFileTool()
    const reader = new ReadFileTool()

    await expect(writer.execute({
      path: 'notes/todo.txt',
      content: 'ship tools',
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      data: {
        bytes: 10,
      },
    })

    await expect(readFile(path.join(workspaceRoot, 'notes/todo.txt'), 'utf8')).resolves.toBe('ship tools')
    await expect(reader.execute({ path: 'notes/todo.txt' }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      content: 'ship tools',
    })
  })

  it('blocks file paths outside workspaceRoot', async () => {
    const reader = new ReadFileTool()

    await expect(reader.execute({ path: '../outside.txt' }, { workspaceRoot })).rejects.toBeInstanceOf(AgentToolError)
    await expect(reader.execute({ path: '../outside.txt' }, { workspaceRoot })).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    })
  })

  it('runs terminal commands with argument arrays', async () => {
    const terminal = new TerminalExecTool()

    await expect(terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', 'hello-terminal'],
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      content: 'hello-terminal',
      data: {
        args: ['-e', 'process.stdout.write(process.argv[1])', 'hello-terminal'],
        exitCode: 0,
      },
    })
  })

  it('reports non-zero terminal exits without throwing', async () => {
    const terminal = new TerminalExecTool()

    await expect(terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("bad"); process.exit(7)'],
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: false,
      content: 'bad',
      error: 'Command exited with code 7',
      data: {
        exitCode: 7,
      },
    })
  })

  it('registers default tools and exposes model definitions', async () => {
    const registry = createDefaultToolRegistry()

    expect(registry.definitions().map(definition => definition.name).sort()).toEqual([
      'read_file',
      'terminal_exec',
      'write_file',
    ])

    await expect(registry.execute('write_file', {
      path: 'from-registry.txt',
      content: 'ok',
    }, { workspaceRoot })).resolves.toMatchObject({ ok: true })

    await expect(registry.execute('read_file', {
      path: 'from-registry.txt',
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      content: 'ok',
    })
  })
})
