/**
 * Zero-token 群协作模拟。
 *
 * Real collab runs call `kanban decompose` + worker LLMs. For product demos and
 * UX iteration that is too expensive, this module drives the same board + chat
 * surfaces with a scripted narrative: coordinator thinks → assigns → specialists
 * report → coordinator summarises — without shelling out to Hermes or any model.
 */

import { detectHermesRootHome } from '../hermes-path'

export interface SimulateAgent {
  profile: string
  name: string
  description?: string
}

export interface SimulateChildPlan {
  id: string
  title: string
  assignee: string
  assigneeName: string
  role: string
  summary: string
  /** Shown when this profile "calls" another profile mid-run. */
  handoffTo?: string
  handoffNote?: string
}

export interface SimulatePlan {
  rootId: string
  rootTitle: string
  children: SimulateChildPlan[]
  /** Ordered coordination story for the transcript. */
  chain: Array<{ from: string; to: string; action: string }>
}

const ROLE_HINTS: Array<{ match: RegExp; role: string; title: string; summary: string }> = [
  { match: /产品|prd|pm|mia|product/i, role: '产品经理', title: '撰写 PRD 与验收标准', summary: 'PRD 与验收标准已固化（模拟）。' },
  { match: /项目|经理|排期|leo|manager/i, role: '项目经理', title: '排期与跨角色依赖梳理', summary: '排期与依赖路径已梳理（模拟）。' },
  { match: /后端|api|backend|kai|服务/i, role: '后端研发', title: '实现登录与权限 API', summary: '后端 API 契约已就绪（模拟）。' },
  { match: /前端|ui|frontend|nina|页面/i, role: '前端研发', title: '实现登录页与权限管理 UI', summary: '前端页面联调通过（模拟）。' },
  { match: /测试|qa|test|sam|回归/i, role: '测试工程师', title: '编写用例并回归验收', summary: '用例回归通过，出具验收报告（模拟）。' },
]

const DEFAULT_DEV_TEAM: SimulateChildPlan[] = [
  {
    id: 'sim_prd',
    title: '撰写 PRD 与验收标准',
    assignee: 'mia',
    assigneeName: 'mia',
    role: '产品经理',
    summary: 'PRD 完成：登录、角色矩阵、审计三类验收标准已固化（模拟）。',
  },
  {
    id: 'sim_plan',
    title: '排期与跨角色依赖梳理',
    assignee: 'leo',
    assigneeName: 'leo',
    role: '项目经理',
    summary: '排期完成：后端 API → 前端联调 → 测试回归（模拟）。',
    handoffTo: 'kai',
    handoffNote: '请后端按里程碑先交付 /auth 与 /rbac 契约',
  },
  {
    id: 'sim_be',
    title: '实现登录与权限 API',
    assignee: 'kai',
    assigneeName: 'kai',
    role: '后端研发',
    summary: '后端完成：/auth/login、/rbac/roles、审计写入接口已就绪（模拟）。',
    handoffTo: 'nina',
    handoffNote: '接口契约已冻结，请前端对接联调',
  },
  {
    id: 'sim_fe',
    title: '实现登录页与权限管理 UI',
    assignee: 'nina',
    assigneeName: 'nina',
    role: '前端研发',
    summary: '前端完成：登录页、角色配置页联调通过（模拟）。',
    handoffTo: 'sam',
    handoffNote: '关键路径可测，请开始回归',
  },
  {
    id: 'sim_qa',
    title: '编写用例并回归验收',
    assignee: 'sam',
    assigneeName: 'sam',
    role: '测试工程师',
    summary: '测试完成：12 条用例全绿，出具验收报告（模拟）。',
    handoffTo: 'mia',
    handoffNote: '验收报告已提交，请产品终审汇总',
  },
]

/** Simulate is ON unless explicitly disabled — demos must not burn tokens. */
export function isCollabSimulateEnabled(override?: boolean): boolean {
  if (typeof override === 'boolean') return override
  // Studio (nodemon) does not load Hermes `~/.hermes/.env` into process.env, so
  // also read the file when the process var is unset — otherwise flipping the
  // .env key appears to do nothing.
  const fromProcess = process.env.HERMES_COLLAB_SIMULATE
  const raw = String(
    (fromProcess !== undefined && String(fromProcess).trim() !== ''
      ? fromProcess
      : readHermesEnvValue('HERMES_COLLAB_SIMULATE')) ?? '1',
  ).trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'live')
}

