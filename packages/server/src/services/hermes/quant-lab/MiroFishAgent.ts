export type MiroFishAgentRole = 'macro' | 'bull' | 'bear' | 'judge'

export type MiroFishDebateEvidenceImportance = 'low' | 'medium' | 'high'

export interface MiroFishDebateEvidenceItem {
  category: string
  source: string
  title: string
  summary: string
  url?: string
  publishedAt?: string
  tickers?: string[]
  importance?: MiroFishDebateEvidenceImportance
}

export interface MiroFishDebateCandidate {
  ticker: string
  score: number
  action: string
  risk: string
  trend?: string
  price?: number
  reason?: string
}

export interface MiroFishDebateEvidencePack {
  topic?: string
  domain?: 'financial' | 'universal'
  agentLabels?: {
    context: string
    proponent: string
    risk: string
    judge: string
  }
  phase?: string
  generatedAt?: string
  source?: string
  marketRegime?: string
  macroData?: {
    vix?: number | null
    tenYearYield?: number | null
    cpi?: number | null
  }
  dataHealth?: {
    status?: string
    quoteSource?: string
    quoteCoverage?: string
    providerErrors?: string[]
  }
  riskGate?: {
    status?: string
    reason?: string
    prohibited?: string[]
  }
  paperAccount?: {
    equity?: number
    cash?: number
    positions?: Array<{ ticker: string; value?: number; pnlPct?: number; risk?: string }>
  }
  topCandidates?: MiroFishDebateCandidate[]
  evidence: MiroFishDebateEvidenceItem[]
  openClawMemoryContext?: string
}

export interface MiroFishAgentArgument {
  role: MiroFishAgentRole
  title: string
  content: string
  citations: string[]
  generatedAt: string
}

export interface MiroFishMacroJson {
  Regime: 'Risk-On' | 'Chop' | 'Risk-Off'
  RiskMultiplier: number
  MacroInsight: string
}

export interface MiroFishScenarioJudgement {
  probability: number
  confidence: number
  reasoning: string
}

export interface MiroFishJudgeJson {
  scenarios: {
    bullish: MiroFishScenarioJudgement
    neutral: MiroFishScenarioJudgement
    bearish: MiroFishScenarioJudgement
  }
  key_risks: string[]
}

export interface MiroFishDebateResult extends MiroFishJudgeJson {
  macro: MiroFishMacroJson
  bull: MiroFishAgentArgument
  bear: MiroFishAgentArgument
  judgeRaw: string
  mode: 'local' | 'model' | 'safe-fallback'
  ok: boolean
  error?: string
  generatedAt: string
}

export type MiroFishModelMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type MiroFishModelCaller = (
  messages: MiroFishModelMessage[],
  options: { role: MiroFishAgentRole; responseFormat: 'text' | 'json' }
) => Promise<string>

export interface RunMiroFishDebateOptions {
  callModel?: MiroFishModelCaller
  mode?: 'local' | 'model' | 'auto'
  timeoutMs?: number
}

export const MIROFISH_SAFE_GATEWAY_ALERT = '[System Alert] Gateway parsing intercepted. Safe mode engaged.'

const DEFAULT_MODEL_TIMEOUT_MS = 18_000

const RAW_GATEWAY_ERROR_PATTERNS = [
  /\bTraceback\b/i,
  /\bPython\b/i,
  /\bSyntaxError\b/i,
  /\bJSONDecodeError\b/i,
  /\bPydantic\b/i,
  /\bValidationError\b/i,
  /\bTypeError\b/i,
  /\bValueError\b/i,
  /NoneType/i,
  /object is not iterable/i,
  /\bInternal Server Error\b/i,
  /\bHTTP\s*500\b/i,
]

export const PREMIUM_QUANT_ANALYST_PERSONA_PROMPT = `Tone & Persona Constraints (語氣與角色設定):
1. 請扮演任職於頂級避險基金的資深量化分析師。受眾是「懂基本金融概念，但無暇看盤的高階經理人」。
2. 平易近人：用白話文解釋技術指標（例如：不要只說「乖離過大」，要說「短期漲幅已超過歷史平均，有回調風險」）。
3. 專業嚴謹：必須提供明確的數據支撐（勝率、信用分、VIX 狀態）。
4. 情緒穩定：客觀冷靜，強調系統的防禦機制正在運作。`

export const MACRO_AGENT_SYSTEM_PROMPT = `你是 MiroFish 多智能體推演系統中的「Macro Regime Dictator（總經氣象局長）」。

${PREMIUM_QUANT_ANALYST_PERSONA_PROMPT}

任務：
1. 你必須在 Bull/Bear Agent 之前先判斷市場天候，且你的結論會限制後續所有多空論點。
2. 僅根據 evidencePack 中的總經資料與風控資料判斷：VIX、10Y Yield、CPI、QQQ/大盤狀態、資料健康度與 risk gate。
3. 若 VIX 偏高、10Y 快速上升、CPI 壓力偏高、資料來源 degraded/fallback/error，必須降低 RiskMultiplier。
4. 這是 paper trading / research only；不可輸出真實交易指令。

強制輸出格式：
你最終必須且只能輸出一個 JSON 物件，不得包含 Markdown、不得包含 \`\`\`json、不得包含前後說明文字。
格式必須完全符合：
{
  "Regime": "Risk-On",
  "RiskMultiplier": 0.85,
  "MacroInsight": "VIX 低於 18 且 10Y 未快速上升，市場天候支持風險資產，但仍需監控 CPI 與資料品質。"
}

Regime 僅能是 "Risk-On"、"Chop"、"Risk-Off"。
RiskMultiplier 必須介於 0.0 到 1.0。`

