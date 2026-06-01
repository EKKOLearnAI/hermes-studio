import Router from '@koa/router'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { extractActionableIntel } from '../../services/miroFishService'
import { getObsidianVaultPath, searchWIKI } from '../../services/obsidianService'
import { fetchMarketTrend } from '../../services/openClawService'
import { generateHermesText } from '../../services/hermes/dynamic-llm'

export const nexusRoutes = new Router()

interface NexusEvaluateRequest {
  currentFinancialState?: unknown
}

type NexusAdviceMode = 'hermes-gateway' | 'custom-provider' | 'local-fallback'

const NEXUS_SYSTEM_PROMPT = `
你是 NEXUS，一個運行在 Cyberpunk 終端機內的極端務實、冷酷且精準的「戰略與財富幕僚」。
你的唯一目標是協助使用者以最快速度達成 FIRE (財務獨立、提早退休)。

【使用者檔案 (User Context)】
- 職業：資深軟體系統架構師。
- 核心技能：精通 TypeScript, Node.js, Vue 3, Vite，以及 AI Agent 整合 (GitHub Copilot, Grok, Tavily 等工具閘道)。
- 核心戰略：不追求緩慢的存錢，而是透過「技術高槓桿變現」與「精準量化投資」來縮短 FIRE 倒數。

【輸入資料分析規則 (Input Data)】
每次對話，系統會傳入使用者目前的 LifeOS 財務狀態 JSON (包含淨資產、儲蓄率、各帳戶餘額、投資持倉與未實現損益、近期交易)。

【輸出格式與語氣約束 (Output Format & Tone)】
1. 語氣：冷靜、極度理性、一針見血。像是一個軍事參謀或高階 CTO。不要給空泛的安慰。
2. 格式約束：必須使用短句、條列式輸出。字數控制在 150 字以內，適合在小型終端機螢幕上快速閱讀。
3. 標籤系統：開頭必須使用 [戰略評估] 或 [系統警告]，針對具體行動使用 [戰術指令]。

【戰術決策邏輯 (Decision Logic)】
- 當「現金防禦水位」低於安全線時：不要只是叫使用者省錢！請結合使用者的『系統架構師技能』，具體建議如何利用 AI 輔助開發、接案或快速建立 SaaS MVP 來製造額外現金流。
- 當「特定投資標的 (如 NVDA)」獲利極高且佔比過大時：提醒資產配置風險，建議動態平衡。
- 當「彈性開銷」出現無意義消耗時：直接換算該筆開銷會「延後 FIRE 多久」，給予殘酷的現實打擊。
- 當 currentFinancialState.computedMetrics.budgetMetrics.categories 中任何非投資分類 remaining < 0 時：視為預算防線突破。若分類為「彈性生活支出」，必須明確輸出「彈性生活防線崩潰」與「推進 HERMES 閘道器專案以彌補虧空」。
- 不可輸出真實交易指令，不可要求使用者立即買賣金融商品；只能提供研究、風控與紙上策略建議。
`.trim()

function userMatrixPath(): string {
  return resolve(process.cwd(), 'data', 'user-matrix.json')
}

function readUserMatrix(): Record<string, unknown> {
  const filePath = userMatrixPath()
  if (!existsSync(filePath)) {
    return {
      identity: {
        astrology: '水瓶座',
        chineseZodiac: '龍',
        occupation: '高階系統架構師',
      },
      personality: {
        decisionStyle: '系統化、偏好可驗證的工程化決策',
        riskStyle: '願意承擔非對稱上行，但需要清楚的降載與止損規則',
      },
    }
  }

  return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
}

function compactJson(value: unknown, maxChars = 4200): string {
  const seen = new WeakSet<object>()
  const compacted = JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'string') return entry.length > 240 ? `${entry.slice(0, 240)}...` : entry
    if (Array.isArray(entry)) return entry.slice(0, 12)
    if (entry && typeof entry === 'object') {
      if (seen.has(entry)) return '[Circular]'
      seen.add(entry)
    }
    return entry
  })

  if (!compacted) return '{}'
  return compacted.length > maxChars ? `${compacted.slice(0, maxChars)}...` : compacted
}

