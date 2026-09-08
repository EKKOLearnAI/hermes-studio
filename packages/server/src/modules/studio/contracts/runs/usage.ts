export interface UsageStatsModelRow {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  sessions: number
}

export interface UsageStatsAgentRow {
  agent: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  sessions: number
}

export interface UsageStatsDailyRow {
  date: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  sessions: number
  errors: number
  cost: number
}

export interface LocalUsageStats {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  sessions: number
  by_model: UsageStatsModelRow[]
  by_agent: UsageStatsAgentRow[]
  by_day: UsageStatsDailyRow[]
  cost: number
  total_api_calls: number
}