/** Best-effort parse of Hermes `.env` for one key. */
export function readHermesEnvValue(key: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os')
    const candidates = [
      process.env.HERMES_HOME,
      process.env.HOME,
      detectHermesRootHome(),
      os.homedir(),
    ]
      .map(value => String(value || '').trim())
      .filter(Boolean)

    const seen = new Set<string>()
    for (const home of candidates) {
      if (seen.has(home)) continue
      seen.add(home)
      const envPath = `${home.replace(/\/+$/, '')}/.env`
      if (!fs.existsSync(envPath)) continue
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) continue
        if (trimmed.slice(0, eq).trim() !== key) continue
        let value = trimmed.slice(eq + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"'))
          || (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        return value
      }
    }
  } catch {
    // Ignore unreadable .env — fall through to default.
  }
  return undefined
}

export function isSimulateTenant(tenant: string | null | undefined): boolean {
  return typeof tenant === 'string' && tenant.startsWith('collab-sim-')
}

function inferRole(agent: SimulateAgent): { role: string; title: string; summary: string } {
  const blob = `${agent.profile} ${agent.name} ${agent.description || ''}`
  for (const hint of ROLE_HINTS) {
    if (hint.match.test(blob)) {
      return { role: hint.role, title: hint.title, summary: hint.summary }
    }
  }
  return {
    role: '协作成员',
    title: `推进：${agent.name || agent.profile}`,
    summary: `${agent.name || agent.profile} 已完成分派工作（模拟）。`,
  }
}

/**
 * Build a fan-out plan from room agents when possible; otherwise the fixed
 * 研发团队 demo roster (mia/leo/kai/nina/sam).
 */
export function buildSimulatePlan(
  goal: string,
  coordinator: string,
  agents: SimulateAgent[] = [],
): SimulatePlan {
  const rootId = 'sim_root'
  const rootTitle = goal.replace(/\s+/g, ' ').trim().slice(0, 180) || '协作目标'

  const others = agents.filter(
    agent => agent.profile !== coordinator && agent.name !== coordinator,
  )

  let children: SimulateChildPlan[]
  if (others.length >= 2) {
    children = others.slice(0, 5).map((agent, index) => {
      const inferred = inferRole(agent)
      const next = others[index + 1]
      return {
        id: `sim_c${index + 1}`,
        title: inferred.title,
        assignee: agent.profile || agent.name,
        assigneeName: agent.name || agent.profile,
        role: inferred.role,
        summary: inferred.summary,
        ...(next
          ? {
              handoffTo: next.profile || next.name,
              handoffNote: `请继续推进「${inferRole(next).title}」`,
            }
          : {
              handoffTo: coordinator,
              handoffNote: '本切片已完成，请协调者汇总验收',
            }),
      }
    })
  } else {
    // Prefer the canned 研发团队 plan; remap coordinator name onto the PRD card.
    children = DEFAULT_DEV_TEAM.map(child => {
      if (child.assignee === 'mia' || child.role === '产品经理') {
        return {
          ...child,
          assignee: coordinator,
          assigneeName: coordinator,
        }
      }
      return { ...child }
    })
  }

  const chain: SimulatePlan['chain'] = [
    { from: coordinator, to: children[0]?.assignee || coordinator, action: '拆解目标并创建子任务' },
  ]
  for (const child of children) {
    chain.push({
      from: coordinator,
      to: child.assignee,
      action: `分派「${child.title}」给 ${child.role}`,
    })
    if (child.handoffTo) {
      chain.push({
        from: child.assignee,
        to: child.handoffTo,
        action: child.handoffNote || '交接下游',
      })
    }
  }
  chain.push({
    from: coordinator,
    to: coordinator,
    action: '汇总各角色交付并完成验收',
  })

  return { rootId, rootTitle, children, chain }
}