export const BULL_AGENT_SYSTEM_PROMPT = `你是 MiroFish 多智能體推演系統中的「Alpha 挖掘者」。

${PREMIUM_QUANT_ANALYST_PERSONA_PROMPT}

任務：
1. 只根據 evidencePack 內的證據尋找突破點、基本面催化劑、資金流、趨勢延續與做多理由。
2. 你可以提出 paper trading 觀察與情境假設，但不可要求真實下單、不可繞過風控、不可捏造資料。
3. 對資料源狀態要敏感：若 quote/news/candle 有 fallback、degraded 或 provider error，必須降低語氣確定性。
4. 請用繁體中文、專業量化研究員口吻輸出，保留 ticker 英文縮寫。

輸出要求：
- 先列出 3 到 5 條最強多方論點。
- 每條論點都要引用 evidencePack 中的來源或標題。
- 最後給出「多方勝率提升條件」與「仍需驗證的缺口」。
- 不要輸出 JSON。`

export const BEAR_AGENT_SYSTEM_PROMPT = `你是 MiroFish 多智能體推演系統中的「黑天鵝防禦者」。

${PREMIUM_QUANT_ANALYST_PERSONA_PROMPT}

任務：
1. 對 evidencePack 進行壓力測試，找出不該買入、需要降權或只准觀察的致命理由。
2. 優先檢查技術面乖離過大、VIX 急升、10Y 快速上升、QQQ 跌破均線、單檔持倉上限、資料來源異常、財報或世界新聞風險。
3. 你可以提出 paper trading 風控限制，但不可要求真實下單、不可繞過 Hermes risk gate。
4. 若資料品質 degraded/fallback/mock，必須把它視為核心風險。
5. 請用繁體中文、專業風控長口吻輸出，保留 ticker 英文縮寫。

輸出要求：
- 先列出 3 到 5 條最強反方或風險論點。
- 每條論點都要引用 evidencePack 中的來源或標題。
- 最後給出「禁止加碼條件」與「需要人工確認的資料」。
- 不要輸出 JSON。`

export const JUDGE_AGENT_SYSTEM_PROMPT = `你是 MiroFish 多智能體推演系統中的「首席裁決官」。

${PREMIUM_QUANT_ANALYST_PERSONA_PROMPT}

任務：
1. 閱讀 evidencePack、Bull Agent 論點與 Bear Agent 論點。
2. 將多空論點客觀收斂成三套情境：bullish、neutral、bearish。
3. 機率總和必須等於 1。confidence 需介於 0 到 1。
4. 若資料來源 degraded/fallback/provider error，必須降低 confidence，並把資料風險列入 key_risks。
5. 這是 paper trading / research only；AI 只能提出建議，不可輸出真實下單指令。

強制輸出格式：
你最終必須且只能輸出一個 JSON 物件，不得包含 Markdown、不得包含 \`\`\`json、不得包含前後說明文字。
格式必須完全符合：
{
  "scenarios": {
    "bullish": { "probability": 0.6, "confidence": 0.8, "reasoning": "..." },
    "neutral": { "probability": 0.3, "confidence": 0.9, "reasoning": "..." },
    "bearish": { "probability": 0.1, "confidence": 0.7, "reasoning": "..." }
  },
  "key_risks": ["VIX 處於上升通道", "財報將近"]
}`

export const UNIVERSAL_CONTEXT_AGENT_SYSTEM_PROMPT = `你是 MiroFish Universal Brain 中的「Contextual Analyst（脈絡分析師）」。

任務：
1. 你面對的主題可能是軟體架構、產品策略、人生決策、研究計畫或其他非金融問題。
2. 先判斷此主題的外部環境、限制條件、不可逆風險與資訊完整度。
3. 不要使用真實交易語言；RiskMultiplier 代表「可執行信心/風險折減」，不是投資倉位。

強制輸出格式：
你最終必須且只能輸出一個 JSON 物件，不得包含 Markdown、不得包含 \`\`\`json、不得包含前後說明文字。
格式必須完全符合：
{
  "Regime": "Chop",
  "RiskMultiplier": 0.68,
  "MacroInsight": "此主題有明確收益但仍有治理與維護成本，適合用小步驗證而不是一次性押注。"
}

Regime 僅能是 "Risk-On"、"Chop"、"Risk-Off"。
RiskMultiplier 必須介於 0.0 到 1.0。`

export const UNIVERSAL_PROPONENT_AGENT_SYSTEM_PROMPT = `你是 MiroFish Universal Brain 中的「Proponent Agent（正方推進者）」。

任務：
1. 只根據 evidencePack 支持主題可行、值得嘗試或應該推進的理由。
2. 請找出收益、槓桿、學習價值、可逆性、試點路徑與成功條件。
3. 請用繁體中文、清楚條列，避免金融術語與下單語言。

輸出要求：
- 先列出 3 到 5 條最強正方論點。
- 最後給出「推進條件」與「仍需驗證的缺口」。
- 不要輸出 JSON。`

