import { readFile, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentToolRegistry,
  EkkoToolApprovalService,
  setupEkkoAgent,
  toolApprovalRequirement,
  type AgentTool,
  type AgentToolApprovalChoice,
  type AgentToolApprovalRequest,
  type EkkoAgentSetup,
} from '../../packages/ekko-agent/src'

let baseDirectory = ''
let setup: EkkoAgentSetup | undefined

beforeEach(async () => {
  baseDirectory = await mkdtemp(join(tmpdir(), 'ekko-tool-approval-'))
})

afterEach(async () => {
  setup?.close()
  setup = undefined
  await rm(baseDirectory, { recursive: true, force: true })
})

function createService(): EkkoToolApprovalService {
  setup = setupEkkoAgent({ baseDirectory })
  return setup.toolApprovals
}

describe('Ekko tool approvals', () => {
  it('classifies arbitrary code and destructive terminal commands while leaving safe commands alone', () => {
    expect(toolApprovalRequirement('code_exec', {
      language: 'python',
      code: 'print("hello")',
    })).toMatchObject({
      key: 'code_exec:python',
      description: 'executes arbitrary Python code',
    })
    expect(toolApprovalRequirement('terminal_exec', {
      command: 'rm',
      args: ['-rf', 'build'],
    })).toMatchObject({
      key: 'terminal:delete',
    })
    expect(toolApprovalRequirement('terminal_exec', {
      command: 'git',
      args: ['reset', '--hard', 'HEAD'],
    })).toMatchObject({
      key: 'terminal:git-destructive',
    })
    expect(toolApprovalRequirement('terminal_exec', {
      command: 'env',
      args: ['MODE=test', 'rm', '-rf', 'build'],
    })).toMatchObject({
      key: 'terminal:delete',
    })
    expect(toolApprovalRequirement('terminal_exec', {
      command: 'npm',
      args: ['test'],
    })).toBeUndefined()
    expect(toolApprovalRequirement('read_file', {
      path: 'README.md',
    })).toBeUndefined()
  })

  it('allows only the current call for a once decision', async () => {
    const service = createService()
    const requests: AgentToolApprovalRequest[] = []
    const requestToolApproval = vi.fn(async (request: AgentToolApprovalRequest): Promise<AgentToolApprovalChoice> => {
      requests.push(request)
      return 'once'
    })

    await expect(service.authorize('code_exec', {
      language: 'node',
      code: 'console.log("one")',
    }, {
      sessionId: 'session-1',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'once' })
    await expect(service.authorize('code_exec', {
      language: 'node',
      code: 'console.log("two")',
    }, {
      sessionId: 'session-1',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'once' })

    expect(requestToolApproval).toHaveBeenCalledTimes(2)
    expect(requests[0]).toMatchObject({
      toolName: 'code_exec',
      key: 'code_exec:node',
      choices: ['once', 'session', 'always', 'deny'],
      allowPermanent: true,
    })
  })

  it('keeps a session approval in memory and scopes it to one chat session', async () => {
    const service = createService()
    const requestToolApproval = vi.fn(async (): Promise<AgentToolApprovalChoice> => 'session')

    await expect(service.authorize('terminal_exec', {
      command: 'rm',
      args: ['old.txt'],
    }, {
      sessionId: 'session-1',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'session' })
    await expect(service.authorize('terminal_exec', {
      command: 'rm',
      args: ['another.txt'],
    }, {
      sessionId: 'session-1',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'session' })
    await expect(service.authorize('terminal_exec', {
      command: 'rm',
      args: ['third.txt'],
    }, {
      sessionId: 'session-2',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'session' })

    expect(requestToolApproval).toHaveBeenCalledTimes(2)
    expect(service.sessionAllowlist('session-1')).toEqual(['terminal:delete'])
    expect(service.sessionAllowlist('session-2')).toEqual(['terminal:delete'])
  })

  it('writes permanent approvals into the global config and reloads them', async () => {
    const service = createService()
    const requestToolApproval = vi.fn(async (): Promise<AgentToolApprovalChoice> => 'always')
    const initialConfig = JSON.parse(await readFile(setup!.layout.configPath, 'utf8'))
    initialConfig.futureSetting = { preserved: true }
    await writeFile(setup!.layout.configPath, `${JSON.stringify(initialConfig, null, 2)}\n`)

    await expect(service.authorize('code_exec', {
      language: 'python',
      code: 'print("persist")',
    }, {
      sessionId: 'session-1',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'always' })

    const config = JSON.parse(await readFile(setup!.layout.configPath, 'utf8'))
    expect(config.tools.approvals).toMatchObject({
      enabled: true,
      permanentAllow: ['code_exec:python'],
    })
    expect(config.futureSetting).toEqual({ preserved: true })

    const reloaded = new EkkoToolApprovalService({ configPath: setup!.layout.configPath })
    await expect(reloaded.authorize('code_exec', {
      language: 'python',
      code: 'print("no prompt")',
    }, {
      sessionId: 'session-2',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'always' })
    expect(requestToolApproval).toHaveBeenCalledTimes(1)
  })

  it('fails closed when approval is denied or no interactive handler exists', async () => {
    const service = createService()
    await expect(service.authorize('terminal_exec', {
      command: 'sudo',
      args: ['reboot'],
    }, {
      sessionId: 'session-1',
      requestToolApproval: vi.fn(async () => 'deny'),
    })).resolves.toMatchObject({
      approved: false,
      scope: 'denied',
      error: expect.stringContaining('User denied'),
    })

    await expect(service.authorize('code_exec', {
      language: 'node',
      code: 'console.log("blocked")',
    }, {
      sessionId: 'background-session',
    })).resolves.toMatchObject({
      approved: false,
      scope: 'denied',
      error: expect.stringContaining('no interactive approval handler'),
    })
  })

  it('blocks the registered tool before execution when authorization is denied', async () => {
    const service = createService()
    const execute = vi.fn(async () => ({ ok: true, content: 'should not run' }))
    const tool: AgentTool = {
      definition: {
        name: 'terminal_exec',
        description: 'test terminal',
        parameters: { type: 'object', properties: {} },
      },
      execute,
    }
    const registry = new AgentToolRegistry(service.authorize)
    registry.register(tool)

    await expect(registry.execute('terminal_exec', {
      command: 'rm',
      args: ['-rf', 'build'],
    }, {
      sessionId: 'session-1',
      requestToolApproval: vi.fn(async () => 'deny'),
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('User denied'),
      data: {
        authorization: {
          scope: 'denied',
          key: 'terminal:delete',
        },
      },
    })
    expect(execute).not.toHaveBeenCalled()
  })
})
