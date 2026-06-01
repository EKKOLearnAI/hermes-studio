export type AuroraCapabilityStatus = 'ready' | 'partial' | 'legacy'

export type AuroraAppKind =
  | 'quant-lab'
  | 'tradingview'
  | 'mirofish'
  | 'mirofish-arena'
  | 'mirofish-graph'
  | 'life-os'
  | 'kanban'
  | 'memory'
  | 'files'
  | 'video-studio'
  | 'browser'
  | 'jobs'
  | 'history'
  | 'models'
  | 'profiles'
  | 'channels'
  | 'group-chat'
  | 'gateways'
  | 'logs'
  | 'usage'
  | 'skills'
  | 'plugins'
  | 'code-intelligence'
  | 'system-status'
  | 'settings'

export interface AuroraAppWindow {
  kind: AuroraAppKind
  title: string
  subtitle: string
}

export interface AuroraLauncherApp {
  kind: AuroraAppKind
  label: string
  icon: string
  description: string
}

export interface AuroraAppCapability extends AuroraAppWindow {
  intentPattern: RegExp
  launcher?: AuroraLauncherApp
}

export interface AuroraDesktopPreset {
  id: string
  label: string
  description: string
  pinnedApps: AuroraAppKind[]
}

export interface AuroraCommandCapability {
  id: string
  label: string
  legacySurface: string
  auroraEntry: string
  mode: string
  security: string
  command: string
  status?: AuroraCapabilityStatus
  appKind?: AuroraAppKind
  toolIds?: string[]
}

