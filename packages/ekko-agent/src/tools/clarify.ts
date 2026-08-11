import { randomUUID } from 'node:crypto'
import { DEFAULT_CLARIFICATION_TIMEOUT_MS } from '../config'
import type {
  AgentClarificationRequest,
  AgentTool,
  AgentToolContext,
  AgentToolProvider,
  AgentToolResult,
} from './types'

const MAX_QUESTION_CHARS = 4_000
const MAX_CHOICES = 20
const MAX_CHOICE_CHARS = 500

export interface ClarifyInput extends Record<string, unknown> {
  question: string
  choices?: string[]
}

export class ClarifyTool implements AgentTool<ClarifyInput> {
  readonly definition = {
    name: 'clarify',
    description: [
      'Ask the user one necessary clarification question and wait for their response.',
      'Provide choices when a short fixed set of answers is appropriate; otherwise omit choices for free-text input.',
      'Use this only when the missing information materially blocks or changes the task.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The concise question shown to the user.',
        },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional short answer choices shown as buttons.',
          maxItems: MAX_CHOICES,
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  }

  async execute(input: ClarifyInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const question = String(input.question || '').trim()
    if (!question) return failure('clarify requires a non-empty question.')
    if (question.length > MAX_QUESTION_CHARS) {
      return failure(`clarify question must not exceed ${MAX_QUESTION_CHARS} characters.`)
    }
    if ((context.delegationDepth || 0) > 0) {
      return failure('Clarification is unavailable to delegated Ekko subagents.')
    }
    if (!context.requestUserClarification) {
      return failure('User clarification is unavailable in this runtime.')
    }

    const choices = normalizeChoices(input.choices)
    if (choices instanceof Error) return failure(choices.message)
    const request: AgentClarificationRequest = {
      clarifyId: randomUUID(),
      question,
      ...(choices.length ? { choices } : {}),
      timeoutMs: DEFAULT_CLARIFICATION_TIMEOUT_MS,
    }

    try {
      const response = await context.requestUserClarification(request)
      if (!response) {
        return {
          ok: true,
          content: 'The user dismissed the clarification without a response.',
          data: {
            clarifyId: request.clarifyId,
            response: '',
          },
        }
      }
      return {
        ok: true,
        content: `User response:\n${response}`,
        data: {
          clarifyId: request.clarifyId,
          response,
        },
      }
    } catch (error) {
      return failure(`Clarification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function createClarificationToolProvider(): AgentToolProvider {
  return {
    id: 'ekko-clarification',
    async listTools(context) {
      if (!context?.requestUserClarification || (context.delegationDepth || 0) > 0) return []
      return [new ClarifyTool()]
    },
  }
}

function normalizeChoices(value: unknown): string[] | Error {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return new Error('clarify choices must be an array of strings.')
  if (value.length > MAX_CHOICES) {
    return new Error(`clarify accepts at most ${MAX_CHOICES} choices.`)
  }
  const choices: string[] = []
  const seen = new Set<string>()
  for (const rawChoice of value) {
    if (typeof rawChoice !== 'string') {
      return new Error('clarify choices must contain only strings.')
    }
    const choice = rawChoice.trim()
    if (!choice) return new Error('clarify choices must not be empty.')
    if (choice.length > MAX_CHOICE_CHARS) {
      return new Error(`clarify choices must not exceed ${MAX_CHOICE_CHARS} characters.`)
    }
    if (seen.has(choice)) continue
    seen.add(choice)
    choices.push(choice)
  }
  return choices
}

function failure(message: string): AgentToolResult {
  return { ok: false, content: message, error: message }
}