export const UNIVERSAL_RISK_AGENT_SYSTEM_PROMPT = `你是 MiroFish Universal Brain 中的「Risk Assessor Agent（風險評估者）」。

任務：
1. 對主題進行壓力測試，找出不該推進、需要延後、需要縮小範圍或需要人工確認的理由。
2. 優先檢查不可逆成本、維護成本、資訊不足、權限/治理、安全與長期依賴風險。
3. 請用繁體中文、清楚條列，避免金融術語與下單語言。

輸出要求：
- 先列出 3 到 5 條最強反方或風險論點。
- 最後給出「停止條件」與「需要人工確認的資料」。
- 不要輸出 JSON。`

export const UNIVERSAL_JUDGE_AGENT_SYSTEM_PROMPT = `你是 MiroFish Universal Brain 中的「Hermes Synthesizer（綜合裁決者）」。

任務：
1. 閱讀 evidencePack、Proponent Agent 與 Risk Assessor Agent 論點。
2. 將論點收斂成三套情境：bullish 代表值得推進、neutral 代表保留/試點、bearish 代表暫緩或否決。
3. 機率總和必須等於 1。confidence 需介於 0 到 1。

強制輸出格式：
你最終必須且只能輸出一個 JSON 物件，不得包含 Markdown、不得包含 \`\`\`json、不得包含前後說明文字。
格式必須完全符合：
{
  "scenarios": {
    "bullish": { "probability": 0.45, "confidence": 0.72, "reasoning": "..." },
    "neutral": { "probability": 0.35, "confidence": 0.76, "reasoning": "..." },
    "bearish": { "probability": 0.20, "confidence": 0.66, "reasoning": "..." }
  },
  "key_risks": ["維護成本未估清", "缺少小規模驗證"]
}`

export async function runMiroFishDebate(
  evidencePack: MiroFishDebateEvidencePack,
  options: RunMiroFishDebateOptions = {},
): Promise<MiroFishDebateResult> {
  const generatedAt = new Date().toISOString()
  const shouldUseModel = Boolean(options.callModel) && options.mode !== 'local'

  if (!shouldUseModel) {
    return buildLocalDebateResult(evidencePack, generatedAt)
  }

  try {
    const universalMode = isUniversalDebate(evidencePack)
    const evidencePrompt = buildEvidenceUserPrompt(evidencePack)
    const memoryContext = evidencePack.openClawMemoryContext || ''
    const callModel = (messages: MiroFishModelMessage[], callOptions: { role: MiroFishAgentRole; responseFormat: 'text' | 'json' }) =>
      callModelWithTimeout(options.callModel!(messages, callOptions), options.timeoutMs || DEFAULT_MODEL_TIMEOUT_MS, callOptions.role)

    const macroRaw = await callModel([
      { role: 'system', content: appendMemoryToSystemPrompt(universalMode ? UNIVERSAL_CONTEXT_AGENT_SYSTEM_PROMPT : MACRO_AGENT_SYSTEM_PROMPT, memoryContext, universalMode) },
      { role: 'user', content: buildMacroUserPrompt(evidencePack) },
    ], { role: 'macro', responseFormat: 'json' })
    const macro = normalizeMacroJson(parseMacroJson(macroRaw))
    const macroContext = buildMacroContext(macro, universalMode)

    const bullRaw = await callModel([
      { role: 'system', content: appendMacroToSystemPrompt(appendMemoryToSystemPrompt(universalMode ? UNIVERSAL_PROPONENT_AGENT_SYSTEM_PROMPT : BULL_AGENT_SYSTEM_PROMPT, memoryContext, universalMode), macroContext, universalMode) },
      { role: 'user', content: evidencePrompt },
    ], { role: 'bull', responseFormat: 'text' })

    const bearRaw = await callModel([
      { role: 'system', content: appendMacroToSystemPrompt(appendMemoryToSystemPrompt(universalMode ? UNIVERSAL_RISK_AGENT_SYSTEM_PROMPT : BEAR_AGENT_SYSTEM_PROMPT, memoryContext, universalMode), macroContext, universalMode) },
      { role: 'user', content: evidencePrompt },
    ], { role: 'bear', responseFormat: 'text' })

    const judgeRaw = await callModel([
      { role: 'system', content: appendMacroToSystemPrompt(appendMemoryToSystemPrompt(universalMode ? UNIVERSAL_JUDGE_AGENT_SYSTEM_PROMPT : JUDGE_AGENT_SYSTEM_PROMPT, memoryContext, universalMode), macroContext, universalMode) },
      {
        role: 'user',
        content: [
          evidencePrompt,
          '',
          '# Bull Agent Argument',
          bullRaw,
          '',
          '# Bear Agent Argument',
          bearRaw,
        ].join('\n'),
      },
    ], { role: 'judge', responseFormat: 'json' })

    const judge = normalizeJudgeJson(parseJudgeJson(judgeRaw))
    return {
      ...judge,
      macro,
      bull: buildArgument('bull', universalMode ? universalAgentLabels(evidencePack).proponent : 'Alpha 挖掘者', bullRaw, evidencePack, generatedAt),
      bear: buildArgument('bear', universalMode ? universalAgentLabels(evidencePack).risk : '黑天鵝防禦者', bearRaw, evidencePack, generatedAt),
      judgeRaw: JSON.stringify(judge),
      mode: 'model',
      ok: true,
      generatedAt,
    }
  } catch (error) {
    const fallback = buildSafeFallbackDebateResult(evidencePack, generatedAt, error)
    return {
      ...fallback,
      ok: false,
      error: MIROFISH_SAFE_GATEWAY_ALERT,
    }
  }
}

