import { scheduleLlmTask } from './hermes/llm-scheduler'

interface MiroFishOpenAIResponse {
  output_text?: string
  output?: Array<{
    content?: Array<{ text?: string }>
  }>
}

function getOpenAiApiKey(): string {
  return (process.env.MIROFISH_OPENAI_API_KEY || process.env.NEXUS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '').trim()
}

function getModel(): string {
  return (process.env.MIROFISH_OPENAI_MODEL || process.env.NEXUS_OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim()
}

function extractResponseText(body: MiroFishOpenAIResponse): string {
  if (typeof body.output_text === 'string' && body.output_text.trim()) return body.output_text.trim()
  return (body.output || [])
    .flatMap((item) => item.content || [])
    .map((chunk) => chunk.text || '')
    .join('')
    .trim()
}

function normalizeIntel(text: string, maxChars = 500): string {
  const normalized = text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized
}

function localExtract(rawText: string): string {
  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  const priority = lines.filter((line) => (
    /risk|valuation|margin|demand|sentiment|cycle|dividend|FIRE|風險|估值|需求|週期|殖利率|現金/i.test(line)
  ))
  const selected = priority.length > 0 ? priority : lines
  return normalizeIntel(selected.slice(0, 4).join('\n'))
}

export async function extractActionableIntel(rawText: string): Promise<string> {
  const source = normalizeIntel(rawText, 2400)
  if (!source) return ''

  const apiKey = getOpenAiApiKey()
  if (!apiKey) return localExtract(source)

  try {
    const response = await scheduleLlmTask(() => fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: getModel(),
        input: [
          {
            role: 'system',
            content: '你是 MiroFish 資料清洗師。將外部情報壓縮成 500 字內，聚焦 FIRE、風控、現金流、投資曝險。短句、不要廢話。',
          },
          { role: 'user', content: source },
        ],
        temperature: 0.1,
        max_output_tokens: 220,
        store: false,
      }),
      signal: AbortSignal.timeout(12_000),
    }), {
      priority: 'medium',
      kind: 'mirofish-intel-extraction',
    })

    if (!response.ok) return localExtract(source)
    const body = await response.json() as MiroFishOpenAIResponse
    return normalizeIntel(extractResponseText(body)) || localExtract(source)
  } catch {
    return localExtract(source)
  }
}
