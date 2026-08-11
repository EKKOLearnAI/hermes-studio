import { describe, expect, it, vi } from 'vitest'
import {
  ClarifyTool,
  buildSystemPrompt,
  createDefaultToolRegistry,
  type AgentClarificationRequest,
} from '../../packages/ekko-agent/src'

describe('Ekko clarify tool', () => {
  it('asks a free-text question and returns the user response', async () => {
    const requestUserClarification = vi.fn(async (request: AgentClarificationRequest) => {
      expect(request).toEqual(expect.objectContaining({
        clarifyId: expect.any(String),
        question: 'Which directory should I update?',
        timeoutMs: 300_000,
      }))
      expect(request.choices).toBeUndefined()
      return 'packages/client'
    })

    await expect(new ClarifyTool().execute({
      question: ' Which directory should I update? ',
    }, {
      requestUserClarification,
    })).resolves.toMatchObject({
      ok: true,
      content: 'User response:\npackages/client',
      data: {
        clarifyId: expect.any(String),
        response: 'packages/client',
      },
    })
    expect(requestUserClarification).toHaveBeenCalledOnce()
  })

  it('normalizes choices and reports a dismissed prompt', async () => {
    const requestUserClarification = vi.fn(async (request: AgentClarificationRequest) => {
      expect(request.choices).toEqual(['Keep', 'Replace'])
      return ''
    })

    await expect(new ClarifyTool().execute({
      question: 'How should I handle the existing file?',
      choices: [' Keep ', 'Replace', 'Keep'],
    }, {
      requestUserClarification,
    })).resolves.toMatchObject({
      ok: true,
      content: 'The user dismissed the clarification without a response.',
      data: {
        response: '',
      },
    })
  })

  it('is exposed only to an interactive foreground run', async () => {
    const registry = createDefaultToolRegistry()

    await registry.refreshTools()
    expect(registry.get('clarify')).toBeUndefined()

    await registry.refreshTools({
      requestUserClarification: vi.fn(async () => 'answer'),
    })
    expect(registry.get('clarify')).toBeInstanceOf(ClarifyTool)

    await registry.refreshTools({
      requestUserClarification: vi.fn(async () => 'answer'),
      delegationDepth: 1,
    })
    expect(registry.get('clarify')).toBeUndefined()
  })

  it('adds a mandatory clarification rule only when the tool is available', () => {
    const interactivePrompt = buildSystemPrompt({
      clarificationEnabled: true,
    })
    const nonInteractivePrompt = buildSystemPrompt()

    expect(interactivePrompt).toContain('## User Clarification')
    expect(interactivePrompt).toContain('call the clarify tool and wait for the response')
    expect(interactivePrompt).toContain('Do not present a blocking clarification question as an ordinary assistant response.')
    expect(nonInteractivePrompt).not.toContain('## User Clarification')
  })

  it('rejects invalid questions, choices, and direct delegated use', async () => {
    const requestUserClarification = vi.fn(async () => 'answer')
    const tool = new ClarifyTool()

    await expect(tool.execute({ question: ' ' }, {
      requestUserClarification,
    })).resolves.toMatchObject({ ok: false })
    await expect(tool.execute({
      question: 'Pick one',
      choices: [''],
    }, {
      requestUserClarification,
    })).resolves.toMatchObject({ ok: false })
    await expect(tool.execute({
      question: 'Pick one',
    }, {
      requestUserClarification,
      delegationDepth: 1,
    })).resolves.toMatchObject({
      ok: false,
      error: 'Clarification is unavailable to delegated Ekko subagents.',
    })
    expect(requestUserClarification).not.toHaveBeenCalled()
  })
})
