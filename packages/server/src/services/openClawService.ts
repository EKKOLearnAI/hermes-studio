type TavilySearchDepth = 'basic' | 'advanced'
type OpenClawTriggerType = 'stock' | 'macro'

interface TavilyResult {
  title?: string
  content?: string
  url?: string
  score?: number
}

interface TavilyResponse {
  results?: TavilyResult[]
}

interface YahooQuote {
  symbol?: string
  shortName?: string
  longName?: string
  regularMarketPrice?: number
  regularMarketPreviousClose?: number
  fiftyTwoWeekHigh?: number
  fiftyTwoWeekLow?: number
}

const OPENCLAW_TIMEOUT_MS = 5_000
const OPENCLAW_MAX_TEXT = 1_000

function truncateText(text: string, maxChars = OPENCLAW_MAX_TEXT): string {
  const normalized = text
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 1)}…`
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}

function getTavilyApiKey(): string {
  return (process.env.TAVILY_API_KEY || '').trim()
}

function yahooQuoteUrl(symbol: string): string {
  return `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`
}

function yahooRssUrl(symbol: string): string {
  return `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim()
}

function formatNumber(value: unknown, digits = 2): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return 'N/A'
  return number.toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })
}

function formatDistanceFromHigh(price: number | undefined, high: number | undefined): string {
  if (!Number.isFinite(price) || !Number.isFinite(high) || !high) return 'N/A'
  const pct = ((Number(price) - Number(high)) / Number(high)) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

function extractRssTitles(xml: string, maxItems = 3): string[] {
  const titles: string[] = []
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi
  let match: RegExpExecArray | null

  while ((match = itemRegex.exec(xml)) !== null && titles.length < maxItems) {
    const title = match[0].match(/<title>([\s\S]*?)<\/title>/i)?.[1]
    if (title) titles.push(decodeXmlText(title))
  }

  return titles
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(OPENCLAW_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as T
}

async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(OPENCLAW_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}

export async function searchMarketIntel(
  query: string,
  searchDepth: TavilySearchDepth = 'basic',
): Promise<string> {
  const trimmedQuery = query.trim()
  const apiKey = getTavilyApiKey()
  if (!trimmedQuery || !apiKey) return ''

  try {
    const response = await fetchJson<TavilyResponse>('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: trimmedQuery,
        search_depth: searchDepth,
        include_answer: false,
        include_raw_content: false,
        max_results: 3,
      }),
      signal: AbortSignal.timeout(OPENCLAW_TIMEOUT_MS),
    })

    const results = (response.results || [])
      .slice(0, 3)
      .map((result, index) => {
        const title = result.title?.trim() || `Result ${index + 1}`
        const content = result.content?.trim() || ''
        return `- ${title}${content ? `: ${content}` : ''}`
      })
      .filter(Boolean)
      .join('\n')

    return results ? truncateText(`[OpenClaw Tavily:${searchDepth}]\n${results}`) : ''
  } catch (error) {
    console.warn('[OpenClaw] Tavily search skipped:', error instanceof Error ? error.message : error)
    return ''
  }
}

async function fetchYahooQuote(symbol: string): Promise<YahooQuote | null> {
  const json = await fetchJson<{ quoteResponse?: { result?: YahooQuote[] } }>(yahooQuoteUrl(symbol), {
    headers: {
      accept: 'application/json',
      'user-agent': 'Hermes OpenClaw/0.1',
    },
    signal: AbortSignal.timeout(OPENCLAW_TIMEOUT_MS),
  })

  return json.quoteResponse?.result?.[0] || null
}

async function fetchYahooNewsTitles(symbol: string): Promise<string[]> {
  const xml = await fetchText(yahooRssUrl(symbol), {
    headers: {
      accept: 'application/rss+xml,text/xml,*/*',
      'user-agent': 'Hermes OpenClaw/0.1',
    },
    signal: AbortSignal.timeout(OPENCLAW_TIMEOUT_MS),
  })
  return extractRssTitles(xml, 3)
}

export async function fetchStockIntel(symbol: string): Promise<string> {
  const normalized = normalizeSymbol(symbol)
  if (!normalized) return ''

  const [quoteSettled, newsSettled] = await Promise.allSettled([
    fetchYahooQuote(normalized),
    fetchYahooNewsTitles(normalized),
  ])

  const quote = quoteSettled.status === 'fulfilled' ? quoteSettled.value : null
  const newsTitles = newsSettled.status === 'fulfilled' ? newsSettled.value : []

  if (!quote && newsTitles.length === 0) {
    if (quoteSettled.status === 'rejected') {
      console.warn('[OpenClaw] Yahoo quote skipped:', normalized, quoteSettled.reason instanceof Error ? quoteSettled.reason.message : quoteSettled.reason)
    }
    if (newsSettled.status === 'rejected') {
      console.warn('[OpenClaw] Yahoo news skipped:', normalized, newsSettled.reason instanceof Error ? newsSettled.reason.message : newsSettled.reason)
    }

    return searchMarketIntel(`${normalized} stock price 52 week high recent news market sentiment`, 'basic')
  }

  if (!quote) {
    return truncateText([
      `[OpenClaw Yahoo:${normalized}]`,
      `[Ticker: ${normalized}] quote unavailable`,
      `近期市場情緒: ${newsTitles.map((title, index) => `${index + 1}. ${title}`).join(' / ')}`,
    ].join('\n'))
  }

  try {
    const price = quote.regularMarketPrice
    const high = quote.fiftyTwoWeekHigh
    const low = quote.fiftyTwoWeekLow
    const name = quote.shortName || quote.longName || normalized
    const distanceFromHigh = formatDistanceFromHigh(price, high)
    const news = newsTitles.length
      ? newsTitles.map((title, index) => `${index + 1}. ${title}`).join(' / ')
      : 'Yahoo RSS returned no recent headlines.'

    return truncateText([
      `[OpenClaw Yahoo:${normalized}]`,
      `[Ticker: ${normalized}] ${name}`,
      `現價: $${formatNumber(price)} | 52週高點: $${formatNumber(high)} | 52週低點: $${formatNumber(low)} | 距52週高點: ${distanceFromHigh}`,
      `近期市場情緒: ${news}`,
    ].join('\n'))
  } catch (error) {
    console.warn('[OpenClaw] Yahoo stock intel formatting skipped:', normalized, error instanceof Error ? error.message : error)
    return searchMarketIntel(`${normalized} stock price 52 week high recent news market sentiment`, 'basic')
  }
}

export async function gatherExternalIntelligence(
  triggerType: OpenClawTriggerType,
  target: string,
): Promise<string> {
  try {
    if (triggerType === 'stock') return await fetchStockIntel(target)
    if (triggerType === 'macro') return await searchMarketIntel(target, 'basic')
    return ''
  } catch (error) {
    console.warn('[OpenClaw] external intelligence skipped:', error instanceof Error ? error.message : error)
    return ''
  }
}

export async function fetchMarketTrend(symbol: string): Promise<string> {
  return gatherExternalIntelligence('stock', symbol)
}
