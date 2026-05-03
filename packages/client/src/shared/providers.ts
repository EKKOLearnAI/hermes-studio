/**
 * Provider registry — single source of truth for both frontend and backend.
 * Synced from hermes-agent hermes_cli/models.py _PROVIDER_MODELS.
 */

export interface ProviderPreset {
  label: string
  value: string
  base_url: string
  models: string[]
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    label: 'Anthropic',
    value: 'anthropic',
    base_url: 'https://api.anthropic.com',
    models: [
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-haiku-4-5-20251001',
    ],
  },
  {
    label: 'Google AI Studio',
    value: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemma-4-31b-it',
      'gemma-4-26b-it',
    ],
  },
  {
    label: 'DeepSeek',
    value: 'deepseek',
    base_url: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    label: 'Z.AI / GLM',
    value: 'zai',
    base_url: 'https://api.z.ai/api/paas/v4',
    models: ['glm-5.1', 'glm-5', 'glm-5v-turbo', 'glm-5-turbo', 'glm-4.7', 'glm-4.5', 'glm-4.5-flash'],
  },
  {
    label: 'Kimi for Coding',
    value: 'kimi-coding',
    base_url: 'https://api.kimi.com/coding/v1',
    models: [
      'kimi-for-coding',
      'kimi-k2.5',
      'kimi-k2-thinking',
      'kimi-k2-thinking-turbo',
      'kimi-k2-turbo-preview',
      'kimi-k2-0905-preview',
    ],
  },
  {
    label: 'Kimi for Coding (CN)',
    value: 'kimi-coding-cn',
    base_url: 'https://api.kimi.com/coding/v1',
    models: [
      'kimi-k2.5',
      'kimi-k2-thinking',
      'kimi-k2-turbo-preview',
      'kimi-k2-0905-preview',
    ],
  },
  {
    label: 'Moonshot',
    value: 'moonshot',
    base_url: 'https://api.moonshot.cn/v1',
    models: [
      'kimi-k2.5',
      'kimi-k2-thinking',
      'kimi-k2-turbo-preview',
      'kimi-k2-0905-preview',
    ],
  },
  {
    label: 'xAI',
    value: 'xai',
    base_url: 'https://api.x.ai/v1',
    models: ['grok-4.20-reasoning', 'grok-4-1-fast-reasoning'],
  },
  {
    label: 'MiniMax',
    value: 'minimax',
    base_url: 'https://api.minimax.io/anthropic/v1',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2', 'MiniMax-M2-highspeed'],
  },
  {
    label: 'MiniMax (China)',
    value: 'minimax-cn',
    base_url: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2', 'MiniMax-M2-highspeed'],
  },
  {
    label: 'Alibaba Cloud',
    value: 'alibaba',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: [
      'qwen3.5-plus',
      'qwen3-coder-plus',
      'qwen3-coder-next',
      'glm-5',
      'glm-4.7',
      'kimi-k2.5',
      'MiniMax-M2.5',
    ],
  },
  {
    label: 'Alibaba Cloud (Coding Plan)',
    value: 'alibaba-coding-plan',
    // NOTE: This is the international (intl) DashScope endpoint, matching upstream
    // hermes-agent (auth.py:255). Mainland China DashScope accounts (sk-sp-* keys
    // issued by dashscope.aliyun.com) must override via ALIBABA_CODING_PLAN_BASE_URL=
    // https://coding.dashscope.aliyuncs.com/v1 (no -intl), since the -intl endpoint
    // returns HTTP 401 for those keys.
    base_url: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    models: [
      'qwen3.5-plus',
      'qwen3-max-2026-01-23',
      'qwen3-coder-next',
      'qwen3-coder-plus',
      'glm-5',
      'glm-4.7',
      'kimi-k2.5',
      'MiniMax-M2.5',
    ],
  },
  {
    label: 'Hugging Face',
    value: 'huggingface',
    base_url: 'https://router.huggingface.co/v1',
    models: [
      'Qwen/Qwen3.5-397B-A17B',
      'Qwen/Qwen3.5-35B-A3B',
      'deepseek-ai/DeepSeek-V3.2',
      'moonshotai/Kimi-K2.5',
      'MiniMaxAI/MiniMax-M2.5',
      'zai-org/GLM-5',
      'XiaomiMiMo/MiMo-V2-Flash',
      'moonshotai/Kimi-K2-Thinking',
    ],
  },
  {
    label: 'Xiaomi MiMo',
    value: 'xiaomi',
    base_url: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-flash'],
  },
  {
    label: 'Kilo Code',
    value: 'kilocode',
    base_url: 'https://api.kilo.ai/api/gateway',
    models: [
      'anthropic/claude-opus-4.6',
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.4',
      'google/gemini-3-pro-preview',
      'google/gemini-3-flash-preview',
    ],
  },
  {
    label: 'Vercel AI Gateway',
    value: 'ai-gateway',
    base_url: 'https://ai-gateway.vercel.sh/v1',
    models: [
      'anthropic/claude-opus-4.6',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-haiku-4.5',
      'openai/gpt-5',
      'openai/gpt-4.1',
      'openai/gpt-4.1-mini',
      'google/gemini-3-pro-preview',
      'google/gemini-3-flash',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-v3.2',
    ],
  },
  {
    label: 'CLIProxyAPI',
    value: 'cliproxyapi',
    base_url: 'http://127.0.0.1:8317/v1',
    models: [
      'gpt-5.5',
      'gpt-5-codex',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'gemini-3.1-pro-preview',
      'gemini-2.5-pro',
    ],
  },
  {
    label: 'OpenCode Zen',
    value: 'opencode-zen',
    base_url: 'https://opencode.ai/zen/v1',
    models: [
      'gpt-5.4-pro',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5.1',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5',
      'gpt-5-codex',
      'gpt-5-nano',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-sonnet-4',
      'claude-haiku-4-5',
      'claude-3-5-haiku',
      'gemini-3.1-pro',
      'gemini-3-pro',
      'gemini-3-flash',
      'minimax-m2.7',
      'minimax-m2.5',
      'minimax-m2.5-free',
      'minimax-m2.1',
      'glm-5',
      'glm-4.7',
      'glm-4.6',
      'kimi-k2.5',
      'kimi-k2-thinking',
      'kimi-k2',
      'qwen3-coder',
      'big-pickle',
    ],
  },
  {
    label: 'OpenCode Go',
    value: 'opencode-go',
    base_url: 'https://opencode.ai/zen/go/v1',
    models: ['glm-5.1', 'glm-5', 'kimi-k2.5', 'mimo-v2-pro', 'mimo-v2-omni', 'minimax-m2.7', 'minimax-m2.5'],
  },
  {
    label: 'OpenAI Codex',
    value: 'openai-codex',
    base_url: 'https://chatgpt.com/backend-api/codex',
    models: ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'],
  },
  {
    label: 'Arcee AI',
    value: 'arcee',
    base_url: 'https://api.arcee.ai/v1',
    models: ['trinity-large-thinking', 'trinity-large-preview', 'trinity-mini'],
  },
  {
    label: 'OpenRouter',
    value: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    models: [],
  },
  {
    label: 'GitHub Copilot',
    value: 'copilot',
    base_url: 'https://api.githubcopilot.com',
    models: [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5-mini',
      'gpt-5.3-codex',
      'gpt-5.2-codex',
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-mini',
      'claude-sonnet-4.6',
      'claude-sonnet-4',
      'claude-sonnet-4.5',
      'claude-haiku-4.5',
      'gemini-3.1-pro-preview',
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'grok-code-fast-1',
    ],
  },
]

/** Build a Record<providerKey, models[]> for backend lookup */
export function buildProviderModelMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const p of PROVIDER_PRESETS) {
    if (p.models.length > 0) {
      map[p.value] = p.models
    }
  }
  return map
}
