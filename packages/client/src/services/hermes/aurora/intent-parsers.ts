import type { KanbanCreateRequest } from '@/api/hermes/kanban'
import type { QuantPaperJournalRequest } from './legacy-adapters'
import { normalizeGeneratedWidgetName } from './generated-widgets'
import {
  AURORA_APP_CAPABILITY_ORDER,
  getAuroraAppCapability,
  type AuroraAppKind,
} from './capability-manifest'

function normalizeInput(input: string): string {
  return input.trim().toLowerCase()
}

const AURORA_TOOL_PREFIX_RE = /^\s*[!！]\s*/

export function hasAuroraToolPrefix(input: string): boolean {
  return AURORA_TOOL_PREFIX_RE.test(input)
}

export function stripAuroraToolPrefix(input: string): string {
  return input.replace(AURORA_TOOL_PREFIX_RE, '').trim()
}

const EXPLICIT_AURORA_COMMAND_RE =
  /^\s*(?:(?:open|launch|run|show|view|check|inspect|execute)(?:\s|$|[:：])|(?:打開|開啟|打开|啟動|启动|執行|運行|运行|查看|顯示|显示|檢查|检查))/i

const EXPLICIT_VIDEO_COMMAND_RE =
  /^\s*(?:請|请)?\s*(?:幫我|帮我)?\s*(?:(?:create|make|generate|produce|render)\b|(?:製作|制作|生成|產生|產出|做|剪輯|規劃|撰寫|輸出))/i

const SHORT_TICKER_DEBATE_COMMAND_RE =
  /^\s*(?:run\s+mirofish\s+(?:on|for|about)\s+|mirofish\s+|推演\s+|風險推演\s+|风险推演\s+|辯論\s+|辩论\s+)\$?(?:[A-Z]{1,6}(?:[.-][A-Z]{1,3})?|[A-Z0-9_]+:[A-Z0-9._-]+)\s*$/i

export function getAuroraToolCommandInput(input: string): string | null {
  if (hasAuroraToolPrefix(input)) {
    const stripped = stripAuroraToolPrefix(input)
    return stripped || null
  }

  const trimmed = input.trim()
  if (!trimmed || trimmed.startsWith('/')) return null
  if (EXPLICIT_AURORA_COMMAND_RE.test(trimmed)) return trimmed
  if (EXPLICIT_VIDEO_COMMAND_RE.test(trimmed) && isVideoCreationIntent(trimmed)) return trimmed
  if (SHORT_TICKER_DEBATE_COMMAND_RE.test(trimmed)) return trimmed

  // Route high-confidence Aurora-native intents even when the user phrases them
  // as natural language. Keep broad debate/freeform prompts out of this list so
  // exploratory drafts still fall back to Hermes chat unless explicitly prefixed.
  if (
    isTaskQuery(trimmed) ||
    isMemoryQuery(trimmed) ||
    isProposeMemoryIntent(trimmed) ||
    isCreateTaskIntent(trimmed) ||
    isLifeOsBriefingIntent(trimmed) ||
    isLifeOsViewIntent(trimmed) ||
    isQuantPhaseCheckIntent(trimmed) ||
    isQuantPaperJournalIntent(trimmed) ||
    isQuantViewIntent(trimmed) ||
    /^\s*(?:simulate|simulation|debate)\s+mirofish\b/i.test(trimmed)
  ) {
    return trimmed
  }

  return null
}

export type MiroFishInitialView = 'graph' | 'pipeline' | 'workbench'

export interface TickerFocusIntent {
  rawSymbol: string
  symbol: string
}

const TICKER_RESERVED_WORDS = new Set([
  'AI',
  'APP',
  'ASK',
  'BUY',
  'BUILD',
  'CODE',
  'DEBATE',
  'FISH',
  'HOLD',
  'LIFE',
  'MIROFISH',
  'OPEN',
  'OS',
  'RISK',
  'RUN',
  'SELL',
  'THE',
  'THIS',
  'VIBE',
  'WATCH',
])

const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK', 'MATIC'])