function callModelWithTimeout<T>(promise: Promise<T>, timeoutMs: number, role: MiroFishAgentRole): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`MiroFish ${role} agent timed out after ${timeoutMs}ms`)), timeoutMs)
    promise
      .then(resolve)
      .catch(reject)
      .finally(() => {
        if (timeout) clearTimeout(timeout)
      })
  })
}

function buildSafeFallbackDebateResult(evidencePack: MiroFishDebateEvidencePack, generatedAt: string, error: unknown): MiroFishDebateResult {
  const fallback = buildLocalDebateResult(evidencePack, generatedAt)
  const safeReason = gatewaySafeErrorMessage(error)
  const judge: MiroFishJudgeJson = {
    scenarios: fallback.scenarios,
    key_risks: [safeReason, ...fallback.key_risks].slice(0, 8),
  }
  return {
    ...fallback,
    ...judge,
    macro: {
      ...fallback.macro,
      MacroInsight: `${fallback.macro.MacroInsight} ${safeReason}`,
    },
    bull: {
      ...fallback.bull,
      content: `${safeReason}\n${fallback.bull.content}`,
    },
    bear: {
      ...fallback.bear,
      content: `${safeReason}\n${fallback.bear.content}`,
    },
    judgeRaw: JSON.stringify(judge),
    mode: 'safe-fallback',
    generatedAt,
  }
}

function gatewaySafeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || '')
  if (!text.trim()) return MIROFISH_SAFE_GATEWAY_ALERT
  if (RAW_GATEWAY_ERROR_PATTERNS.some(pattern => pattern.test(text))) return MIROFISH_SAFE_GATEWAY_ALERT
  return MIROFISH_SAFE_GATEWAY_ALERT
}

function isUniversalDebate(evidencePack: MiroFishDebateEvidencePack): boolean {
  return evidencePack.domain === 'universal' || Boolean(evidencePack.topic && !evidencePack.topCandidates?.length)
}

function universalAgentLabels(evidencePack: MiroFishDebateEvidencePack) {
  return {
    context: evidencePack.agentLabels?.context || 'Contextual Analyst',
    proponent: evidencePack.agentLabels?.proponent || 'Proponent Agent',
    risk: evidencePack.agentLabels?.risk || 'Risk Assessor Agent',
    judge: evidencePack.agentLabels?.judge || 'Hermes Synthesizer',
  }
}

function buildEvidenceUserPrompt(evidencePack: MiroFishDebateEvidencePack): string {
  if (isUniversalDebate(evidencePack)) {
    return [
      '請只根據以下 evidencePack 進行跨領域情境推演。',
      '這不是金融交易任務；禁止輸出真實交易、投資或下單指令。',
      '請圍繞 topic 評估可行性、收益、風險、試點路徑與停止條件。',
      '',
      sanitizeJsonForPrompt(evidencePack),
    ].join('\n')
  }

  return [
    '請只根據以下 evidencePack 進行情境推演。',
    '禁止輸出真實交易指令，所有交易相關描述都必須限於 paper trading / research。',
    '',
    sanitizeJsonForPrompt(evidencePack),
  ].join('\n')
}

function buildMacroUserPrompt(evidencePack: MiroFishDebateEvidencePack): string {
  if (isUniversalDebate(evidencePack)) {
    return [
      '請先判斷此主題的整體脈絡與可執行信心。只回傳指定 JSON，不要輸出 Markdown。',
      'Universal Brain inputs:',
      JSON.stringify({
        topic: evidencePack.topic || 'unknown topic',
        dataHealth: evidencePack.dataHealth || {},
        riskGate: evidencePack.riskGate || {},
        evidence: evidencePack.evidence.slice(0, 14),
      }, null, 2),
    ].join('\n')
  }

  return [
    '請先判斷總經 regime。只回傳指定 JSON，不要輸出 Markdown。',
    'Macro inputs:',
    JSON.stringify({
      marketRegime: evidencePack.marketRegime || 'unknown',
      macroData: evidencePack.macroData || {},
      dataHealth: evidencePack.dataHealth || {},
      riskGate: evidencePack.riskGate || {},
      topCandidates: (evidencePack.topCandidates || []).slice(0, 5),
      macroEvidence: evidencePack.evidence.filter(item => ['macro', 'world-news', 'bond', 'vix', 'risk', 'system'].includes(item.category)).slice(0, 12),
    }, null, 2),
  ].join('\n')
}

function appendMemoryToSystemPrompt(systemPrompt: string, memoryContext: string, universalMode = false): string {
  const trimmed = memoryContext.trim()
  if (!trimmed) return systemPrompt
  return [
    systemPrompt,
    '',
    universalMode
      ? '以下是 Aurora Memory Constellation 喚醒的歷史檢討記憶。這些內容只能作為跨領域推演的經驗約束：'
      : '以下是 OpenClaw 背景層喚醒的歷史檢討記憶。這些內容不是交易指令，只能作為 paper trading 推演的風險校準與經驗約束：',
    trimmed,
  ].join('\n')
}

