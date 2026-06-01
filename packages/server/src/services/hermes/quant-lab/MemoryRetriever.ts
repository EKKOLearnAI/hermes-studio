import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

export interface PastLesson {
  ticker: string
  fileName: string
  date: string
  result: 'Win' | 'Loss' | 'Flat' | 'Unknown'
  pnlPct?: number
  vix?: number
  actionableInsight: string
}

export interface PostMortemReport extends PastLesson {
  id: string
  path: string
  relativePath: string | undefined
  markdown: string
  agentScores: {
    quant: number | null
    bull: number | null
    bear: number | null
  }
  updatedAt: string
}

export interface RetrievePastLessonsOptions {
  knowledgeRoot?: string
  postMortemDir?: string
  maxLessons?: number
}

const DEFAULT_MAX_LESSONS = 5

export async function retrievePastLessons(
  ticker: string,
  currentVix: number,
  options: RetrievePastLessonsOptions = {},
): Promise<string> {
  const normalizedTicker = normalizeTicker(ticker)
  if (!normalizedTicker) return ''

  const postMortemDir = resolvePostMortemDir(options)
  if (!postMortemDir || !existsSync(postMortemDir)) return ''

  const lessons = await readPostMortemLessons(postMortemDir, normalizedTicker)
  if (!lessons.length) return ''

  return formatMemoryContext(
    normalizedTicker,
    currentVix,
    lessons.slice(0, clampInteger(options.maxLessons ?? DEFAULT_MAX_LESSONS, 1, 20)),
    lessons.length,
  )
}

export async function retrievePastLessonsForTickers(
  tickers: string[],
  currentVix: number,
  options: RetrievePastLessonsOptions = {},
): Promise<string> {
  const uniqueTickers = Array.from(new Set(tickers.map(normalizeTicker).filter(Boolean)))
  if (!uniqueTickers.length) return ''

  const contexts = (await Promise.all(uniqueTickers.map(ticker =>
    retrievePastLessons(ticker, currentVix, options).catch(() => '')
  ))).filter(Boolean)

  if (!contexts.length) return ''

  return [
    '[OpenClaw 歷史記憶庫檢索結果]',
    `本次推演已喚醒 ${contexts.length}/${uniqueTickers.length} 個標的的歷史檢討記憶。`,
    '',
    contexts.map(stripMemoryHeader).join('\n\n'),
  ].join('\n').trim()
}

export async function listPostMortemReports(
  options: RetrievePastLessonsOptions = {},
): Promise<PostMortemReport[]> {
  const postMortemDir = resolvePostMortemDir(options)
  if (!postMortemDir || !existsSync(postMortemDir)) return []

  const fileNames = (await readdir(postMortemDir))
    .filter(fileName => fileName.toLowerCase().endsWith('.md'))

  const reports = (await Promise.all(fileNames.map(async fileName => {
    const targetPath = resolve(postMortemDir, basename(fileName))
    if (!targetPath.startsWith(postMortemDir)) return null

    const [markdown, fileStat] = await Promise.all([
      readFile(targetPath, 'utf-8'),
      stat(targetPath),
    ])
    const ticker = extractTicker(markdown, fileName)
    if (!ticker) return null
    const lesson = parsePostMortemMarkdown({
      ticker,
      fileName,
      markdown,
      fallbackDate: fileStat.mtime.toISOString(),
    })

    return {
      ...lesson,
      id: `${lesson.date}-${lesson.ticker}-${fileName}`,
      path: targetPath,
      relativePath: options.knowledgeRoot && targetPath.startsWith(resolve(options.knowledgeRoot))
        ? targetPath.slice(resolve(options.knowledgeRoot).length + 1)
        : undefined,
      markdown,
      agentScores: extractAgentScoreDeltas(markdown),
      updatedAt: fileStat.mtime.toISOString(),
    } satisfies PostMortemReport
  }))).filter((report): report is PostMortemReport => Boolean(report))

  return reports.sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt))
}

async function readPostMortemLessons(postMortemDir: string, ticker: string): Promise<PastLesson[]> {
  const fileNames = (await readdir(postMortemDir))
    .filter(fileName => fileName.toLowerCase().endsWith('.md'))

  const lessons = (await Promise.all(fileNames.map(async fileName => {
    const targetPath = resolve(postMortemDir, basename(fileName))
    if (!targetPath.startsWith(postMortemDir)) return null

    const [markdown, fileStat] = await Promise.all([
      readFile(targetPath, 'utf-8'),
      stat(targetPath),
    ])

    const parsedTicker = extractTicker(markdown, fileName)
    if (parsedTicker !== ticker) return null

    return parsePostMortemMarkdown({
      ticker,
      fileName,
      markdown,
      fallbackDate: fileStat.mtime.toISOString(),
    })
  }))).filter((lesson): lesson is PastLesson => Boolean(lesson))

  return lessons.sort((a, b) => b.date.localeCompare(a.date))
}

function parsePostMortemMarkdown(input: {
  ticker: string
  fileName: string
  markdown: string
  fallbackDate: string
}): PastLesson {
  const resultLine = matchLine(input.markdown, /\*\*Result:\*\*\s*([^\n]+)/i)
  const result = normalizeResult(resultLine)
  const pnlPct = extractPnlPct(resultLine)
  const actionableInsight =
    matchLine(input.markdown, /\*\*Actionable Insight:\*\*\s*([^\n]+)/i) ||
    matchLine(input.markdown, /Actionable Insight\s*[:：]\s*([^\n]+)/i) ||
    '未記錄具體 Actionable Insight。'

  return {
    ticker: input.ticker,
    fileName: input.fileName,
    date: extractDate(input.markdown, input.fileName, input.fallbackDate),
    result,
    pnlPct,
    vix: extractVix(input.markdown),
    actionableInsight: compactText(actionableInsight, 260),
  }
}