export const AURORA_APP_CAPABILITIES: Readonly<Record<AuroraAppKind, AuroraAppCapability>> = {
  'life-os': {
    kind: 'life-os',
    title: 'LifeOS',
    subtitle: 'FIRE · Budget · Net Worth',
    intentPattern: /\blife\s*os\b|lifeos|\bfire\b|財務|預算|淨資產|净资产|現金流|现金流/i,
    launcher: {
      kind: 'life-os',
      label: 'LifeOS',
      icon: 'LO',
      description: 'Finance and FIRE dashboard',
    },
  },
  'quant-lab': {
    kind: 'quant-lab',
    title: 'Quant Lab',
    subtitle: 'Top 10 · Paper Trading · Risk Console',
    intentPattern: /\bquant\s*lab\b|\bquant\b|量化|選股|选股|紙上交易|纸上交易|paper trading/i,
    launcher: {
      kind: 'quant-lab',
      label: 'Quant',
      icon: 'QL',
      description: 'Top 10 and paper trading',
    },
  },
  tradingview: {
    kind: 'tradingview',
    title: 'TradingView',
    subtitle: 'Live Chart · Neural Ticker Sync',
    intentPattern: /\btradingview\b|\blive\s*chart\b|\bchart\b|\bquote\b|看盤|看盘|走勢|走势|圖表|图表|即時行情|实时行情/i,
    launcher: {
      kind: 'tradingview',
      label: 'Chart',
      icon: 'TV',
      description: 'Live market chart',
    },
  },
  mirofish: {
    kind: 'mirofish',
    title: 'MiroFish',
    subtitle: 'Cosmic Graph · Debate Arena · Final Verdict',
    intentPattern: /\bmirofish\b|\brun\s+mirofish\b|\bsimulat(e|ion)\b|\bdebate\b|風險推演|风险推演|情境推演|情景推演|辯論|辩论|決策競技場|决策竞技场|推演/i,
    launcher: {
      kind: 'mirofish',
      label: 'MiroFish',
      icon: 'MF',
      description: 'Graph, debate, and verdict',
    },
  },
  'mirofish-arena': {
    kind: 'mirofish-arena',
    title: 'MiroFish Arena',
    subtitle: 'Macro · Bull · Bear · Synthesizer',
    intentPattern: /\bmirofish\b|\bsimulat(e|ion)\b|\bdebate\b|風險推演|风险推演|情境推演|情景推演|辯論|辩论|決策競技場|决策竞技场|推演/i,
    launcher: {
      kind: 'mirofish-arena',
      label: 'MiroFish',
      icon: 'MF',
      description: 'Multi-agent debate arena',
    },
  },
  'mirofish-graph': {
    kind: 'mirofish-graph',
    title: 'MiroFish Graph',
    subtitle: 'Knowledge Graph · Entities · Relationships',
    intentPattern: /\bmirofish\b.*\b(graph|knowledge|relationship|network)\b|\bgraph\s*relationship\b|\bknowledge\s*graph\b|mirofish.*圖譜|mirofish.*图谱|關係圖譜|关系图谱|關係圖|关系图|知識圖譜|知识图谱|圖譜|图谱/i,
    launcher: {
      kind: 'mirofish-graph',
      label: 'Graph',
      icon: 'KG',
      description: 'MiroFish knowledge graph',
    },
  },
  kanban: {
    kind: 'kanban',
    title: 'Kanban',
    subtitle: 'Tasks · Boards · Execution Flow',
    intentPattern: /\bkanban\b|\btasks?\b|\bto-?do\b|看板|任務看板|工作看板|任務|任务|待辦|待办/i,
    launcher: {
      kind: 'kanban',
      label: 'Kanban',
      icon: 'KB',
      description: 'Tasks and execution boards',
    },
  },
  memory: {
    kind: 'memory',
    title: 'Memory',
    subtitle: 'Governance · Notes · Identity Context',
    intentPattern: /\bmemory\b|\bmemories\b|記憶|记忆|長期記憶|长期记忆|筆記|笔记/i,
    launcher: {
      kind: 'memory',
      label: 'Memory',
      icon: 'MM',
      description: 'Notes and governed context',
    },
  },
  files: {
    kind: 'files',
    title: 'Files',
    subtitle: 'Workspace · Artifacts · Local Context',
    intentPattern: /\bfiles?\b|\bworkspace\b|檔案|文件|工作區|工作区/i,
    launcher: {
      kind: 'files',
      label: 'Files',
      icon: 'FI',
      description: 'Workspace files',
    },
  },
  'video-studio': {
    kind: 'video-studio',
    title: 'Video Studio',
    subtitle: 'Storyboard · Prompt · Render Brief',
    intentPattern: /\b(video|shorts?|reels?|tiktok|storyboard|render)\b|影片|短影片|直式影片|製作影片|制作影片|生成影片|產生影片|剪輯|分鏡|字幕|社群短視頻|社群短影片/i,
    launcher: {
      kind: 'video-studio',
      label: 'Video',
      icon: 'VS',
      description: 'Storyboard and AI video prompt',
    },
  },
  browser: {
    kind: 'browser',
    title: 'Aurora Web Sandbox',
    subtitle: 'Research Browser · Sandboxed Webview',
    intentPattern: /\b(browser|web\s*sandbox|webview|research\s*browser)\b|瀏覽器|浏览器|網頁沙盒|网页沙盒|研究瀏覽/i,
    launcher: {
      kind: 'browser',
      label: 'Browser',
      icon: 'WB',
      description: 'Sandboxed research browser',
    },
  },
  jobs: {
    kind: 'jobs',
    title: 'Tasks',
    subtitle: 'Automations · Scheduled Work · Jobs',
    intentPattern: /\bjobs?\b|\bautomations?\b|\bscheduled\b|任務排程|任务排程|排程|自動化|自动化/i,
  },
  history: {
    kind: 'history',
    title: 'History',
    subtitle: 'Sessions · Recall · Timeline',
    intentPattern: /\bhistory\b|\bsessions?\b|歷史|历史|對話紀錄|对话纪录|會話|会话/i,
  },
  models: {
    kind: 'models',
    title: 'Models',
    subtitle: 'Providers · Model Catalog · Defaults',
    intentPattern: /\bmodels?\b|模型|模型管理|model catalog/i,
    launcher: {
      kind: 'models',
      label: 'Models',
      icon: 'MO',
      description: 'Model catalog',
    },
  },
  profiles: {
    kind: 'profiles',
    title: 'Profiles',
    subtitle: 'Agents · Work Modes · Context Defaults',
    intentPattern: /\bprofiles?\b|\bagents?\b|角色|代理|代理人|設定檔|配置檔|配置文件/i,
  },
  'group-chat': {
    kind: 'group-chat',
    title: 'Group Chat',
    subtitle: 'Multi-Agent Rooms · Mentions · Shared Context',
    intentPattern: /\bgroup\s*chat\b|\bmulti-?agent\b|\bagent\s*(room|chat|meeting)\b|群聊|群組聊天|群组聊天|多代理|代理會議|代理会议/i,
    launcher: {
      kind: 'group-chat',
      label: 'Group',
      icon: 'GC',
      description: 'Multi-agent rooms',
    },
  },
  channels: {
    kind: 'channels',
    title: 'Channels',
    subtitle: 'Telegram · Discord · Platform Bridges',
    intentPattern: /\bchannels?\b|\btelegram\b|\bdiscord\b|頻道|频道|平台頻道|平台频道/i,
    launcher: {
      kind: 'channels',
      label: 'Channels',
      icon: 'CH',
      description: 'Platform bridges',
    },
  },
  gateways: {
    kind: 'gateways',
    title: 'Gateways',
    subtitle: 'Profiles · Provider Runtime · Health',
    intentPattern: /\bgateways?\b|網關|闸道|providers?|供應商|供应商/i,
  },
  logs: {
    kind: 'logs',
    title: 'Logs',
    subtitle: 'Runtime Events · Debug Trail',
    intentPattern: /\blogs?\b|日誌|日志|除錯紀錄|debug logs?/i,
    launcher: {
      kind: 'logs',
      label: 'Logs',
      icon: 'LG',
      description: 'Debug events',
    },
  },
  usage: {
    kind: 'usage',
    title: 'Usage',
    subtitle: 'Tokens · Cost · Runtime Accounting',
    intentPattern: /\busage\b|\btokens?\b|\bcosts?\b|用量|token|成本|花費|费用/i,
  },
  skills: {
    kind: 'skills',
    title: 'Skills',
    subtitle: 'Capabilities · Prompts · Tooling',
    intentPattern: /\bskills?\b|技能|能力/i,
  },
  plugins: {
    kind: 'plugins',
    title: 'Plugins',
    subtitle: 'Extensions · Hooks · Integrations',
    intentPattern: /\bplugins?\b|\bextensions?\b|插件|外掛|扩展/i,
  },
  'code-intelligence': {
    kind: 'code-intelligence',
    title: 'Code Intelligence',
    subtitle: 'Symbols · Workspace Insight · Navigation',
    intentPattern: /\bcode intelligence\b|\bsymbols?\b|程式理解|代码理解|符號|符号/i,
  },
  'system-status': {
    kind: 'system-status',
    title: 'System Status',
    subtitle: 'Health · Services · Local Runtime',
    intentPattern: /\bsystem status\b|\bstatus center\b|\bhealth\b|系統狀態|系统状态|健康檢查|健康检查/i,
    launcher: {
      kind: 'system-status',
      label: 'Status',
      icon: 'ST',
      description: 'Runtime health',
    },
  },
  settings: {
    kind: 'settings',
    title: 'Settings',
    subtitle: 'Preferences · Account · Aurora Controls',
    intentPattern: /\bsettings?\b|偏好設定|設定|设置|preferences?/i,
  },
}