export function formatThinkingMessage(coordinator: string, goal: string, plan: SimulatePlan): string {
  const lines = [
    `【模拟 · 零 Token】我是协调者 **${coordinator}**，已收到目标：`,
    `> ${goal}`,
    '',
    '正在思考拆解方式（不调用真实模型）：',
    '1. 识别需要的角色与交付物',
    '2. 保持跨角色任务并行，避免「分派空任务」',
    '3. 用调用链把依赖说清楚，最后由我汇总验收',
    '',
    `计划拆成 **${plan.children.length}** 个子任务：`,
    ...plan.children.map(
      (child, i) => `${i + 1}. **@${child.assigneeName}**（${child.role}）← ${child.title}`,
    ),
  ]
  return lines.join('\n')
}

export function formatAssignMessage(coordinator: string, child: SimulateChildPlan): string {
  return [
    `【模拟】协调者 **${coordinator}** 正在调用 **@${child.assigneeName}**`,
    '',
    `- 动作：分派子任务`,
    `- 任务：${child.title}`,
    `- 角色：${child.role}`,
    child.handoffTo
      ? `- 预期下游：完成后由 @${child.handoffTo} 接续（${child.handoffNote || '交接'}）`
      : '',
  ].filter(Boolean).join('\n')
}

export function formatWorkerStartMessage(child: SimulateChildPlan): string {
  return [
    `【模拟】**@${child.assigneeName}** 已接单，开始执行「${child.title}」。`,
    '（本段为演示文案，未启动真实 worker / 未消耗 token）',
  ].join('\n')
}

export function formatHandoffMessage(child: SimulateChildPlan): string | null {
  if (!child.handoffTo) return null
  return [
    `【模拟】**@${child.assigneeName}** → 调用 **@${child.handoffTo}**`,
    '',
    `- 动作：任务交接 / 依赖通知`,
    `- 说明：${child.handoffNote || '请继续推进下游切片'}`,
  ].join('\n')
}

export function formatWorkerDoneMessage(child: SimulateChildPlan): string {
  return [
    `【模拟】**@${child.assigneeName}** 完成「${child.title}」`,
    '',
    `结果摘要：${child.summary}`,
  ].join('\n')
}

export function formatSummaryMessage(
  coordinator: string,
  goal: string,
  plan: SimulatePlan,
): string {
  const lines = [
    `【模拟 · 汇总】协调者 **${coordinator}** 正在收口验收。`,
    '',
    `目标：${goal}`,
    '',
    '本次调用链（文字复盘）：',
    ...plan.chain.map((step, i) => `${i + 1}. @${step.from} → @${step.to}：${step.action}`),
    '',
    '各角色交付：',
    ...plan.children.map(child => `- @${child.assigneeName}：${child.summary}`),
    '',
    '✅ 模拟协作完成。若要真实跑通（会消耗 token），请在 Hermes 的 `.env`（如 `/opt/data/.env`）设置 `HERMES_COLLAB_SIMULATE=0`，保存后重新发起一次协作即可。',
  ]
  return lines.join('\n')
}

// ─── Live (real Kanban / LLM) narrative — template text, no extra LLM ───

export interface LiveNarrativeChild {
  id: string
  title: string
  assignee: string
  summary?: string
}

/** Coordinator acknowledges the goal before the decomposer LLM runs. */
export function formatLiveThinkingMessage(coordinator: string, goal: string): string {
  return [
    `【协作】我是协调者 **${coordinator}**，已收到目标：`,
    `> ${goal}`,
    '',
    '正在思考如何拆解（将调用看板拆解器 / 模型）：',
    '1. 识别需要的角色与可交付切片',
    '2. 子任务尽量并行，避免「只分派不干活」的空任务',
    '3. 各角色交付后由我汇总验收',
    '',
    '下一步：创建根任务 → 拆解子任务 → 分派给各 profile。',
  ].join('\n')
}

export function formatLiveDecomposingMessage(coordinator: string): string {
  return `【协作】协调者 **${coordinator}** 正在拆解子任务（\`kanban decompose\`），请稍候…`
}