export function isTaskQuery(input: string): boolean {
  const text = normalizeInput(input)
  return (
    /\b(tasks?|todo|to-do)\b/.test(text) &&
    /\b(today|now|current|my)\b/.test(text)
  ) || (
    /(今天|今日|目前|現在|我的)/.test(text) &&
    /(任務|待辦|工作)/.test(text)
  )
}

export function isMemoryQuery(input: string): boolean {
  const text = normalizeInput(input)
  return (
    /\b(search|find|lookup)\b/.test(text) &&
    /\b(memory|memories|profile|notes?)\b/.test(text)
  ) || (
    /(搜尋|查詢|找|看看)/.test(text) &&
    /(記憶|記錄|筆記|個人資料)/.test(text)
  )
}

export function isProposeMemoryIntent(input: string): boolean {
  const text = normalizeInput(input)
  return (
    /\b(remember|save|store|propose)\b/.test(text) &&
    /\b(memory|this|that|note|preference)\b/.test(text)
  ) || (
    /(記住|保存|儲存|提出|新增)/.test(text) &&
    /(記憶|這件事|偏好|筆記|知識)/.test(text)
  )
}

export function isCreateTaskIntent(input: string): boolean {
  const text = normalizeInput(input)
  return (
    /\b(create|add|new)\b/.test(text) &&
    /\b(tasks?|todo|to-do)\b/.test(text)
  ) || (
    /(新增|建立|創建|加入)/.test(text) &&
    /(任務|待辦|工作)/.test(text)
  )
}

export function isLifeOsBriefingIntent(input: string): boolean {
  const text = normalizeInput(input)
  return (
    (/\blife\s*os\b|lifeos|fire/.test(text) &&
      /\b(generate|create|brief|briefing|morning|daily|report)\b/.test(text))
  ) || (
    /(lifeos|life os|fire|財務|戰略)/i.test(input) &&
    /(生成|產生|建立|晨報|簡報|幕僚|戰略報告)/.test(input)
  )
}

export function isLifeOsViewIntent(input: string): boolean {
  const text = normalizeInput(input)
  if (isLifeOsBriefingIntent(input)) return false
  return (
    (/\blife\s*os\b|lifeos|fire/.test(text) &&
      /\b(status|state|summary|overview|check|health|dashboard|budget|finance|financial|net\s*worth|cashflow|view|open|show)\b/.test(text))
  ) || (
    /\b(net\s*worth|budget|finance|financial)\b/.test(text)
  ) || (
    /(lifeos|life os|fire|財務|淨資產|現金流|預算|資產|財務狀態|財務總覽)/i.test(input)
  )
}

export function isQuantPhaseCheckIntent(input: string): boolean {
  const text = normalizeInput(input)
  return (
    (/\b(quant|quant lab)\b/.test(text) && /\b(phase|validation|validate|check|health)\b/.test(text))
  ) || (
    /\bphase\b/.test(text) && /\b(check|validation|validate)\b/.test(text)
  ) || (
    /(量化|quant lab|quant|階段|phase)/i.test(input) &&
    /(檢查|驗證|phase|階段|健康|health)/i.test(input)
  )
}

export function isQuantPaperJournalIntent(input: string): boolean {
  const text = normalizeInput(input)
  return (
    (/\b(paper|journal|trade note|watch note)\b/.test(text) &&
      /\b(add|create|write|record|note|journal)\b/.test(text))
  ) || (
    /(紙上|paper|交易日記|觀察日記|journal|量化日記)/i.test(input) &&
    /(新增|建立|寫入|記錄|備註|觀察)/.test(input)
  )
}

export function isMiroFishRunIntent(input: string): boolean {
  if (isMiroFishGraphIntent(input)) return false
  const text = normalizeInput(input)
  return (
    /\b(mirofish|simulate|simulation|debate|sandbox)\b/.test(text) ||
    /(mirofish|風險推演|风险推演|情境推演|情景推演|辯論|辩论|多代理推演|多代理辯論|決策競技場|决策竞技场|推演)/i.test(input) ||
    /(分析|評估|评估).*(風險|风险|利弊|取捨|取舍|決策|决策)/i.test(input)
  )
}