export const AURORA_APP_CAPABILITY_ORDER: AuroraAppKind[] = [
  'life-os',
  'quant-lab',
  'tradingview',
  'mirofish-graph',
  'mirofish-arena',
  'mirofish',
  'kanban',
  'memory',
  'files',
  'video-studio',
  'browser',
  'jobs',
  'history',
  'models',
  'profiles',
  'group-chat',
  'channels',
  'gateways',
  'logs',
  'usage',
  'skills',
  'plugins',
  'code-intelligence',
  'system-status',
  'settings',
]

export const AURORA_LAUNCHER_APP_KINDS: AuroraAppKind[] = [
  'life-os',
  'quant-lab',
  'tradingview',
  'mirofish',
  'kanban',
  'memory',
  'files',
  'video-studio',
  'browser',
  'models',
  'group-chat',
  'channels',
  'system-status',
  'logs',
]

export const AURORA_LAUNCHER_APPS: AuroraLauncherApp[] = AURORA_LAUNCHER_APP_KINDS
  .map(kind => AURORA_APP_CAPABILITIES[kind].launcher)
  .filter((app): app is AuroraLauncherApp => Boolean(app))

export const AURORA_DEFAULT_PINNED_APP_KINDS: AuroraAppKind[] = ['life-os', 'quant-lab']

