import { generateHermesText } from './hermes/dynamic-llm'

export interface StrategicDebateResult {
  alphaProposal: string
  betaRebuttal: string
  primeDecision: string
  mode: 'hermes-gateway' | 'custom-provider' | 'local-fallback'
}

const MAX_CONTEXT_CHARS = 6_000
const DEBATE_TURN_TIMEOUT_MS = 18_000
export const SAFE_GATEWAY_ALERT = '[System Alert] Gateway parsing intercepted. Safe mode engaged.'
const GATEWAY_ERROR_PATTERNS = [
  /NoneType/i,
  /object is not iterable/i,
  /\bTraceback\b/i,
  /\bTypeError\b/i,
  /\bValueError\b/i,
  /\bInternal Server Error\b/i,
  /\bHTTP\s*500\b/i,
  /\b500\b.*\berror\b/i,
]

function compactJson(value: unknown, maxChars = MAX_CONTEXT_CHARS): string {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 1)}…`
}

function trimAnswer(text: string): string {
  return text.replace(/\r/g, '').trim()
}

function assertUsableText(text: string, source: string): string {
  const trimmed = trimAnswer(text)
  if (!trimmed) throw new Error(`${source} returned empty text`)
  if (GATEWAY_ERROR_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    throw new Error(`${source} returned gateway error text`)
  }
  return trimmed
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise
      .then(resolve)
      .catch(reject)
      .finally(() => {
        if (timeout) clearTimeout(timeout)
      })
  })
}

async function runDebateTurn(
  instructions: string,
  input: string,
  maxTokens: number,
  temperature: number,
): Promise<{ text: string; mode: 'hermes-gateway' | 'custom-provider' }> {
  const result = await withTimeout(generateHermesText({
    instructions,
    input,
    maxTokens,
    temperature,
    priority: 'high',
    taskKind: 'mirofish-active-debate',
  }), DEBATE_TURN_TIMEOUT_MS, 'Hermes debate turn')

  return {
    text: assertUsableText(result.text, 'Hermes debate turn'),
    mode: result.runtime.mode,
  }
}

function buildLocalFallbackDebate(
  portfolio: unknown,
  news: unknown,
  financialState: unknown,
): StrategicDebateResult {
  const portfolioContext = compactJson(portfolio, 900)
  const newsContext = typeof news === 'string' ? news.slice(0, 900) : compactJson(news, 900)
  const financialContext = compactJson(financialState, 900)

  return {
    alphaProposal: [
      SAFE_GATEWAY_ALERT,
      'Alpha fallback: 暫停激進加碼，只保留觀察清單與紙上推演；等待 gateway/LLM 恢復後再重跑完整攻擊策略。',
      `Portfolio snapshot: ${portfolioContext}`,
    ].join('\n'),
    betaRebuttal: [
      SAFE_GATEWAY_ALERT,
      'Beta fallback: 啟動防禦模式。禁止新增真實曝險，優先檢查現金流、停損線、集中持倉與資料來源可信度。',
      `News snapshot: ${newsContext || 'no external news'}`,
    ].join('\n'),
    primeDecision: [
      SAFE_GATEWAY_ALERT,
      '## 資產操作判定',
      'AI 辯論未能穩定完成，Aurora 已切換 local fallback。今日僅允許 research / paper trading，不輸出真實交易指令。',
      '',
      '## 今日行動指令',
      `確認 LifeOS 現金流與風險上限；重跑 gateway 前先使用保守 WATCH 判定。Financial snapshot: ${financialContext}`,
    ].join('\n'),
    mode: 'local-fallback',
  }
}

export async function runStrategicDebate(
  portfolio: unknown,
  news: unknown,
  financialState: unknown,
): Promise<StrategicDebateResult> {
  const portfolioContext = compactJson(portfolio)
  const newsContext = typeof news === 'string' ? news.slice(0, MAX_CONTEXT_CHARS) : compactJson(news)
  const financialContext = compactJson(financialState)

  try {
    const alpha = await runDebateTurn(
      [
        '你是極度激進的 Alpha 尋找者。你的任務是從市場情報中找出獲利機會。',
        '忽略個人財務預算，專注於資產本身的動能、題材催化、技術強度與市場情緒。',
        '語氣要貪婪、敏銳，但仍需以可驗證資料為基礎。',
        '輸出一段「攻擊策略」提案，限制 220 字以內。',
      ].join('\n'),
      [
        '【持股損益 / Portfolio】',
        portfolioContext,
        '',
        '【最新新聞 / Market Intel】',
        newsContext || '沒有外部新聞；請只根據持股損益推論攻擊策略。',
      ].join('\n'),
      420,
      0.35,
    )

    const beta = await runDebateTurn(
      [
        '你是極度悲觀且嚴格的風險控管專家。',
        '你的唯一目標是防止破產、避免現金流斷裂、阻止預算超支擴散。',
        '你極度厭惡風險、槓桿、集中曝險與情緒性交易。',
        '語氣要冷酷、嚴厲、充滿警告意味。',
        '請針對 OpenClaw 的攻擊策略進行反駁，並提出防禦性建議：停損、停利、降低支出或暫停交易。',
        '限制 260 字以內。',
      ].join('\n'),
      [
        '【OpenClaw 攻擊策略提案】',
        alpha.text,
        '',
        '【目前 LifeOS 財務狀態】',
        financialContext,
      ].join('\n'),
      520,
      0.2,
    )

    const prime = await runDebateTurn(
      [
        '你是 LifeOS 的最高指揮官，負責推動使用者的 FIRE（財務獨立、提早退休）計畫。',
        '你現在面臨情報派與風控派的意見分歧。',
        '請綜合雙方觀點，以冷靜、客觀、幕僚式口吻輸出最終 Markdown 戰略總結。',
        '必須包含兩個二級標題：',
        '## 資產操作判定',
        '## 今日行動指令',
        '不可構成真實投資建議；只能提供研究、風控、紙上推演、記帳與 FIRE 變現任務。',
        '限制 420 字以內。',
      ].join('\n'),
      [
        '【Agent Alpha / OpenClaw 論點】',
        alpha.text,
        '',
        '【Agent Beta / MiroFish 論點】',
        beta.text,
        '',
        '【LifeOS 財務狀態】',
        financialContext,
      ].join('\n'),
      760,
      0.25,
    )

    return {
      alphaProposal: alpha.text,
      betaRebuttal: beta.text,
      primeDecision: prime.text,
      mode: prime.mode,
    }
  } catch {
    return buildLocalFallbackDebate(portfolio, news, financialState)
  }
}