function buildNexusSystemPrompt(
  currentFinancialState: unknown,
  userMatrix: Record<string, unknown>,
  obsidianContext = '',
  knowledgeKeywords: string[] = [],
  openClawContext = '',
  marketIntelSymbols: string[] = [],
): string {
  const compressedPayload = {
    userMatrix,
    currentFinancialState,
  }

  return `${NEXUS_SYSTEM_PROMPT}

【目前 LifeOS 狀態快照】
${compactJson(compressedPayload)}
${obsidianContext ? `

【本地知識庫參考 (Obsidian WIKI)】
觸發關鍵字：${knowledgeKeywords.join(' / ')}
${obsidianContext}
請務必優先利用上述本地知識，給予具體的開源、變現、風控或資產配置建議。
` : ''}
${openClawContext ? `

【OpenClaw 宏觀情報】
觸發標的：${marketIntelSymbols.join(' / ')}
${openClawContext}
請把此情報視為外部弱信號，只能用於風險辨識與研究提示，不可輸出真實交易指令。
` : ''}

請根據上述 JSON 分析現金流健康度、負債壓力、投資曝險、近期交易與 FIRE 倒數。
若有 Obsidian WIKI 或 OpenClaw 情報，請優先使用其中可執行、可驗證的重點，但不要逐字複製長段資料。
輸出 2 到 4 行；每行必須以 [戰略評估]、[系統警告] 或 [戰術指令] 開頭。
不要使用 Markdown 表格。不要輸出 JSON。`
}