export function extractMiroFishTargetTicker(input: string): string | null {
  if (isMiroFishGraphIntent(input)) return null
  const explicitPatterns = [
    /\b(?:on|for|about)\s+\$?([a-z]{1,6}(?:[.-][a-z]{1,3})?)\b/i,
    /(?:推演|辯論|辩论|風險推演|风险推演|決策競技場|决策竞技场)\s*\$?([A-Za-z]{1,6}(?:[.-][A-Za-z]{1,3})?)\b/i,
    /\$([A-Za-z]{1,6}(?:[.-][A-Za-z]{1,3})?)\b/i,
  ]
  for (const pattern of explicitPatterns) {
    const match = input.match(pattern)
    const ticker = match?.[1]?.toUpperCase()
    if (ticker && !TICKER_RESERVED_WORDS.has(ticker)) return ticker
  }

  const allCapsTicker = input.match(/\b([A-Z]{2,6}(?:[.-][A-Z]{1,3})?)\b/)
  const ticker = allCapsTicker?.[1]?.toUpperCase()
  return ticker && !TICKER_RESERVED_WORDS.has(ticker) ? ticker : null
}

export function normalizeTradingViewSymbol(value: string): string | null {
  const raw = String(value || '').trim().toUpperCase().replace(/^\$/, '')
  if (!raw || TICKER_RESERVED_WORDS.has(raw)) return null
  if (/^[A-Z0-9_]+:[A-Z0-9._-]+$/.test(raw)) return raw

  const cryptoPair = raw.match(/^([A-Z]{2,8})[-/]?USD[T]?$/)
  if (cryptoPair && CRYPTO_SYMBOLS.has(cryptoPair[1])) {
    return `COINBASE:${cryptoPair[1]}USD`
  }
  if (CRYPTO_SYMBOLS.has(raw)) return `COINBASE:${raw}USD`
  if (/^[A-Z]{1,6}(?:[.-][A-Z]{1,3})?$/.test(raw)) return `NASDAQ:${raw}`
  return null
}

export function parseTickerFocusIntent(input: string): TickerFocusIntent | null {
  const miroFishTicker = isMiroFishRunIntent(input) ? extractMiroFishTargetTicker(input) : null
  if (miroFishTicker) {
    const symbol = normalizeTradingViewSymbol(miroFishTicker)
    return symbol ? { rawSymbol: miroFishTicker, symbol } : null
  }

  const hasTickerVerb =
    /\b(analy[sz]e|chart|quote|price|stock|ticker|market|simulate|watch|trade)\b/i.test(input) ||
    /(分析|推演|評估|评估|看盤|看盘|走勢|走势|圖表|图表|報價|报价|股價|股价|交易)/.test(input)
  const explicitSymbol = input.match(/\b([A-Z0-9_]+:[A-Z0-9._-]+)\b/)?.[1] ||
    input.match(/\$([A-Za-z]{1,8}(?:[.-][A-Za-z]{1,3})?)\b/)?.[1]
  const verbAdjacentSymbol = hasTickerVerb
    ? input.match(/\b(?:analy[sz]e|chart|quote|price|simulate|watch|trade)\s+\$?([A-Za-z]{1,8}(?:[.-][A-Za-z]{1,3})?)\b/i)?.[1] ||
      input.match(/(?:分析|推演|評估|评估|看盤|看盘|走勢|走势|圖表|图表|報價|报价|股價|股价|交易)\s*\$?([A-Za-z]{1,8}(?:[.-][A-Za-z]{1,3})?)\b/i)?.[1]
    : null
  const capsSymbol = hasTickerVerb
    ? input.match(/\b([A-Z]{2,6}(?:[.-][A-Z]{1,3})?)\b/)?.[1]
    : null
  const rawSymbol = explicitSymbol || verbAdjacentSymbol || capsSymbol
  if (!rawSymbol) return null
  if (!explicitSymbol && rawSymbol !== rawSymbol.toUpperCase()) return null

  const normalizedRaw = rawSymbol.toUpperCase().replace(/^\$/, '')
  const symbol = normalizeTradingViewSymbol(normalizedRaw)
  return symbol ? { rawSymbol: normalizedRaw, symbol } : null
}