function appendMacroToSystemPrompt(systemPrompt: string, macroContext: string, universalMode = false): string {
  return [
    systemPrompt,
    '',
    macroContext,
    universalMode
      ? '你接下來的所有推演都必須服從 Contextual Analyst 的脈絡約束；若 RiskMultiplier 低於 0.5，必須明確說明為何只能試點、延後或縮小範圍。'
      : '你接下來的所有推演都必須服從 Macro Regime Dictator 的市場天候約束；若 RiskMultiplier 低於 0.5，必須明確說明為何只能觀察或降權。',
  ].join('\n')
}

function buildMacroContext(macro: MiroFishMacroJson, universalMode = false): string {
  return [
    universalMode ? '[Contextual Analyst Context]' : '[Macro Regime Dictator Context]',
    `Regime: ${macro.Regime}`,
    `RiskMultiplier: ${macro.RiskMultiplier.toFixed(2)}`,
    `MacroInsight: ${macro.MacroInsight}`,
  ].join('\n')
}

function buildLocalDebateResult(evidencePack: MiroFishDebateEvidencePack, generatedAt: string): MiroFishDebateResult {
  const macro = buildLocalMacroJson(evidencePack)
  const bull = buildLocalBullArgument(evidencePack, generatedAt)
  const bear = buildLocalBearArgument(evidencePack, generatedAt)
  const judge = buildLocalJudge(evidencePack, bull, bear, macro)
  return {
    ...judge,
    macro,
    bull,
    bear,
    judgeRaw: JSON.stringify(judge),
    mode: 'local',
    ok: true,
    generatedAt,
  }
}

function buildLocalBullArgument(evidencePack: MiroFishDebateEvidencePack, generatedAt: string): MiroFishAgentArgument {
  if (isUniversalDebate(evidencePack)) {
    const labels = universalAgentLabels(evidencePack)
    const topic = evidencePack.topic || 'this decision'
    const highEvidence = evidencePack.evidence.filter(item => item.importance !== 'low').slice(0, 4)
    const lines = [
      `主題：「${topic}」。正方先尋找可逆、可試點、可累積學習的推進路徑。`,
      ...highEvidence.map(item => `${item.title}: ${item.summary}`),
      '推進條件：先用低成本試點驗證核心假設，明確定義成功指標、回滾方式與責任邊界。',
      '仍需驗證的缺口：維護成本、長期治理、使用者接受度、資料/權限風險與替代方案比較。',
    ]
    return buildArgument('bull', labels.proponent, lines.join('\n'), evidencePack, generatedAt)
  }

  const candidates = evidencePack.topCandidates || []
  const leading = candidates
    .filter(candidate => candidate.score >= 85 && ['BUY', 'WATCH'].includes(candidate.action))
    .slice(0, 5)
  const highEvidence = evidencePack.evidence
    .filter(item => item.importance === 'high' && !isRiskEvidence(item))
    .slice(0, 4)
  const memoryContext = evidencePack.openClawMemoryContext?.trim()

  const lines = [
    evidencePack.macroData ? `總經守門：${buildMacroContext(buildLocalMacroJson(evidencePack)).replace(/\n/g, ' / ')}` : '',
    memoryContext ? `歷史記憶提醒：${firstMemoryLesson(memoryContext)}` : '',
    leading.length
      ? `高分候選 ${leading.map(candidate => `${candidate.ticker} ${candidate.score} ${candidate.action}`).join(' / ')} 提供多方觀察名單。`
      : '目前沒有足夠明確的高分多方候選，正向情境需保守解讀。',
    ...highEvidence.map(item => `${item.title}: ${item.summary}`),
    evidencePack.marketRegime
      ? `市場狀態為 ${evidencePack.marketRegime}，若風控未封鎖，可支持小倉位 paper watchlist 驗證。`
      : '',
    '多方勝率提升條件：價格維持在趨勢線上方、VIX/10Y 不惡化、資料來源保持 real/partial 且 paper guard 允許。',
    '仍需驗證缺口：即時新聞、財報日期、盤中流動性與是否有 provider error。',
  ].filter(Boolean)

  return buildArgument('bull', 'Alpha 挖掘者', lines.join('\n'), evidencePack, generatedAt)
}

function buildLocalBearArgument(evidencePack: MiroFishDebateEvidencePack, generatedAt: string): MiroFishAgentArgument {
  if (isUniversalDebate(evidencePack)) {
    const labels = universalAgentLabels(evidencePack)
    const topic = evidencePack.topic || 'this decision'
    const riskEvidence = evidencePack.evidence.filter(isRiskEvidence).slice(0, 5)
    const lines = [
      `主題：「${topic}」。風險方先檢查不可逆成本、治理缺口、長期依賴與資訊不足。`,
      ...riskEvidence.map(item => `${item.title}: ${item.summary}`),
      '停止條件：若試點無法量化收益、回滾成本過高、責任邊界不清或安全/治理無法驗證，應暫緩推進。',
      '需要人工確認的資料：實際使用情境、維護人力、決策權限、風險承擔者與替代方案成本。',
    ]
    return buildArgument('bear', labels.risk, lines.join('\n'), evidencePack, generatedAt)
  }

  const riskEvidence = evidencePack.evidence.filter(isRiskEvidence).slice(0, 5)
  const providerErrors = evidencePack.dataHealth?.providerErrors || []
  const prohibited = evidencePack.riskGate?.prohibited || []
  const memoryContext = evidencePack.openClawMemoryContext?.trim()
  const lines = [
    `總經壓力測試：${buildLocalMacroJson(evidencePack).MacroInsight}`,
    memoryContext ? `歷史虧損/檢討記憶必須納入壓力測試：${firstMemoryLesson(memoryContext)}` : '',
    evidencePack.riskGate?.status
      ? `Risk gate 狀態 ${evidencePack.riskGate.status}: ${evidencePack.riskGate.reason || 'no reason'}`
      : 'Risk gate 未提供完整狀態，推演不能升級為自動買入。',
    ...riskEvidence.map(item => `${item.title}: ${item.summary}`),
    providerErrors.length ? `資料來源異常：${providerErrors.slice(0, 4).join(' | ')}` : '',
    prohibited.length ? `目前禁止條件：${prohibited.join(' / ')}` : '',
    '禁止加碼條件：VIX 急升、QQQ 跌破均線、10Y 快速上升、單檔超過上限、資料源 fallback/error。',
    '需要人工確認的資料：財報日期、重大新聞、成交量異常與宏觀事件時點。',
  ].filter(Boolean)

  return buildArgument('bear', '黑天鵝防禦者', lines.join('\n'), evidencePack, generatedAt)
}