export const AURORA_DESKTOP_PRESETS: AuroraDesktopPreset[] = [
  {
    id: 'research',
    label: 'Research',
    description: 'Memory, files, group',
    pinnedApps: ['memory', 'files', 'group-chat'],
  },
  {
    id: 'market',
    label: 'Market',
    description: 'Quant, MiroFish, logs',
    pinnedApps: ['quant-lab', 'mirofish', 'logs'],
  },
  {
    id: 'life',
    label: 'Life',
    description: 'LifeOS, tasks, memory',
    pinnedApps: ['life-os', 'kanban', 'memory'],
  },
  {
    id: 'build',
    label: 'Build',
    description: 'Files, Kanban, code',
    pinnedApps: ['files', 'kanban', 'code-intelligence', 'logs'],
  },
]

export const AURORA_COMMAND_CAPABILITIES: AuroraCommandCapability[] = [
  {
    id: 'chat',
    label: 'Dialogues / Chat',
    legacySurface: '對話',
    auroraEntry: 'OmniBar + Hermes stream fallback',
    mode: 'Native',
    security: 'L1 / stream',
    command: '直接輸入任何意圖',
    status: 'ready',
  },
  {
    id: 'history',
    label: 'History',
    legacySurface: '歷史',
    auroraEntry: 'Cmd/Ctrl+K palette + App Mode',
    mode: 'Top Bar',
    security: 'L1 ReadOnly',
    command: 'open history',
    appKind: 'history',
    toolIds: ['aurora.legacyApp.open'],
  },
  {
    id: 'kanban',
    label: 'Tasks / Kanban',
    legacySurface: '任務 / 看板',
    auroraEntry: 'Task Widget + Kanban App',
    mode: 'Widget + App Mode',
    security: 'L1 read / L3 write',
    command: 'What are my tasks for today?',
    appKind: 'kanban',
    toolIds: ['legacy.kanban.listTasks', 'legacy.kanban.createTask'],
  },
  {
    id: 'memory',
    label: 'Memory',
    legacySurface: '記憶',
    auroraEntry: 'Memory Widget + Review Queue',
    mode: 'Widget + Governance',
    security: 'L1 read / L2 draft',
    command: 'search memory Aurora',
    appKind: 'memory',
    toolIds: ['legacy.memory.search', 'aurora.memory.propose'],
  },
  {
    id: 'life-os',
    label: 'LifeOS',
    legacySurface: 'LifeOS',
    auroraEntry: 'Financial Widget + App Mode',
    mode: 'Immersive App',
    security: 'L1 read / L3 briefing',
    command: '打開 LIFE OS',
    appKind: 'life-os',
    toolIds: ['lifeos.viewState', 'lifeos.generateBriefing'],
  },
  {
    id: 'quant-lab',
    label: 'Quant Lab',
    legacySurface: '量化推演',
    auroraEntry: 'Metric Widget + App Mode',
    mode: 'Immersive App',
    security: 'L1 read / L3 journal',
    command: 'Quant Lab today top 10',
    appKind: 'quant-lab',
    toolIds: ['quant.viewLab', 'quant.phaseCheck', 'quant.paperJournal.create'],
  },
  {
    id: 'tradingview',
    label: 'TradingView',
    legacySurface: 'Live Chart',
    auroraEntry: 'Native TradingView App + Ticker Event Bus',
    mode: 'Immersive App',
    security: 'L1 market data',
    command: 'open chart TSLA',
    appKind: 'tradingview',
    toolIds: ['aurora.legacyApp.open'],
  },
  {
    id: 'mirofish',
    label: 'MiroFish',
    legacySurface: '量化推演 / MiroFish',
    auroraEntry: 'Grand Merge App Mode',
    mode: 'Immersive App',
    security: 'L1 sandbox',
    command: '推演 AVGO',
    appKind: 'mirofish',
    toolIds: ['quant.mirofish.run'],
  },
  {
    id: 'mirofish-graph',
    label: 'MiroFish Graph',
    legacySurface: 'MiroFish Knowledge Graph',
    auroraEntry: 'Immersive Graph App',
    mode: 'Immersive App',
    security: 'L1 read-only',
    command: '打開 MiroFish 圖譜',
    appKind: 'mirofish-graph',
    toolIds: ['quant.mirofish.graph.open'],
  },
  {
    id: 'files',
    label: 'Files',
    legacySurface: '檔案',
    auroraEntry: 'Workspace App Mode',
    mode: 'App Mode',
    security: 'L1 browsing',
    command: 'open files',
    appKind: 'files',
    toolIds: ['aurora.legacyApp.open'],
  },
  {
    id: 'video-studio',
    label: 'Video Studio',
    legacySurface: 'Hermes creative prompt',
    auroraEntry: 'Native Video Studio App Mode',
    mode: 'Immersive App',
    security: 'L1 local storyboard',
    command: '請製作一支 9:16 直式短影片',
    appKind: 'video-studio',
    toolIds: ['aurora.videoStudio.open'],
  },
  {
    id: 'browser',
    label: 'Web Sandbox',
    legacySurface: 'Research Browser',
    auroraEntry: 'Sandbox Browser App Mode',
    mode: 'Immersive App',
    security: 'L1 sandboxed iframe',
    command: 'open google.com',
    appKind: 'browser',
    toolIds: ['aurora.browser.open'],
  },
  {
    id: 'models-settings',
    label: 'Models / Settings',
    legacySurface: '模型 / 設定',
    auroraEntry: 'Top Bar + App Mode',
    mode: 'Top Bar',
    security: 'L1 config view',
    command: 'open models',
    appKind: 'models',
    toolIds: ['aurora.legacyApp.open'],
  },
  {
    id: 'skills-plugins',
    label: 'Skills / Plugins',
    legacySurface: '技能 / 插件',
    auroraEntry: '/ palette + App Mode',
    mode: 'Command Palette',
    security: 'L1 discovery',
    command: '/skill:aurora-memory-governance',
    appKind: 'skills',
    toolIds: ['aurora.legacyApp.open'],
  },
  {
    id: 'ops',
    label: 'Logs / Usage / Status',
    legacySurface: '日誌 / 用量 / 監控',
    auroraEntry: 'Status header + App Mode',
    mode: 'Top Bar',
    security: 'L1 telemetry',
    command: 'open system status',
    appKind: 'system-status',
    toolIds: ['aurora.legacyApp.open'],
  },
  {
    id: 'agents',
    label: 'Agents / Channels',
    legacySurface: '群聊 / 頻道 / 代理',
    auroraEntry: '@ summon + Group Chat App Mode',
    mode: 'Palette + App Mode',
    security: 'L1 summon',
    command: 'open group chat',
    appKind: 'group-chat',
    toolIds: ['aurora.legacyApp.open'],
  },
  {
    id: 'hub',
    label: 'Hub / Proxy',
    legacySurface: '中轉站',
    auroraEntry: 'Retired from Aurora surface',
    mode: 'Retired',
    security: 'Excluded',
    command: 'Not exposed in Aurora OS',
    status: 'legacy',
  },
]

export function getAuroraAppCapability(kind: AuroraAppKind) {
  return AURORA_APP_CAPABILITIES[kind]
}

export function getAuroraAppWindowMeta(kind: AuroraAppKind): AuroraAppWindow {
  const { intentPattern: _intentPattern, launcher: _launcher, ...meta } = getAuroraAppCapability(kind)
  return meta
}