export function extractMiroFishTopic(input: string): string | null {
  if (isMiroFishGraphIntent(input)) return null
  const targetTicker = extractMiroFishTargetTicker(input)
  const stripped = input
    .replace(/\b(run|open|start|launch)\s+mirofish\s*(on|for|about)?\s*/i, ' ')
    .replace(/\b(mirofish|simulate|simulation|debate|sandbox)\b/gi, ' ')
    .replace(/(請|请|幫我|帮我|打開|打开|啟動|启动|決策競技場|决策竞技场|風險推演|风险推演|情境推演|情景推演|多代理推演|多代理辯論|推演|辯論|辩论|分析|評估|评估)\s*/gi, ' ')
    .replace(/^[：:\-\s]+/, '')
    .trim()

  if (!stripped) return null
  if (targetTicker && stripped.toUpperCase() === targetTicker) return null
  if (/^\$?[A-Za-z]{1,6}(?:[.-][A-Za-z]{1,3})?$/.test(stripped)) return null
  return stripped.slice(0, 220)
}

export function resolveMiroFishInitialView(input: string): MiroFishInitialView {
  if (isMiroFishGraphIntent(input)) return 'graph'
  const text = normalizeInput(input)
  if (
    /\b(graphrag|pipeline|preflight|build|construct|ontology)\b/.test(text) ||
    /(構建|建構|构建|本體|本体|預檢|预检|推演前|圖譜構建|图谱构建)/i.test(input)
  ) {
    return 'pipeline'
  }
  return 'workbench'
}

export function parseMiroFishDebateIntent(input: string): { targetTicker: string | null; topic: string | null } | null {
  if (!isMiroFishRunIntent(input)) return null
  return {
    targetTicker: extractMiroFishTargetTicker(input),
    topic: extractMiroFishTopic(input),
  }
}

export function isMiroFishGraphIntent(input: string): boolean {
  const text = normalizeInput(input)
  return (
    /\bmirofish\b.*\b(graph|knowledge|relationship|network)\b/.test(text) ||
    /\bgraph\s*relationship\b/.test(text) ||
    /\bknowledge\s*graph\b/.test(text) ||
    /(mirofish.*(圖譜|图谱)|知識圖譜|知识图谱|關係圖譜|关系图谱|關係圖|关系图|圖譜|图谱|關係網路|关系网络)/i.test(input)
  )
}

export function isQuantViewIntent(input: string): boolean {
  const text = normalizeInput(input)
  if (isMiroFishRunIntent(input)) return false
  if (isQuantPhaseCheckIntent(input)) return false
  if (isQuantPaperJournalIntent(input)) return false

  const hasQuantSurface = /\b(quant|quant lab|paper trading)\b/.test(text) ||
    /(量化|quant lab|quant|紙上交易|纸上交易)/i.test(input)
  const hasRankingRequest = /\b(top\s*10|top ten|top picks?|stock picks?|candidates?|ranking)\b/.test(text) ||
    /(前十|排行|候選|候选|推薦名單|推荐名单)/i.test(input)
  const hasViewCommand = /\b(open|show|view|check|inspect|snapshot|status|today|current|latest|list|what)\b/.test(text) ||
    /(打開|開啟|打开|啟動|启动|查看|顯示|显示|檢查|检查|看看|列出|給我|给我|幫我|帮我|請|请|今天|今日|目前|現在|现在|最新)/i.test(input)
  const isConceptualDraft = /(模組|模块|模型|理論|理论|學派|学派|架構|架构|framework|module|model|theory)/i.test(input) &&
    !/\b(quant lab|top\s*10|top ten)\b|量化今日|今日前十|今天前十/i.test(input)
  const hasStockSelectionRequest = /(選股|选股|推薦|推荐)/i.test(input) &&
    hasViewCommand &&
    !isConceptualDraft

  return (
    hasQuantSurface && (hasViewCommand || hasRankingRequest)
  ) || (
    hasStockSelectionRequest && (hasQuantSurface || /(股票|美股|stock|market|候選|候选)/i.test(input))
  )
}

