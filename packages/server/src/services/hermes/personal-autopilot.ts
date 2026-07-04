import { getHealthOverview, type HealthOverview } from './health-state'
import { getPersonalStateOverview, type PersonalStateOverview } from './personal-state'

export type AutopilotMode = 'silent' | 'nudge' | 'correct' | 'takeover' | 'upgrade'
export type AutopilotDomain = 'body' | 'diet' | 'skin' | 'recovery' | 'order' | 'planning'

export interface PersonalAutopilotSnapshot {
  generatedAt: string
  mode: AutopilotMode
  state: {
    body: string
    diet: string
    skin: string
    recovery: string
    order: string
  }
  nextAction: {
    id: string
    domain: AutopilotDomain
    title: string
    reason: string
    sourceId: string | null
    fallbackTitle: string
  }
  signals: Array<{ key: string; label: string; status: string; value: string }>
}

interface AutopilotTaskView {
  id: string
  title: string
  summary?: string
  notes?: string
  status?: string
  priority?: string
  dueAt?: string | null
  scheduledStart?: string | null
  scheduledEnd?: string | null
  projectId?: string | null
  tags?: string[]
}

interface PersonalAutopilotInput {
  now?: Date
  personal: PersonalStateOverview & {
    planningContext?: {
      todayTasks?: AutopilotTaskView[]
      overdueTasks?: AutopilotTaskView[]
    }
  }
  health: HealthOverview
}

const DOMAIN_KEYWORDS: Array<{ domain: AutopilotDomain; keywords: string[] }> = [
  { domain: 'diet', keywords: ['diet', 'meal', 'food', '早餐', '午餐', '晚餐', '饮食'] },
  { domain: 'body', keywords: ['workout', 'training', '运动', '训练', '体重', '身材'] },
  { domain: 'skin', keywords: ['skin', 'skincare', '护肤', '皮肤'] },
  { domain: 'recovery', keywords: ['sleep', '睡眠', '休息', '恢复'] },
  { domain: 'order', keywords: ['整理', '收纳', '家务', '秩序'] },
]

export function getPersonalAutopilotOverview(options: { profile?: string } = {}): PersonalAutopilotSnapshot {
  return buildPersonalAutopilotSnapshot({
    personal: getPersonalStateOverview({ profile: options.profile }),
    health: getHealthOverview({ profile: options.profile }),
  })
}

export function buildPersonalAutopilotSnapshot(input: PersonalAutopilotInput): PersonalAutopilotSnapshot {
  const now = input.now || new Date()
  const tasks = activeTasks(input.personal)
  const scheduledTasks = tasks
    .map(task => ({ task, sortValue: taskSortValue(task, now) }))
    .filter(item => Number.isFinite(item.sortValue))
    .sort((a, b) => a.sortValue - b.sortValue)
  const overdue = scheduledTasks.filter(item => item.sortValue < 0)
  const nextScheduled = scheduledTasks.find(item => item.sortValue >= 0)?.task
  const nextTask = nextScheduled || tasks[0] || null
  const mode = modeFor(now, overdue.length, nextScheduled ? taskSortValue(nextScheduled, now) : null)
  const nextAction = actionFor(nextTask, mode)

  return {
    generatedAt: now.toISOString(),
    mode,
    state: {
      body: bodyState(input.health),
      diet: dietState(input.health),
      skin: skinState(tasks),
      recovery: recoveryState(input.health),
      order: orderState(tasks),
    },
    nextAction,
    signals: signalsFor(input.health, tasks),
  }
}

function activeTasks(personal: PersonalAutopilotInput['personal']): AutopilotTaskView[] {
  const planningTasks = personal.planningContext?.todayTasks || personal.planningContext?.overdueTasks || []
  const source = planningTasks.length > 0 ? planningTasks : (personal.tasks as unknown as AutopilotTaskView[])
  return source.filter(task => !['done', 'cancelled'].includes(String(task.status || '').toLowerCase()))
}