function buildLocalJudge(
  evidencePack: MiroFishDebateEvidencePack,
  bull: MiroFishAgentArgument,
  bear: MiroFishAgentArgument,
  macro: MiroFishMacroJson,
): MiroFishJudgeJson {
  if (isUniversalDebate(evidencePack)) {
    const evidence = evidencePack.evidence || []
    const riskCount = evidence.filter(isRiskEvidence).length
    const supportCount = evidence.filter(item => item.importance === 'high' && !isRiskEvidence(item)).length
    const topic = evidencePack.topic || 'this decision'
    const macroPenalty = macro.Regime === 'Risk-Off' ? 0.16 : macro.Regime === 'Chop' ? 0.05 : 0
    const bullish = clamp(0.42 + supportCount * 0.05 - riskCount * 0.04 - macroPenalty, 0.12, 0.68)
    const bearish = clamp(0.18 + riskCount * 0.06 + macroPenalty, 0.1, 0.62)
    const neutral = clamp(1 - bullish - bearish, 0.12, 0.72)
    const normalized = normalizeProbabilities({ bullish, neutral, bearish })
    const confidenceBase = clamp(0.58 + Math.min(evidence.length, 16) * 0.012 - riskCount * 0.015, 0.38, 0.86)

    return normalizeJudgeJson({
      scenarios: {
        bullish: {
          probability: normalized.bullish,
          confidence: confidenceBase,
          reasoning: `值得推進情境：${firstSentence(bull.content)} ${topic} 可用小步試點降低未知數。`,
        },
        neutral: {
          probability: normalized.neutral,
          confidence: clamp(confidenceBase + 0.04, 0, 0.9),
          reasoning: `保留/試點情境：先定義成功指標與停止條件，再用有限範圍驗證。`,
        },
        bearish: {
          probability: normalized.bearish,
          confidence: clamp(confidenceBase - 0.02 + riskCount * 0.02, 0, 0.9),
          reasoning: `暫緩情境：${firstSentence(bear.content)} ${macro.MacroInsight}`,
        },
      },
      key_risks: deriveKeyRisks(evidencePack, bear),
    })
  }

  const candidates = evidencePack.topCandidates || []
  const evidence = evidencePack.evidence || []
  const buyCount = candidates.filter(candidate => candidate.action === 'BUY' && candidate.score >= 87 && candidate.risk !== 'H').length
  const watchCount = candidates.filter(candidate => candidate.action === 'WATCH' && candidate.score >= 87).length
  const highRiskCount = evidence.filter(item => item.importance === 'high' && isRiskEvidence(item)).length
  const degraded = ['DEGRADED', 'FALLBACK', 'ERROR'].includes(String(evidencePack.dataHealth?.status || '').toUpperCase())
  const blocked = String(evidencePack.riskGate?.status || '').toUpperCase().includes('BLOCK')

  const macroBearPenalty = macro.Regime === 'Risk-Off' ? 0.18 : macro.Regime === 'Chop' ? 0.07 : 0
  const macroBullPenalty = macro.Regime === 'Risk-Off' ? 0.12 : macro.Regime === 'Chop' ? 0.04 : 0
  const bullScore = buyCount * 0.08 + watchCount * 0.03 + evidence.filter(item => item.importance === 'high' && !isRiskEvidence(item)).length * 0.04 - macroBullPenalty
  const bearScore = highRiskCount * 0.08 + (degraded ? 0.14 : 0) + (blocked ? 0.25 : 0) + macroBearPenalty

  const bullish = clamp(0.34 + bullScore - bearScore * 0.55, 0.08, 0.72)
  const bearish = clamp(0.18 + bearScore - bullScore * 0.25, 0.08, 0.70)
  const neutral = clamp(1 - bullish - bearish, 0.10, 0.70)
  const normalized = normalizeProbabilities({ bullish, neutral, bearish })
  const confidenceBase = clamp(0.52 + Math.min(evidence.length, 24) * 0.012 - (degraded ? 0.14 : 0) - (blocked ? 0.08 : 0), 0.35, 0.88)
  const keyRisks = deriveKeyRisks(evidencePack, bear)

  return normalizeJudgeJson({
    scenarios: {
      bullish: {
        probability: normalized.bullish,
        confidence: confidenceBase,
        reasoning: `多方依據：${firstSentence(bull.content)} 但必須服從 ${macro.Regime} 天候，RiskMultiplier ${macro.RiskMultiplier.toFixed(2)}。`,
      },
      neutral: {
        probability: normalized.neutral,
        confidence: clamp(confidenceBase + 0.05, 0, 0.92),
        reasoning: `中性情境代表高分標的可持續觀察，但需要等待突破、回測、財報或宏觀風險確認。`,
      },
      bearish: {
        probability: normalized.bearish,
        confidence: clamp(confidenceBase - 0.03 + (blocked ? 0.1 : 0), 0, 0.92),
        reasoning: `反方依據：${firstSentence(bear.content)} ${macro.MacroInsight}`,
      },
    },
    key_risks: keyRisks,
  })
}

