export const EKKO_CONFIG_SCHEMA_VERSION = 1
export const EKKO_CONFIG_DIRECTORY_NAME = 'config'
export const EKKO_CONFIG_FILE_NAME = 'config.json'

export const DEFAULT_AGENT_MAX_STEPS = 90
export const DEFAULT_AGENT_MODEL_MAX_RETRIES = 3
export const DEFAULT_AGENT_MAX_CONSECUTIVE_TOOL_FAILURES = 6
export const DEFAULT_AGENT_SUBTASK_MAX_STEPS = 30
export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000
export const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 120_000
export const DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET = 4_000
export const DEFAULT_MEMORY_RECENT_MESSAGE_LIMIT = 20
export const DEFAULT_MEMORY_SEARCH_RESULT_LIMIT = 50
export const DEFAULT_MEMORY_REVIEW_EVERY_USER_MESSAGES = 1
export const DEFAULT_SKILL_REVIEW_TOOL_CALL_INTERVAL = 10
export const DEFAULT_EKKO_LOG_MAX_BYTES = 10 * 1024 * 1024

/**
 * Initial global Ekko configuration written for every installation.
 *
 * Runtime configuration is intentionally fixed to these existing defaults for
 * now. The file establishes the future configuration boundary but is not yet a
 * user- or profile-configurable runtime input.
 */
export const DEFAULT_EKKO_CONFIG = {
  schemaVersion: EKKO_CONFIG_SCHEMA_VERSION,
  runtime: {
    maxSteps: DEFAULT_AGENT_MAX_STEPS,
    maxModelRetries: DEFAULT_AGENT_MODEL_MAX_RETRIES,
    maxConsecutiveToolFailures: DEFAULT_AGENT_MAX_CONSECUTIVE_TOOL_FAILURES,
  },
  model: {
    requestTimeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    reasoningEffort: 'medium',
    reasoningSummary: 'auto',
  },
  tools: {
    enabled: true,
    executionTimeoutMs: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
  },
  delegation: {
    backgroundEnabled: true,
    subtaskMaxSteps: DEFAULT_AGENT_SUBTASK_MAX_STEPS,
  },
  memory: {
    enabled: true,
    recentMessageLimit: DEFAULT_MEMORY_RECENT_MESSAGE_LIMIT,
    automaticRecallTokenBudget: DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET,
    searchResultLimit: DEFAULT_MEMORY_SEARCH_RESULT_LIMIT,
    reviewEveryUserMessages: DEFAULT_MEMORY_REVIEW_EVERY_USER_MESSAGES,
  },
  skills: {
    enabled: true,
    reviewEveryToolCalls: DEFAULT_SKILL_REVIEW_TOOL_CALL_INTERVAL,
  },
  logging: {
    maxBytes: DEFAULT_EKKO_LOG_MAX_BYTES,
  },
  prompt: {
    instructions: [],
  },
} as const

export function serializeDefaultEkkoConfig(): string {
  return `${JSON.stringify(DEFAULT_EKKO_CONFIG, null, 2)}\n`
}