function modeFor(now: Date, overdueCount: number, nextOffsetMinutes: number | null): AutopilotMode {
  if (overdueCount >= 2 && now.getHours() >= 21) return 'takeover'
  if (overdueCount > 0) return 'correct'
  if (nextOffsetMinutes !== null && nextOffsetMinutes <= 90) return 'nudge'
  return 'silent'
}

function actionFor(task: AutopilotTaskView | null, mode: AutopilotMode): PersonalAutopilotSnapshot['nextAction'] {
  if (!task) {
    return {
      id: 'autopilot-no-action',
      domain: 'planning',
      title: '保持观察',
      reason: '当前没有需要主动介入的行动。',
      sourceId: null,
      fallbackTitle: '记录一句当前状态',
    }
  }

  const domain = domainForTask(task)
  return {
    id: `autopilot-action-${task.id}`,
    domain,
    title: task.title,
    reason: reasonForMode(mode, domain),
    sourceId: task.id,
    fallbackTitle: fallbackForDomain(domain),
  }
}

function domainForTask(task: AutopilotTaskView): AutopilotDomain {
  const text = `${task.title} ${task.summary || ''} ${task.notes || ''} ${(task.tags || []).join(' ')}`.toLowerCase()
  return DOMAIN_KEYWORDS.find(entry => entry.keywords.some(keyword => text.includes(keyword.toLowerCase())))?.domain || 'planning'
}

function taskSortValue(task: AutopilotTaskView, now: Date): number {
  const value = task.scheduledStart || task.dueAt
  if (!value) return Number.POSITIVE_INFINITY
  const parsed = new Date(value).getTime()
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY
  return Math.round((parsed - now.getTime()) / 60_000)
}

function reasonForMode(mode: AutopilotMode, domain: AutopilotDomain): string {
  if (mode === 'takeover') return '今天已经开始失序，只保留一个能把你拉回来的动作。'
  if (mode === 'correct') return '这个动作已经偏离原计划，现在需要用现实版本纠偏。'
  if (mode === 'nudge') return '当前窗口适合处理这个动作。'
  if (domain === 'planning') return '系统还在观察当前状态。'
  return '这是当前最值得推进的身体改造动作。'
}

function fallbackForDomain(domain: AutopilotDomain): string {
  if (domain === 'body') return '做 5 分钟保底训练'
  if (domain === 'diet') return '补一份高蛋白食物'
  if (domain === 'skin') return '只做洁面和保湿'
  if (domain === 'recovery') return '关屏并准备睡觉'
  if (domain === 'order') return '整理 5 分钟'
  return '记录一句当前状态'
}

function bodyState(health: HealthOverview): string {
  const gaps = health.digitalTwinSummary?.externalConcernCount || 0
  return gaps > 0 ? 'needs_attention' : 'observing'
}

function dietState(health: HealthOverview): string {
  const consumedProtein = health.nutritionSummary?.consumed?.protein || 0
  const targetProtein = health.nutritionSummary?.targets?.protein || 0
  return targetProtein > 0 && consumedProtein < targetProtein ? 'below_target' : 'observing'
}

function skinState(tasks: AutopilotTaskView[]): string {
  return tasks.some(task => domainForTask(task) === 'skin') ? 'active' : 'observing'
}

function recoveryState(health: HealthOverview): string {
  return (health.internalMarkers || []).some(marker => marker.status && marker.status !== 'ok') ? 'needs_attention' : 'observing'
}

function orderState(tasks: AutopilotTaskView[]): string {
  return tasks.some(task => domainForTask(task) === 'order') ? 'active' : 'observing'
}

function signalsFor(health: HealthOverview, tasks: AutopilotTaskView[]): PersonalAutopilotSnapshot['signals'] {
  return [
    {
      key: 'weight',
      label: '体重',
      status: health.digitalTwinSummary?.currentWeightKg ? 'tracked' : 'missing',
      value: health.digitalTwinSummary?.currentWeightKg ? `${health.digitalTwinSummary.currentWeightKg} kg` : '--',
    },
    {
      key: 'tasks',
      label: '今日动作',
      status: tasks.length > 0 ? 'active' : 'empty',
      value: String(tasks.length),
    },
  ]
}