function buildLocalMacroJson(evidencePack: MiroFishDebateEvidencePack): MiroFishMacroJson {
  if (isUniversalDebate(evidencePack)) {
    const riskCount = evidencePack.evidence.filter(isRiskEvidence).length
    const highCount = evidencePack.evidence.filter(item => item.importance === 'high').length
    const topic = evidencePack.topic || 'this decision'
    const uncertainty = riskCount >= 3 ? 'Risk-Off' : riskCount > highCount ? 'Chop' : 'Risk-On'
    const riskMultiplier = uncertainty === 'Risk-On' ? 0.78 : uncertainty === 'Risk-Off' ? 0.42 : 0.62
    return {
      Regime: uncertainty,
      RiskMultiplier: riskMultiplier,
      MacroInsight: `Contextual Analyst：${topic} 目前有 ${highCount} 個高重要性訊號與 ${riskCount} 個風險訊號。建議以 ${riskMultiplier.toFixed(2)} 的可執行信心推進，先試點、再擴張。`,
    }
  }

  const vix = finiteOr(evidencePack.macroData?.vix ?? undefined, extractFirstNumber(evidencePack.evidence.find(item => item.category === 'vix')?.summary))
  const tenYearYield = finiteOr(evidencePack.macroData?.tenYearYield ?? undefined, extractFirstNumber(evidencePack.evidence.find(item => item.category === 'bond')?.summary))
  const cpi = finiteOr(evidencePack.macroData?.cpi ?? undefined, Number.NaN)
  const marketRegime = String(evidencePack.marketRegime || '').toLowerCase()
  const blocked = String(evidencePack.riskGate?.status || '').toUpperCase().includes('BLOCK')
  const degraded = ['DEGRADED', 'FALLBACK', 'ERROR'].includes(String(evidencePack.dataHealth?.status || '').toUpperCase())
  const highInflation = Number.isFinite(cpi) && cpi >= 3.4

  let regime: MiroFishMacroJson['Regime'] = 'Chop'
  let riskMultiplier = 0.68
  if (blocked || degraded || vix >= 25 || tenYearYield >= 4.85 || highInflation) {
    regime = 'Risk-Off'
    riskMultiplier = 0.35
  } else if (vix < 18 && tenYearYield < 4.6 && marketRegime.includes('risk-on')) {
    regime = 'Risk-On'
    riskMultiplier = 0.92
  } else if (vix >= 20 || tenYearYield >= 4.6 || marketRegime.includes('mixed')) {
    regime = 'Chop'
    riskMultiplier = 0.62
  }

  const reasons = [
    `VIX ${Number.isFinite(vix) ? vix.toFixed(1) : 'n/a'}`,
    `10Y ${Number.isFinite(tenYearYield) ? `${tenYearYield.toFixed(2)}%` : 'n/a'}`,
    `CPI ${Number.isFinite(cpi) ? `${cpi.toFixed(1)}%` : 'n/a'}`,
    blocked ? '風控閘門已封鎖' : '',
    degraded ? `資料健康度 ${evidencePack.dataHealth?.status}` : '',
  ].filter(Boolean)

  return {
    Regime: regime,
    RiskMultiplier: riskMultiplier,
    MacroInsight: `${regime}：${reasons.join('，')}。總經守門員將本輪推演風險乘數設為 ${riskMultiplier.toFixed(2)}，後續 Bull/Bear 必須在此天候下辯論。`,
  }
}

function buildArgument(
  role: MiroFishAgentRole,
  title: string,
  content: string,
  evidencePack: MiroFishDebateEvidencePack,
  generatedAt: string,
): MiroFishAgentArgument {
  return {
    role,
    title,
    content: content.trim(),
    citations: deriveCitations(content, evidencePack),
    generatedAt,
  }
}

function deriveCitations(content: string, evidencePack: MiroFishDebateEvidencePack): string[] {
  const lower = content.toLowerCase()
  const citations = evidencePack.evidence
    .filter(item => lower.includes(item.title.toLowerCase().slice(0, 24)) || lower.includes(item.source.toLowerCase().slice(0, 24)))
    .map(item => `${item.source}: ${item.title}`)
  return Array.from(new Set(citations)).slice(0, 8)
}

function isRiskEvidence(item: MiroFishDebateEvidenceItem): boolean {
  const text = `${item.category} ${item.title} ${item.summary}`.toLowerCase()
  return ['risk', 'vix', 'bond', '10y', 'degraded', 'fallback', 'error', 'block', 'warn', 'drawdown', '風險', '风险', '成本', '治理', '安全', '依賴', '依赖', '不可逆'].some(keyword => text.includes(keyword))
}