function formatMemoryContext(ticker: string, currentVix: number, lessons: PastLesson[], totalCount: number): string {
  const wins = lessons.filter(lesson => lesson.result === 'Win').length
  const losses = lessons.filter(lesson => lesson.result === 'Loss').length
  const flat = lessons.filter(lesson => lesson.result === 'Flat').length
  const currentVixText = Number.isFinite(currentVix) ? currentVix.toFixed(1) : 'n/a'
  const lessonLines = lessons.map(lesson => {
    const resultLabel = resultText(lesson.result)
    const pnl = Number.isFinite(lesson.pnlPct) ? ` ${formatSigned(lesson.pnlPct!)}%` : ''
    const vix = Number.isFinite(lesson.vix) ? `，當時 VIX ${lesson.vix!.toFixed(1)}` : ''
    const vixContrast = Number.isFinite(lesson.vix) && Number.isFinite(currentVix)
      ? `，目前 VIX ${currentVixText}（差 ${formatSigned(currentVix - lesson.vix!)}）`
      : ''
    return `- ${lesson.date}（${resultLabel}${pnl}${vix}${vixContrast}）：${lesson.actionableInsight}`
  })

  return [
    '[OpenClaw 歷史記憶庫檢索結果]',
    `標的 ${ticker} 過去共有 ${totalCount} 筆平倉紀錄（最近 ${lessons.length} 筆：${wins} 勝 ${losses} 敗${flat ? ` ${flat} 平` : ''}）。`,
    `目前 VIX：${currentVixText}。`,
    '關鍵歷史教訓：',
    ...lessonLines,
  ].join('\n').trim()
}

function resolvePostMortemDir(options: RetrievePastLessonsOptions): string {
  if (options.postMortemDir) return resolve(options.postMortemDir)
  const knowledgeRoot = options.knowledgeRoot || process.env.WIKI_PATH || process.env.HERMES_KNOWLEDGE_ROOT || ''
  if (!knowledgeRoot) return ''
  return resolve(knowledgeRoot, 'trading-journal', 'post-mortems')
}

function extractTicker(markdown: string, fileName: string): string {
  const heading = markdown.match(/^#\s*Trade Post-Mortem:\s*([A-Z0-9.-]+)/im)?.[1]
  if (heading) return normalizeTicker(heading)

  const fromFile = fileName.match(/^\d{4}-\d{2}-\d{2}-([A-Z0-9.-]+)-/i)?.[1]
  return normalizeTicker(fromFile || '')
}

function extractDate(markdown: string, fileName: string, fallbackDate: string): string {
  const closed = matchLine(markdown, /\*\*Closed:\*\*\s*([^\n]+)/i)
  const closedDate = closed.match(/\d{4}-\d{2}-\d{2}/)?.[0]
  if (closedDate) return closedDate

  const fileDate = fileName.match(/\d{4}-\d{2}-\d{2}/)?.[0]
  if (fileDate) return fileDate

  return fallbackDate.slice(0, 10)
}

function extractVix(markdown: string): number | undefined {
  const patterns = [
    /\bVIX\b\s*(?:[:：=]|was|at|state)?\s*[^0-9\n-]{0,24}(-?\d+(?:\.\d+)?)/i,
    /\*\*VIX:\*\*\s*(-?\d+(?:\.\d+)?)/i,
  ]
  for (const pattern of patterns) {
    const raw = markdown.match(pattern)?.[1]
    const value = Number(raw)
    if (Number.isFinite(value)) return value
  }
  return undefined
}

function extractAgentScoreDeltas(markdown: string): PostMortemReport['agentScores'] {
  return {
    quant: extractDelta(markdown, /\*\*Quant Contribution:\*\*\s*([-+]?\d+(?:\.\d+)?)/i),
    bull: extractDelta(markdown, /\*\*Bull Agent Prediction:\*\*[\s\S]*?->\s*([-+]?\d+(?:\.\d+)?)/i),
    bear: extractDelta(markdown, /\*\*Bear Agent Warning:\*\*[\s\S]*?->\s*([-+]?\d+(?:\.\d+)?)/i),
  }
}

function extractDelta(markdown: string, pattern: RegExp): number | null {
  const raw = markdown.match(pattern)?.[1]
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function normalizeTicker(value: string): string {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '')
}

function normalizeResult(value: string): PastLesson['result'] {
  const text = value.toLowerCase()
  if (text.includes('win') || text.includes('獲利') || text.includes('勝')) return 'Win'
  if (text.includes('loss') || text.includes('虧損') || text.includes('敗')) return 'Loss'
  if (text.includes('flat') || text.includes('平')) return 'Flat'
  return 'Unknown'
}

function extractPnlPct(value: string): number | undefined {
  const raw = value.match(/([-+]?\d+(?:\.\d+)?)\s*%/)?.[1]
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function matchLine(markdown: string, pattern: RegExp): string {
  return (markdown.match(pattern)?.[1] || '').trim()
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

function resultText(result: PastLesson['result']): string {
  if (result === 'Win') return '獲利'
  if (result === 'Loss') return '虧損'
  if (result === 'Flat') return '平盤'
  return '未知'
}

function formatSigned(value: number): string {
  if (!Number.isFinite(value)) return 'n/a'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

function clampInteger(value: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? Math.round(value) : min
  return Math.min(max, Math.max(min, parsed))
}

function stripMemoryHeader(value: string): string {
  return value.replace(/^\[OpenClaw 歷史記憶庫檢索結果\]\n?/, '').trim()
}