export function extractRequestedGeneratedWidgetName(input: string): string | null {
  const hasLaunchVerb = /\b(open|load|launch|start)\b/i.test(input) || /(打開|開啟|啟動|載入|加载)/.test(input)
  if (!hasLaunchVerb) return null
  if (/(^|[\\/])\.\.([\\/]|$)|\.\.[\\/]/.test(input)) return null

  const pascalMatch = input.match(/\b([A-Z][A-Za-z0-9]{1,63})(?:\.vue)?\b/)
  if (pascalMatch) return normalizeGeneratedWidgetName(pascalMatch[1])

  const hasWidgetQualifier = /\b(widget|component|panel|card)\b/i.test(input) || /(小工具|元件|組件|卡片|面板)/.test(input)
  if (!hasWidgetQualifier) return null

  const cleaned = input
    .replace(/\b(open|load|launch|start)\b/gi, ' ')
    .replace(/(打開|開啟|啟動|載入|加载)/g, ' ')
    .replace(/\b(generated|aurora|widget|component|panel|card)\b/gi, ' ')
    .replace(/(小工具|元件|組件|卡片|面板)/g, ' ')
    .trim()

  if (!/[A-Za-z0-9]/.test(cleaned)) return null
  return normalizeGeneratedWidgetName(cleaned)
}

export function isGeneratedWidgetListIntent(input: string): boolean {
  const text = normalizeInput(input)
  return (
    /\b(list|show|browse|view|what|available)\b/.test(text) &&
    /\b(generated\s*)?(widgets?|components?)\b/.test(text)
  ) || (
    /(列出|顯示|看看|有哪些|瀏覽|查看)/.test(input) &&
    /(generated|生成|產生|小工具|元件|組件|widgets?)/i.test(input)
  )
}

export function parseLegacyAppOpenIntent(input: string): AuroraAppKind | null {
  const text = normalizeInput(input)
  const hasOpenVerb = /\b(open|show|view|launch|go to)\b/.test(text) || /(打開|開啟|啟動|查看|顯示|進入|打开|显示|进入)/.test(input)
  if (!hasOpenVerb) return null
  if (/(中轉站|中转站|\bhub\b|\bproxy\b)/i.test(input)) return null

  return AURORA_APP_CAPABILITY_ORDER
    .find(kind => getAuroraAppCapability(kind).intentPattern.test(input)) || null
}

