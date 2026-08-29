import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentToolError,
  DelegateTaskTool,
  ReadFileTool,
  TerminalExecTool,
  ViewImageTool,
  WriteFileTool,
  createDefaultToolRegistry,
  sanitizeAgentToolResult,
} from '../../packages/ekko-agent/src/index'

let workspaceRoot = ''

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ekko-agent-tools-'))
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
  delete process.env.AGENT_BROWSER_BIN
})

describe('ekko-agent tools', () => {
  it('materializes tool-result data URLs in the system temp area', async () => {
    const toolAssets = path.join(workspaceRoot, 'system-temp', 'ekko-agent', 'tool-assets')
    const dataUrl = `data:image/png;base64,${Buffer.from('avatar-png').toString('base64')}`
    const result = await sanitizeAgentToolResult({
      ok: true,
      content: JSON.stringify({
        profiles: [{
          name: 'default',
          avatar: { type: 'image', dataUrl, updatedAt: 123 },
        }],
      }),
      data: { avatar: { dataUrl } },
    }, { tempRoot: toolAssets })

    expect(result.content).not.toContain('base64')
    const parsed = JSON.parse(result.content)
    const url = parsed.profiles[0].avatar.dataUrl
    expect(url).toMatch(/^file:\/\//)
    expect(fileURLToPath(url)).toContain(toolAssets)
    await expect(readFile(fileURLToPath(url), 'utf8')).resolves.toBe('avatar-png')
    expect(JSON.stringify(result.data)).not.toContain('base64')
  })

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

  it('loads supported workspace images as multimodal tool results', async () => {
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await writeFile(path.join(workspaceRoot, 'preview.png'), image)
    const viewer = new ViewImageTool()

    await expect(viewer.execute({ path: 'preview.png' }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      contentParts: [{
        type: 'image',
        mimeType: 'image/png',
        data: image.toString('base64'),
      }],
      data: {
        path: path.join(workspaceRoot, 'preview.png'),
        bytes: image.byteLength,
        mimeType: 'image/png',
      },
    })
  })

  it('reports a recoverable view_image failure when the current model is text-only', async () => {
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await writeFile(path.join(workspaceRoot, 'text-only-preview.png'), image)
    const viewer = new ViewImageTool()

    const result = await viewer.execute({ path: 'text-only-preview.png' }, {
      workspaceRoot,
      modelProvider: 'glm',
      modelName: 'glm-5.3',
      modelCapabilities: {
        streaming: true,
        tools: true,
        vision: false,
        jsonMode: true,
        systemPrompt: true,
      },
    })

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('glm/glm-5.3 does not support vision input'),
      data: {
        code: 'VISION_UNSUPPORTED',
        path: path.join(workspaceRoot, 'text-only-preview.png'),
        bytes: image.byteLength,
        mimeType: 'image/png',
      },
    })
    expect(result).not.toHaveProperty('contentParts')
  })

  it('enforces workspace and format boundaries when viewing images', async () => {
    const viewer = new ViewImageTool()
    await writeFile(path.join(workspaceRoot, 'not-an-image.png'), 'plain text')

    await expect(viewer.execute({ path: '../outside.png' }, { workspaceRoot }))
      .rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    await expect(viewer.execute({ path: 'not-an-image.png' }, { workspaceRoot }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE_FORMAT' })
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

  it('defaults command temporary files to the current workspace', async () => {
    const terminal = new TerminalExecTool()
    const result = await terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }))'],
    }, { workspaceRoot })
    const expected = path.join(workspaceRoot, '.ekko-tmp')

    expect(result.ok).toBe(true)
    expect(JSON.parse(result.content)).toEqual({ TMPDIR: expected, TMP: expected, TEMP: expected })
    expect((await stat(expected)).isDirectory()).toBe(true)
  })

  it('allows an explicit terminal working directory outside workspaceRoot', async () => {
    const terminal = new TerminalExecTool()
    const cwd = os.tmpdir()

    const result = await terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.cwd())'],
      cwd,
    }, { workspaceRoot })
    expect(result).toMatchObject({
      ok: true,
      data: { cwd },
    })
    expect(await realpath(result.content)).toBe(await realpath(cwd))
  })

  it('normalizes shell-like terminal command strings when args are omitted', async () => {
    const terminal = new TerminalExecTool()

    await expect(terminal.execute({
      command: `${process.execPath} -e "process.stdout.write(process.argv[1])" hello-split`,
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      content: 'hello-split',
      data: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', 'hello-split'],
        exitCode: 0,
      },
    })
  })

  it('does not start terminal commands when the signal is already aborted', async () => {
    const terminal = new TerminalExecTool()
    const controller = new AbortController()
    controller.abort()

    await expect(terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("should-not-run")'],
    }, { workspaceRoot, signal: controller.signal })).resolves.toMatchObject({
      ok: false,
      content: 'Command aborted.',
      error: 'Command aborted.',
      data: {
        aborted: true,
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
    const definitions = registry.definitions()

    expect(definitions.map(definition => definition.name).sort()).toEqual([
      'browser_back',
      'browser_click',
      'browser_console',
      'browser_get_images',
      'browser_navigate',
      'browser_press',
      'browser_scroll',
      'browser_snapshot',
      'browser_type',
      'browser_vision',
      'code_exec',
      'delegate_task',
      'read_file',
      'skill_list',
      'skill_view',
      'terminal_exec',
      'view_image',
      'write_file',
    ])
    const definitionsByName = new Map(definitions.map(definition => [definition.name, definition]))
    expect(definitionsByName.get('code_exec')?.description).toContain('including a one-line snippet')
    expect(definitionsByName.get('terminal_exec')?.description).toContain('use code_exec instead')
    expect(definitionsByName.get('terminal_exec')?.description).toContain('npx --dir')
    for (const definition of definitions) {
      expect(definition.description, definition.name).not.toMatch(/[\p{Script=Han}]/u)
      for (const description of collectDescriptions(definition.parameters)) {
        expect(description, definition.name).not.toMatch(/[\p{Script=Han}]/u)
      }
    }

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

  it('delegates foreground and background tasks through the runtime callback', async () => {
    const tool = new DelegateTaskTool()
    const requests: unknown[] = []
    const delegateTask = async (request: unknown) => {
      requests.push(request)
      return { ok: true, content: 'delegated' }
    }

    await expect(tool.execute({
      goal: 'Inspect the failing test',
      context: 'Only read files under tests/',
      mode: 'foreground',
    }, { delegateTask })).resolves.toMatchObject({
      ok: true,
      content: 'delegated',
    })
    await expect(tool.execute({
      goal: 'Run the slow validation',
      mode: 'background',
    }, { delegateTask })).resolves.toMatchObject({
      ok: true,
      content: 'delegated',
    })

    expect(requests).toEqual([{
      goal: 'Inspect the failing test',
      context: 'Only read files under tests/',
      mode: 'foreground',
    }, {
      goal: 'Run the slow validation',
      mode: 'background',
    }])
  })

  it('rejects recursive or unavailable delegation', async () => {
    const tool = new DelegateTaskTool()

    await expect(tool.execute({
      goal: 'Delegate again',
      mode: 'foreground',
    }, {
      delegationDepth: 1,
      delegateTask: async () => ({ ok: true, content: 'unexpected' }),
    })).resolves.toMatchObject({
      ok: false,
      error: 'Recursive delegation is disabled for Ekko subagents.',
    })

    await expect(tool.execute({
      goal: 'No runtime callback',
      mode: 'background',
    })).resolves.toMatchObject({
      ok: false,
      error: 'Subtask delegation is unavailable in this runtime.',
    })
  })
})

function collectDescriptions(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(collectDescriptions)
  const record = value as Record<string, unknown>
  return [
    ...(typeof record.description === 'string' ? [record.description] : []),
    ...Object.values(record).flatMap(collectDescriptions),
  ]
}