function deriveKeyRisks(evidencePack: MiroFishDebateEvidencePack, bear: MiroFishAgentArgument): string[] {
  const risks: string[] = []
  if (evidencePack.dataHealth?.status && evidencePack.dataHealth.status !== 'OK') {
    risks.push(`資料健康度 ${evidencePack.dataHealth.status}: ${evidencePack.dataHealth.quoteSource || 'unknown source'}`)
  }
  if (evidencePack.riskGate?.status && evidencePack.riskGate.status !== 'OK') {
    risks.push(`風控閘門 ${evidencePack.riskGate.status}: ${evidencePack.riskGate.reason || 'no reason'}`)
  }
  for (const item of evidencePack.evidence.filter(isRiskEvidence)) {
    risks.push(`${item.title}: ${item.summary}`)
  }
  if (evidencePack.openClawMemoryContext) {
    risks.push(`OpenClaw 歷史記憶：${firstMemoryLesson(evidencePack.openClawMemoryContext)}`)
  }
  if (!risks.length) {
    risks.push(firstSentence(bear.content) || '需持續監控 VIX、10Y、QQQ 趨勢與資料來源品質')
  }
  return Array.from(new Set(risks.map(risk => risk.replace(/\s+/g, ' ').trim()).filter(Boolean))).slice(0, 6)
}

function firstMemoryLesson(memoryContext: string): string {
  const lesson = memoryContext
    .split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('- '))
  return (lesson || memoryContext.replace(/\s+/g, ' ').trim()).slice(0, 260)
}

function parseJudgeJson(raw: string): MiroFishJudgeJson {
  const cleaned = stripCodeFences(raw).trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('Judge output did not contain a JSON object')
  }
  return JSON.parse(cleaned.slice(start, end + 1)) as MiroFishJudgeJson
}

function parseMacroJson(raw: string): MiroFishMacroJson {
  const cleaned = stripCodeFences(raw).trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('Macro Agent output did not contain a JSON object')
  }
  return JSON.parse(cleaned.slice(start, end + 1)) as MiroFishMacroJson
}

function normalizeMacroJson(input: MiroFishMacroJson): MiroFishMacroJson {
  const regime = input?.Regime === 'Risk-On' || input?.Regime === 'Risk-Off' || input?.Regime === 'Chop'
    ? input.Regime
    : 'Chop'
  return {
    Regime: regime,
    RiskMultiplier: round2(clamp(finiteOr(input?.RiskMultiplier, regime === 'Risk-On' ? 0.9 : regime === 'Risk-Off' ? 0.35 : 0.65), 0, 1)),
    MacroInsight: String(input?.MacroInsight || '').trim() || `${regime} regime selected by Macro Agent.`,
  }
}

function normalizeJudgeJson(input: MiroFishJudgeJson): MiroFishJudgeJson {
  const scenarios = input?.scenarios
  if (!scenarios?.bullish || !scenarios?.neutral || !scenarios?.bearish) {
    throw new Error('Judge JSON missing scenarios')
  }
  const probabilities = normalizeProbabilities({
    bullish: Number(scenarios.bullish.probability),
    neutral: Number(scenarios.neutral.probability),
    bearish: Number(scenarios.bearish.probability),
  })
  return {
    scenarios: {
      bullish: normalizeScenario(scenarios.bullish, probabilities.bullish),
      neutral: normalizeScenario(scenarios.neutral, probabilities.neutral),
      bearish: normalizeScenario(scenarios.bearish, probabilities.bearish),
    },
    key_risks: Array.isArray(input.key_risks) ? input.key_risks.map(String).filter(Boolean).slice(0, 8) : [],
  }
}

function normalizeScenario(input: MiroFishScenarioJudgement, probability: number): MiroFishScenarioJudgement {
  return {
    probability,
    confidence: round2(clamp(Number(input.confidence), 0, 1)),
    reasoning: String(input.reasoning || '').trim() || 'No reasoning provided.',
  }
}

function normalizeProbabilities(values: { bullish: number; neutral: number; bearish: number }): { bullish: number; neutral: number; bearish: number } {
  const raw = {
    bullish: finiteOr(values.bullish, 0.34),
    neutral: finiteOr(values.neutral, 0.33),
    bearish: finiteOr(values.bearish, 0.33),
  }
  const total = raw.bullish + raw.neutral + raw.bearish
  if (total <= 0) return { bullish: 0.34, neutral: 0.33, bearish: 0.33 }
  const bullish = round2(raw.bullish / total)
  const neutral = round2(raw.neutral / total)
  const bearish = round2(clamp(1 - bullish - neutral, 0, 1))
  return { bullish, neutral, bearish }
}

function sanitizeJsonForPrompt(value: unknown): string {
  return JSON.stringify(redactSensitive(value), null, 2)
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (/(api|secret|token|password|credential|key)/i.test(key)) {
      output[key] = '[REDACTED]'
    } else {
      output[key] = redactSensitive(child)
    }
  }
  return output
}

function stripCodeFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
}

function firstSentence(content: string): string {
  return content.split(/[。.\n]/).map(part => part.trim()).find(Boolean) || ''
}

function extractFirstNumber(value: string | undefined): number {
  const match = String(value || '').match(/-?\d+(?:\.\d+)?/)
  if (!match) return Number.NaN
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
