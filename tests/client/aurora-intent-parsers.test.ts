import { describe, expect, it } from 'vitest'
import {
  extractMiroFishTargetTicker,
  extractRequestedGeneratedWidgetName,
  getAuroraToolCommandInput,
  hasAuroraToolPrefix,
  isCreateTaskIntent,
  isGeneratedWidgetListIntent,
  isLifeOsBriefingIntent,
  isLifeOsViewIntent,
  isMemoryQuery,
  isMiroFishGraphIntent,
  isMiroFishRunIntent,
  isProposeMemoryIntent,
  isQuantPaperJournalIntent,
  isQuantPhaseCheckIntent,
  isQuantViewIntent,
  isTaskQuery,
  parseCreateTask,
  parseBrowserOpenIntent,
  parseLegacyAppOpenIntent,
  parseMemoryProposal,
  parseMiroFishDebateIntent,
  parseQuantPaperJournal,
  parseTickerFocusIntent,
  resolveMiroFishInitialView,
  stripAuroraToolPrefix,
} from '@/services/hermes/aurora/intent-parsers'

describe('Aurora intent parsers', () => {
  it('requires explicit command grammar before the OmniBar can open Aurora cards', () => {
    expect(hasAuroraToolPrefix('!推演 TSLA')).toBe(true)
    expect(hasAuroraToolPrefix('！打開 Quant Lab')).toBe(true)
    expect(stripAuroraToolPrefix('! 推演 TSLA')).toBe('推演 TSLA')
    expect(stripAuroraToolPrefix('！打開 Quant Lab')).toBe('打開 Quant Lab')

    expect(getAuroraToolCommandInput('!推演 將 Aurora OS 開源的利弊')).toBe('推演 將 Aurora OS 開源的利弊')
    expect(getAuroraToolCommandInput('打開 Quant Lab')).toBe('打開 Quant Lab')
    expect(getAuroraToolCommandInput('推演 TSLA')).toBe('推演 TSLA')
    expect(getAuroraToolCommandInput('請製作一支 9:16 直式短影片')).toBe('請製作一支 9:16 直式短影片')

    expect(getAuroraToolCommandInput('推演 將 Aurora OS 開源的利弊')).toBeNull()
    expect(getAuroraToolCommandInput('學術派 市場理論與金融模型 因子選股模組 Fama French Asness')).toBeNull()
    expect(getAuroraToolCommandInput('/status')).toBeNull()
  })

  it.each([
    ['What are my tasks for today?'],
    ['show my current todo list'],
    ['今天有哪些任務'],
    ['目前我的待辦工作'],
  ])('recognizes task read intents: %s', (input) => {
    expect(isTaskQuery(input)).toBe(true)
  })

  it.each([
    ['create task Review Aurora routing'],
    ['add a todo to inspect Quant Lab'],
    ['新增任務 檢查 LifeOS 財務摘要'],
    ['建立待辦 更新 Aurora 文件'],
  ])('recognizes and parses task creation intents: %s', (input) => {
    expect(isCreateTaskIntent(input)).toBe(true)
    const task = parseCreateTask(input)
    expect(task?.title).toBeTruthy()
    expect(task?.body).toContain(input)
  })

  it.each([
    ['search memory Aurora'],
    ['find profile notes about Quant'],
    ['搜尋記憶 Aurora'],
    ['找看看筆記 Vibe Coding'],
  ])('recognizes memory search intents: %s', (input) => {
    expect(isMemoryQuery(input)).toBe(true)
  })

  it.each([
    ['remember that Aurora memories require review', 'Aurora memories require review', 85],
    ['definitely remember this preference: use Traditional Chinese', 'use Traditional Chinese', 95],
    ['記住 重要偏好：Aurora 預設保持極簡介面', 'Aurora 預設保持極簡介面', 95],
    ['maybe remember this note: Quant source may be stale', 'Quant source may be stale', 62],
  ])('parses proposed memory drafts: %s', (input, expectedContent, expectedConfidence) => {
    expect(isProposeMemoryIntent(input)).toBe(true)
    const proposal = parseMemoryProposal(input)
    expect(proposal?.content).toContain(expectedContent)
    expect(proposal?.source).toBe('Chat Interaction')
    expect(proposal?.confidenceScore).toBe(expectedConfidence)
  })

  it.each([
    ['open LifeOS', 'life-os'],
    ['打開 LIFE OS', 'life-os'],
    ['open Quant Lab', 'quant-lab'],
    ['open chart TSLA', 'tradingview'],
    ['打開走勢圖', 'tradingview'],
    ['open MiroFish graph', 'mirofish-graph'],
    ['open MiroFish debate', 'mirofish-arena'],
    ['啟動量化推演', 'quant-lab'],
    ['open Kanban', 'kanban'],
    ['打開記憶', 'memory'],
    ['open group chat', 'group-chat'],
    ['開啟平台頻道', 'channels'],
    ['open system status', 'system-status'],
    ['open code intelligence', 'code-intelligence'],
  ])('maps App Mode open intents: %s', (input, expectedKind) => {
    expect(parseLegacyAppOpenIntent(input)).toBe(expectedKind)
  })

  it.each([
    ['open hub'],
    ['launch proxy'],
    ['打開中轉站'],
    ['開啟 proxy hub'],
  ])('keeps Hub/Proxy excluded from Aurora App Mode: %s', (input) => {
    expect(parseLegacyAppOpenIntent(input)).toBeNull()
  })

  it('separates LifeOS view intents from briefing generation intents', () => {
    expect(isLifeOsViewIntent('open LifeOS financial dashboard')).toBe(true)
    expect(isLifeOsViewIntent('財務狀態總覽')).toBe(true)
    expect(isLifeOsBriefingIntent('generate LifeOS daily briefing')).toBe(true)
    expect(isLifeOsViewIntent('generate LifeOS daily briefing')).toBe(false)
    expect(isLifeOsBriefingIntent('生成 LifeOS 晨報')).toBe(true)
  })

  it('separates Quant view, phase check, and paper journal intents', () => {
    expect(isQuantViewIntent('Quant Lab today top 10')).toBe(true)
    expect(isQuantViewIntent('量化今日前十')).toBe(true)
    expect(isQuantViewIntent('幫我選股推薦美股候選')).toBe(true)
    expect(isQuantViewIntent('市場理論與金融模型 行為心理模組 Kahneman 因子選股模組 Fama 趨勢交易模組 Soros')).toBe(false)
    expect(isQuantViewIntent('學術派 市場理論與金融模型 可用在美股系統 因子選股模組 Fama French Asness 趨勢交易模組 Druckenmiller Soros Simons')).toBe(false)

    expect(isQuantPhaseCheckIntent('run Quant phase check')).toBe(true)
    expect(isQuantViewIntent('run Quant phase check')).toBe(false)

    expect(isQuantPaperJournalIntent('add paper journal for NVDA buy breakout plan')).toBe(true)
    expect(isQuantViewIntent('add paper journal for NVDA buy breakout plan')).toBe(false)

    const journal = parseQuantPaperJournal('add paper journal for NVDA buy breakout plan')
    expect(journal).toMatchObject({
      ticker: 'NVDA',
      journalAction: 'BUY',
    })
    expect(journal?.note).toContain('NVDA')
  })

  it.each([
    ['mirofish simulate downside risk'],
    ['run a debate arena'],
    ['風險推演 NVDA'],
    ['辯論 今日量化風險'],
    ['Run MiroFish on AVGO'],
    ['打開決策競技場'],
    ['推演'],
  ])('recognizes MiroFish debate sandbox intents: %s', (input) => {
    expect(isMiroFishRunIntent(input)).toBe(true)
    expect(isQuantViewIntent(input)).toBe(false)
  })

  it.each([
    ['推演 TSLA', 'TSLA', 'NASDAQ:TSLA'],
    ['analyze MU', 'MU', 'NASDAQ:MU'],
    ['chart $NVDA', 'NVDA', 'NASDAQ:NVDA'],
    ['看盤 BTC', 'BTC', 'COINBASE:BTCUSD'],
    ['quote NASDAQ:AVGO', 'NASDAQ:AVGO', 'NASDAQ:AVGO'],
  ])('extracts TradingView ticker focus intents: %s', (input, rawSymbol, symbol) => {
    expect(parseTickerFocusIntent(input)).toEqual({ rawSymbol, symbol })
  })

  it.each([
    ['Summarize this'],
    ['推演 將 Aurora OS 開源的利弊'],
    ['分析 Vite 替換 webpack 的風險'],
  ])('does not create ticker focus from generic context: %s', (input) => {
    expect(parseTickerFocusIntent(input)).toBeNull()
  })

  it.each([
    ['Run MiroFish on AVGO', 'AVGO'],
    ['run mirofish on nvda', 'NVDA'],
    ['Run MiroFish for AVGO.US', 'AVGO.US'],
    ['推演 AMD', 'AMD'],
    ['推演 $AVGO', 'AVGO'],
    ['辯論 NVDA.US', 'NVDA.US'],
    ['風險推演 MSFT', 'MSFT'],
    ['打開決策競技場', null],
  ])('extracts optional MiroFish target tickers: %s', (input, expectedTicker) => {
    expect(extractMiroFishTargetTicker(input)).toBe(expectedTicker)
    expect(parseMiroFishDebateIntent(input)).toEqual({ targetTicker: expectedTicker, topic: null })
  })

  it.each([
    ['推演 將 Aurora OS 開源的利弊', '將 Aurora OS 開源的利弊'],
    ['分析 Vite 替換 webpack 的風險', 'Vite 替換 webpack 的風險'],
    ['MiroFish debate whether to modularize the Aurora shell', 'whether to modularize the Aurora shell'],
  ])('extracts Universal Brain debate topics: %s', (input, expectedTopic) => {
    expect(isMiroFishRunIntent(input)).toBe(true)
    expect(parseMiroFishDebateIntent(input)).toEqual({
      targetTicker: null,
      topic: expectedTopic,
    })
  })

  it.each([
    ['推演 AVGO', 'workbench'],
    ['打開決策競技場', 'workbench'],
    ['MiroFish GraphRAG pipeline AVGO', 'pipeline'],
    ['推演前構建 AVGO', 'pipeline'],
    ['open MiroFish graph', 'graph'],
  ])('resolves the MiroFish initial App Mode view: %s', (input, expectedView) => {
    expect(resolveMiroFishInitialView(input)).toBe(expectedView)
  })

  it.each([
    ['open google.com', 'https://google.com/'],
    ['open https://example.com/docs', 'https://example.com/docs'],
    ['前往 127.0.0.1:8648/#/hermes/chat', 'http://127.0.0.1:8648/#/hermes/chat'],
  ])('parses sandbox browser open intents: %s', (input, expectedUrl) => {
    expect(parseBrowserOpenIntent(input)).toBe(expectedUrl)
    expect(parseLegacyAppOpenIntent(input)).toBeNull()
  })

  it.each([
    ['open files'],
    ['open LifeOS'],
    ['open hub'],
    ['open not a url'],
  ])('does not steal non-browser open intents: %s', (input) => {
    expect(parseBrowserOpenIntent(input)).toBeNull()
  })

  it.each([
    ['open MiroFish graph'],
    ['打開 MiroFish 圖譜'],
    ['打開圖譜'],
    ['打開關係圖'],
    ['查看知識圖譜'],
    ['show MiroFish relationship network'],
    ['graph relationship visualization'],
  ])('recognizes MiroFish graph app intents: %s', (input) => {
    expect(isMiroFishGraphIntent(input)).toBe(true)
    expect(isMiroFishRunIntent(input)).toBe(false)
    expect(isQuantViewIntent(input)).toBe(false)
  })

  it.each([
    ['list generated widgets'],
    ['show generated components'],
    ['列出生成小工具'],
    ['有哪些 widgets'],
  ])('recognizes generated widget library intents: %s', (input) => {
    expect(isGeneratedWidgetListIntent(input)).toBe(true)
  })

  it.each([
    ['open PomodoroGlassWidget', 'PomodoroGlassWidget'],
    ['load PomodoroGlassWidget.vue', 'PomodoroGlassWidget'],
    ['打開 pomodoro glass widget 小工具', 'PomodoroGlass'],
    ['啟動 aurora focus panel component', 'Focus'],
  ])('extracts safe generated widget names: %s', (input, expectedName) => {
    expect(extractRequestedGeneratedWidgetName(input)).toBe(expectedName)
  })

  it.each([
    ['open ../Secrets'],
    ['load widget'],
    ['啟動 小工具'],
    ['render ../../Bad.vue'],
  ])('rejects ambiguous or unsafe generated widget names: %s', (input) => {
    expect(extractRequestedGeneratedWidgetName(input)).toBeNull()
  })
})