function truncateAdvice(text: string, maxChars = 420): string {
  const normalized = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 1)}…`
}

const UNSAFE_GATEWAY_TEXT_PATTERNS = [
  /NoneType/i,
  /object is not iterable/i,
  /Traceback/i,
  /TypeError/i,
  /ValueError/i,
  /Internal Server Error/i,
  /HTTP 500/i,
]

function isUnsafeGatewayText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  return UNSAFE_GATEWAY_TEXT_PATTERNS.some((pattern) => pattern.test(trimmed))
}

async function callHermesDynamicAdvice(systemPrompt: string): Promise<{ advice: string; mode: NexusAdviceMode }> {
  const result = await generateHermesText({
    instructions: systemPrompt,
    input: '請依照 system 指令輸出 NEXUS 終端機戰略建議。',
    temperature: 0.2,
    maxTokens: 220,
  })
  const advice = truncateAdvice(result.text)

  if (isUnsafeGatewayText(advice)) {
    throw new Error(`Unsafe Hermes gateway advice: ${advice.slice(0, 120)}`)
  }

  return {
    advice,
    mode: result.runtime.mode,
  }
}

function readNumberAtPath(source: any, path: string[]): number | null {
  let cursor = source
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return null
    cursor = cursor[key]
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : null
}

function getFinancialMetrics(currentFinancialState: unknown): any {
  const state = currentFinancialState as any
  return state?.computedMetrics || state?.metrics || {}
}

function getStockItemsWithMetrics(metrics: any): any[] {
  const domesticItems = metrics?.domesticStockMetrics?.items
  const usItems = metrics?.usStockMetrics?.items
  return [
    ...(Array.isArray(domesticItems) ? domesticItems : []),
    ...(Array.isArray(usItems) ? usItems : []),
  ]
}

function getRawStockItems(currentFinancialState: unknown): any[] {
  const state = currentFinancialState as any
  const financialState = state?.financialState || state || {}
  const directStocks = financialState?.stocks
  const investmentEquity = financialState?.investmentEquity || {}
  return [
    ...(Array.isArray(directStocks) ? directStocks : []),
    ...(Array.isArray(investmentEquity.domesticStocks) ? investmentEquity.domesticStocks : []),
    ...(Array.isArray(investmentEquity.usStocks) ? investmentEquity.usStocks : []),
  ]
}

function getLargestStockConcentration(metrics: any): number {
  const totalStocks = readNumberAtPath(metrics, ['totalStocks']) || 0
  if (totalStocks <= 0) return 0

  return getStockItemsWithMetrics(metrics).reduce((largest, stock) => {
    const marketValueTwd = typeof stock.marketValueTwd === 'number'
      ? stock.marketValueTwd
      : typeof stock.marketValue === 'number'
        ? stock.marketValue
        : 0
    return Math.max(largest, (marketValueTwd / totalStocks) * 100)
  }, 0)
}

function getVolatileStocks(currentFinancialState: unknown): any[] {
  const metrics = getFinancialMetrics(currentFinancialState)
  const metricItems = getStockItemsWithMetrics(metrics)
  const rawItems = getRawStockItems(currentFinancialState)

  const combined = metricItems.length > 0 ? metricItems : rawItems.map((stock) => {
    const cost = typeof stock.costBasis === 'number' ? stock.costBasis : 0
    const price = typeof stock.currentPrice === 'number' ? stock.currentPrice : 0
    const gainLossPct = cost > 0 ? ((price - cost) / cost) * 100 : 0
    return { ...stock, gainLossPct }
  })

  return combined.filter((stock) => {
    const gainLossPct = typeof stock.gainLossPct === 'number' ? stock.gainLossPct : 0
    return gainLossPct > 50 || gainLossPct < -20
  })
}

function getBreachedBudgetCategories(currentFinancialState: unknown): any[] {
  const metrics = getFinancialMetrics(currentFinancialState)
  const categories = metrics?.budgetMetrics?.categories
  if (!Array.isArray(categories)) return []

  return categories.filter((category) => (
    category
    && category.id !== 'investing'
    && typeof category.remaining === 'number'
    && category.remaining < 0
  ))
}

function deriveObsidianKeywords(currentFinancialState: unknown): string[] {
  const metrics = getFinancialMetrics(currentFinancialState)
  const keywords: string[] = []

  const cashReserveMonths = readNumberAtPath(metrics, ['cashReserveMonths'])
  const investmentRatio = readNumberAtPath(metrics, ['investmentRatio'])
  const largestStockConcentration = getLargestStockConcentration(metrics)
  const volatileStocks = getVolatileStocks(currentFinancialState)
  const breachedBudgets = getBreachedBudgetCategories(currentFinancialState)

  if ((cashReserveMonths ?? 99) < 6) {
    keywords.push('副業', '變現', 'SaaS', '接案')
  }

  if (breachedBudgets.length > 0) {
    keywords.push('消費紀律', '預算', '副業', '變現', 'HERMES')
  }

  if (volatileStocks.length > 0 || (investmentRatio ?? 0) > 70 || largestStockConcentration > 35) {
    keywords.push('資產配置', '風控', '停利', '停損')
  }

  return Array.from(new Set(keywords))
}

function extractSymbolFromPayee(payee: string): string {
  const match = payee.match(/(?:買入|BUY)\s+([A-Za-z0-9.\-]+)/i)
  return match?.[1]?.toUpperCase() || ''
}

function normalizeStockSymbol(symbol: unknown): string {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '')
}

function getInvestmentWatchSymbols(currentFinancialState: unknown): string[] {
  const metrics = getFinancialMetrics(currentFinancialState)
  const metricItems = getStockItemsWithMetrics(metrics)
  const rawItems = getRawStockItems(currentFinancialState)

  const combined = (metricItems.length > 0 ? metricItems : rawItems.map((stock) => {
    const shares = typeof stock.shares === 'number' ? stock.shares : 0
    const cost = typeof stock.costBasis === 'number' ? stock.costBasis : 0
    const price = typeof stock.currentPrice === 'number' ? stock.currentPrice : 0
    const gainLossPct = cost > 0 ? ((price - cost) / cost) * 100 : 0
    const marketValue = shares * price
    return { ...stock, gainLossPct, marketValue }
  })).filter((stock) => normalizeStockSymbol(stock?.symbol))

  const scored = combined.map((stock) => {
    const gainLossPct = typeof stock.gainLossPct === 'number' ? stock.gainLossPct : 0
    const marketValue = typeof stock.marketValueTwd === 'number'
      ? stock.marketValueTwd
      : typeof stock.marketValue === 'number'
        ? stock.marketValue
        : 0
    return {
      symbol: normalizeStockSymbol(stock.symbol),
      score: Math.abs(gainLossPct) * 10 + Math.log10(Math.max(1, marketValue)),
    }
  })

  return scored
    .sort((a, b) => b.score - a.score)
    .map((stock) => stock.symbol)
    .filter((symbol, index, all) => symbol && all.indexOf(symbol) === index)
    .slice(0, 3)
}

function findLargeInvestmentSymbols(currentFinancialState: unknown): string[] {
  const state = currentFinancialState as any
  const transactions = state?.budgeting?.transactions
  const transactionSymbols = Array.isArray(transactions)
    ? [...transactions]
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .filter((transaction) => (
        transaction
        && transaction.categoryId === 'investing'
        && typeof transaction.amount === 'number'
        && transaction.amount < -10_000
      ))
      .map((transaction) => extractSymbolFromPayee(String(transaction.payee || '')))
      .filter(Boolean)
    : []

  return Array.from(new Set([
    ...transactionSymbols,
    ...getInvestmentWatchSymbols(currentFinancialState),
  ])).slice(0, 3)
}

async function buildOpenClawContext(symbols: string[]): Promise<string> {
  if (symbols.length === 0) return ''

  const chunks: string[] = []
  for (const symbol of symbols) {
    try {
      const rawIntel = await fetchMarketTrend(symbol)
      const cleanIntel = await extractActionableIntel(rawIntel)
      if (cleanIntel) chunks.push(`- ${symbol}\n${cleanIntel}`)
    } catch (error) {
      console.warn('[nexus] OpenClaw/MiroFish context skipped:', symbol, error instanceof Error ? error.message : error)
    }
  }

  return chunks.join('\n')
}

function localFallbackAdvice(currentFinancialState: unknown): string {
  const state = currentFinancialState as any
  const metrics = getFinancialMetrics(currentFinancialState)
  const financialState = state?.financialState || state || {}
  const totalAssets = readNumberAtPath(metrics, ['totalAssets'])
  const netWorth = readNumberAtPath(metrics, ['netWorth'])
  const cashReserveMonths = readNumberAtPath(metrics, ['cashReserveMonths'])
  const loanTotal = readNumberAtPath(financialState, ['liabilities', 'loanTotal']) || readNumberAtPath(metrics, ['loanTotal'])
  const debtRatio = totalAssets && loanTotal ? loanTotal / totalAssets : null
  const breachedBudgets = getBreachedBudgetCategories(currentFinancialState)

  if (breachedBudgets.length > 0) {
    const livingBreach = breachedBudgets.find((category) => category.id === 'living')
    const target = livingBreach || breachedBudgets[0]
    const name = String(target?.name || '預算')
    const overrun = Math.abs(Number(target?.remaining || 0))
    if (livingBreach) {
      return [
        `[系統警告] 彈性生活防線崩潰，超支 ${Math.round(overrun).toLocaleString('en-US')} 元。`,
        '[戰術指令] 你為了短暫的口腹之慾破壞了本月的儲蓄紀律。立刻停止消費，本週末的聚餐全部取消，在家推進你的 HERMES 閘道器專案以彌補虧空。',
      ].join('\n')
    }
    return [
      `[系統警告] ${name} 預算防線被突破，超支 ${Math.round(overrun).toLocaleString('en-US')} 元。`,
      '[戰術指令] 暫停同類支出，優先用低成本技術槓桿補回現金流缺口。',
    ].join('\n')
  }

  if ((cashReserveMonths ?? 0) < 6) {
    return [
      '[系統警告] 現金防禦水位低於 6 個月，FIRE 倒數失真。',
      '[戰術指令] 暫停新增高波動曝險；用 AI 輔助接案或 SaaS MVP 製造額外現金流。',
      '[戰略評估] 技術槓桿比單純節流更有效，但固定成本不得上升。',
    ].join('\n')
  }
  if ((debtRatio ?? 0) > 0.8 || (netWorth ?? 1) < 0) {
    return [
      '[系統警告] 負債壓力偏高，資產負債表仍在高負載區。',
      '[戰術指令] 優先降載利息成本與固定支出；副業只允許低成本原型。',
      '[戰略評估] 任何投資加碼都必須先通過現金流壓力測試。',
    ].join('\n')
  }
  return [
    '[戰略評估] 現金流可支撐進攻，但資產配置不可單點失衡。',
    '[戰術指令] 保留 6 個月防禦水位；把 TypeScript/AI Agent 能力轉成可收費 MVP。',
    '[系統警告] 若彈性開銷擴張，FIRE 倒數會被無聲拉長。',
  ].join('\n')
}

nexusRoutes.post('/api/nexus/evaluate', async (ctx) => {
  try {
    const body = ctx.request.body as NexusEvaluateRequest | undefined
    if (!body || !body.currentFinancialState || typeof body.currentFinancialState !== 'object') {
      ctx.status = 400
      ctx.body = {
        error: 'currentFinancialState must be an object',
        code: 'nexus_current_financial_state_required',
      }
      return
    }

    const userMatrix = readUserMatrix()
    const knowledgeKeywords = deriveObsidianKeywords(body.currentFinancialState)
    let obsidianContext = ''
    if (knowledgeKeywords.length > 0) {
      try {
        obsidianContext = await searchWIKI(knowledgeKeywords)
        console.log('====== [DEBUG: Obsidian RAG Context] ======')
        console.log('Vault path:', getObsidianVaultPath())
        console.log('觸發關鍵字:', knowledgeKeywords)
        console.log('擷取到的 WIKI 內容長度:', obsidianContext.length)
        console.log('擷取內容預覽:', obsidianContext.substring(0, 200))
        console.log('===========================================')
      } catch (error) {
        console.warn('[nexus] Obsidian context skipped:', error instanceof Error ? error.message : error)
      }
    }
    const marketIntelSymbols = findLargeInvestmentSymbols(body.currentFinancialState)
    const openClawContext = await buildOpenClawContext(marketIntelSymbols)
    const breachedBudgets = getBreachedBudgetCategories(body.currentFinancialState)

    const systemPrompt = buildNexusSystemPrompt(
      body.currentFinancialState,
      userMatrix,
      obsidianContext,
      knowledgeKeywords,
      openClawContext,
      marketIntelSymbols,
    )
    let mode: NexusAdviceMode = 'hermes-gateway'
    let advice: string

    try {
      const result = await callHermesDynamicAdvice(systemPrompt)
      advice = result.advice
      mode = result.mode
    } catch (error) {
      mode = 'local-fallback'
      advice = localFallbackAdvice(body.currentFinancialState)
      console.warn('[nexus] Dynamic Hermes LLM fallback:', error instanceof Error ? error.message : error)
    }

    ctx.body = {
      advice,
      mode,
      knowledgeKeywords,
      knowledgeContextFound: Boolean(obsidianContext),
      marketIntelSymbols,
      openClawContextFound: Boolean(openClawContext),
      breachedBudgets: breachedBudgets.map((category) => category.name || category.id).filter(Boolean),
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      error: err?.message || 'Failed to evaluate Nexus advice',
      code: err?.code || 'nexus_evaluate_failed',
    }
  }
})