export function parseBrowserOpenIntent(input: string): string | null {
  const match = input.trim().match(/^(?:open|launch|browse|visit|go\s+to|打開|開啟|打开|啟動|启动|前往|瀏覽|浏览)\s+(.+?)\s*$/i)
  if (!match) return null

  const rawTarget = match[1]?.trim()
  if (!rawTarget || /(中轉站|中转站|\bhub\b|\bproxy\b)/i.test(rawTarget)) return null

  const appKind = AURORA_APP_CAPABILITY_ORDER
    .find(kind => getAuroraAppCapability(kind).intentPattern.test(rawTarget))
  if (appKind && appKind !== 'browser') return null

  let target = rawTarget.replace(/^<(.+)>$/, '$1').trim()
  const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
  const isLocalHost = /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(target)
    || /^127(?:\.\d+){3}(?::\d+)?(?:[/?#].*)?$/.test(target)
  const looksLikeDomain = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#].*)?$/i.test(target)

  if (!hasProtocol) {
    if (isLocalHost) {
      target = `http://${target}`
    } else if (looksLikeDomain) {
      target = `https://${target}`
    } else {
      return null
    }
  }

  try {
    const parsed = new URL(target)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

export function isVideoCreationIntent(input: string): boolean {
  const text = normalizeInput(input)
  return (
    (
      /\b(create|make|generate|produce|render|draft|write)\b/.test(text) &&
      /\b(video|shorts?|reels?|tiktok|storyboard|vertical)\b/.test(text)
    ) || (
      /(製作|制作|生成|產生|產出|做|剪輯|規劃|撰寫|輸出)/.test(input) &&
      /(影片|短影片|直式影片|社群短視頻|社群短影片|分鏡|字幕|腳本|剧本|劇本)/.test(input)
    )
  )
}

export function extractVideoCreationBrief(input: string): string {
  return input
    .replace(/^\s*(請|请)?(幫我|帮我)?\s*/i, '')
    .trim()
    .slice(0, 6000)
}

function stripMemoryPrefix(input: string): string {
  return input
    .replace(/^\s*(please\s+)?(remember|save|store|propose)\s+(this|that|a\s+memory|memory|note|preference)?\s*(for|that|:|-)?\s*/i, '')
    .replace(/^\s*(請)?(幫我)?(記住|保存|儲存|提出|新增)\s*(這件事|一段)?(記憶|筆記|偏好|知識)?\s*[:：-]?\s*/i, '')
    .trim()
}

export function parseMemoryProposal(input: string): { content: string; source: string; confidenceScore: number } | null {
  const content = stripMemoryPrefix(input)
  if (!content || content.length < 2) return null
  const explicitUncertainty = /\b(maybe|possibly|not sure|uncertain)\b|可能|不確定|大概/i.test(input)
  const explicitHigh = /\b(definitely|always|important)\b|一定|永遠|重要/i.test(input)
  return {
    content: content.slice(0, 1200),
    source: 'Chat Interaction',
    confidenceScore: explicitUncertainty ? 62 : explicitHigh ? 95 : 85,
  }
}

function stripCreateTaskPrefix(input: string): string {
  return input
    .replace(/^\s*(please\s+)?(create|add|new)\s+(a\s+)?(task|todo|to-do)\s*(for|to|:|-)?\s*/i, '')
    .replace(/^\s*(請)?(幫我)?(新增|建立|創建|加入)\s*(一個)?(任務|待辦|工作)?\s*[:：-]?\s*/i, '')
    .trim()
}

export function parseCreateTask(input: string): KanbanCreateRequest | null {
  const title = stripCreateTaskPrefix(input)
  if (!title || title.length < 2) return null
  return {
    title: title.slice(0, 120),
    body: `Created from Aurora OmniBar: ${input.trim()}`,
    priority: /urgent|high|緊急|重要/i.test(input) ? 2 : 0,
  }
}

export function parseQuantPaperJournal(input: string): QuantPaperJournalRequest | null {
  const candidates = Array.from(input.matchAll(/\b[A-Z][A-Z0-9.\-]{1,9}\b/g))
    .map(match => match[0].toUpperCase())
    .filter(symbol => ![
      'ADD',
      'AI',
      'BUY',
      'FIRE',
      'HOLD',
      'JOURNAL',
      'LIFEOS',
      'MARK',
      'PAPER',
      'QUANT',
      'SELL',
      'TOP',
      'WATCH',
    ].includes(symbol))
  const ticker = candidates[0]
  const note = input
    .replace(/^\s*(please\s+)?(add|create|write|record)\s+(a\s+)?(paper\s+)?(journal|trade\s+note|watch\s+note)\s*(for|to|:|-)?\s*/i, '')
    .replace(/^\s*(請)?(幫我)?(新增|建立|寫入|記錄)\s*(一則|一個)?(紙上)?(交易日記|觀察日記|量化日記|備註)?\s*[:：-]?\s*/i, '')
    .replace(/\b(ticker|symbol)\s+[A-Z][A-Z0-9.\-]{1,9}\b/i, '')
    .trim()
  const cleanedNote = note || input.trim()
  if (cleanedNote.length < 2) return null
  return {
    ticker,
    note: cleanedNote.slice(0, 800),
    journalAction: /buy|買/i.test(input) ? 'BUY' : /sell|賣/i.test(input) ? 'SELL' : 'WATCH',
  }
}