export function formatLiveFanoutMessage(
  coordinator: string,
  children: LiveNarrativeChild[],
): string {
  if (children.length === 0) {
    return `【协作】协调者 **${coordinator}** 决定不分拆，由本人直接推进该目标。`
  }
  return [
    `【协作】协调者 **${coordinator}** 拆解完成，开始分派：`,
    '',
    ...children.map(
      (child, i) => `${i + 1}. 调用 **@${child.assignee || '未分派'}** ← ${child.title}`,
    ),
    '',
    '调度器将并行认领就绪任务；下方会持续播报各 profile 的接单 / 交接 / 完成。',
  ].join('\n')
}

export function formatLiveAssignMessage(
  coordinator: string,
  child: LiveNarrativeChild,
): string {
  return [
    `【协作】协调者 **${coordinator}** → 调用 **@${child.assignee || '未分派'}**`,
    '',
    `- 动作：分派子任务`,
    `- 任务：${child.title}`,
  ].join('\n')
}

export function formatLiveWorkerStartMessage(child: LiveNarrativeChild): string {
  return `【协作】**@${child.assignee || 'worker'}** 已接单，开始执行「${child.title}」。`
}

export function formatLiveHandoffMessage(
  from: LiveNarrativeChild,
  to: LiveNarrativeChild,
): string {
  return [
    `【协作】**@${from.assignee || 'upstream'}** → 调用 **@${to.assignee || 'downstream'}**`,
    '',
    `- 动作：上游完成，通知下游继续`,
    `- 已完成：${from.title}`,
    `- 请继续：${to.title}`,
  ].join('\n')
}

export function formatLiveWorkerDoneMessage(child: LiveNarrativeChild): string {
  const summary = String(child.summary || '').trim()
  return [
    `【协作】**@${child.assignee || 'worker'}** 完成「${child.title}」`,
    '',
    summary ? `结果摘要：${summary}` : '（暂无结构化摘要，可在看板展开执行日志查看）',
  ].join('\n')
}

export function formatLiveBlockedMessage(child: LiveNarrativeChild, reason: string): string {
  return [
    `【协作】**@${child.assignee || 'worker'}** 在「${child.title}」上阻塞`,
    '',
    reason ? `原因：${reason}` : '需要人工介入后才能继续。',
  ].join('\n')
}

export function formatLiveSummaryMessage(
  coordinator: string,
  goal: string,
  children: LiveNarrativeChild[],
  chain: Array<{ from: string; to: string; action: string }>,
): string {
  return [
    `【协作 · 汇总】协调者 **${coordinator}** 收口验收。`,
    '',
    `目标：${goal}`,
    '',
    '本次调用链（根据看板复盘）：',
    ...(chain.length
      ? chain.map((step, i) => `${i + 1}. @${step.from} → @${step.to}：${step.action}`)
      : ['（尚无完整调用链记录）']),
    '',
    '各角色交付：',
    ...(children.length
      ? children.map(child => `- @${child.assignee || '-'}：${child.summary || child.title}`)
      : ['（无子任务）']),
    '',
    '✅ 协作流程已结束。',
  ].join('\n')
}

/** Infer a readable call chain from child completion order. */
export function buildLiveCallChain(
  coordinator: string,
  children: LiveNarrativeChild[],
): Array<{ from: string; to: string; action: string }> {
  const chain: Array<{ from: string; to: string; action: string }> = [
    { from: coordinator, to: coordinator, action: '拆解目标并创建子任务' },
  ]
  for (const child of children) {
    chain.push({
      from: coordinator,
      to: child.assignee || coordinator,
      action: `分派「${child.title}」`,
    })
  }
  for (let i = 0; i < children.length - 1; i += 1) {
    const from = children[i]
    const to = children[i + 1]
    if (!from.assignee || !to.assignee || from.assignee === to.assignee) continue
    chain.push({
      from: from.assignee,
      to: to.assignee,
      action: `交接：${from.title} → ${to.title}`,
    })
  }
  chain.push({
    from: coordinator,
    to: coordinator,
    action: '汇总各角色交付并完成验收',
  })
  return chain
}

/** Default pacing — fast enough to watch, slow enough to read. */
export const SIMULATE_PACE_MS = {
  thinking: 600,
  afterPlan: 900,
  betweenAssign: 700,
  workTick: 900,
  handoff: 500,
  summary: 800,
} as const
