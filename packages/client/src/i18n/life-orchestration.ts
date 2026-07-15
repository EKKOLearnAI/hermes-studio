const en = {
  title: 'Life & Leisure', subtitle: 'Turn commitments, wellbeing, budget, and preferences into one governed leisure plan.',
  refresh: 'Refresh', adminBoundary: 'Source authority, activation, revocation, and workflow approval require a super administrator.',
  common: { back: 'Back' }, mode: { observe: 'Observe', shadow: 'Shadow', live: 'Live' },
  health: { unknown: 'Unknown', healthy: 'Healthy', degraded: 'Degraded', unhealthy: 'Unhealthy', revoked: 'Revoked' },
  today: { kicker: 'Personal orchestration', title: 'Today', stopped: 'Emergency stopped', ready: 'Governed runtime',
    sources: 'Sources', plans: 'Active plans', commitments: 'Commitments', takeovers: 'Takeovers',
    schedule: 'Commitments', emptySchedule: 'No observed commitments.', activePlans: 'Leisure plans',
    emptyPlans: 'No plan has been generated.', sessions: 'sessions', holds: 'Active calendar holds' },
  sources: { title: 'Sources', summary: 'Observe semantic calendar, contact, travel, music, game, and subscription data.',
    empty: 'No life source is configured.', sync: 'Sync one page', health: 'Set health', currency: 'Currency',
    subscriptionIds: 'Exact subscription IDs, comma separated', activate: 'Review activation', revoke: 'Revoke',
    confirmTitle: 'Confirm source authority', exactTargets: 'Exact writable targets',
    activationWarning: 'Live mode may create calendar holds or cancel only the explicitly listed subscriptions.',
    confirm: 'Apply authority change', add: 'Add source', id: 'Semantic source ID', name: 'Display name',
    boundary: 'Credentials, raw contact channels, provider item IDs, cookies, and provider payloads never enter Studio.',
    approved: 'approved', denied: 'denied' },
  planner: { title: 'Planner', summary: 'Freeze deterministic constraints before scoring or scheduling leisure options.',
    freeze: 'Freeze constraints', currency: 'Currency', budget: 'Budget (minor units)', screen: 'Screen minutes',
    leisure: 'Leisure minutes', radius: 'Travel radius (km)', preferences: 'Preferred categories', noPlan: 'No plan',
    generate: 'Generate plan', verify: 'Verify material', materialChanged: 'Material changed after this plan was frozen. Regenerate before creating a calendar hold.',
    planDigest: 'Plan', constraintDigest: 'Constraints', minutes: 'minutes', sessions: 'sessions', session: 'Exact session',
    calendar: 'Calendar target', hold: 'Review calendar hold', empty: 'Freeze constraints and generate a plan to begin.',
    confirmTitle: 'Confirm exact calendar hold', option: 'Option', window: 'Exact window', cost: 'Exact cost',
    holdWarning: 'Submitting enters Action Fabric approval. Live mode may write this exact window to the selected calendar.',
    confirmHold: 'Submit exact hold' },
  library: { title: 'Library', summary: 'Normalized leisure options and privacy-preserving contact aliases.',
    empty: 'No current leisure options.', contacts: 'Contact aliases', handoffs: 'Cross-domain proposals' },
  subscriptions: { title: 'Subscriptions', summary: 'Review normalized recurring commitments and eligible cancellations.',
    renews: 'Renews', cancel: 'Review cancellation', empty: 'No observed subscriptions.',
    confirmTitle: 'Confirm exact subscription cancellation', service: 'Service and plan', cost: 'Recurring cost',
    deadline: 'Cancellation deadline', sourceDigest: 'Observed material', reason: 'Reason code',
    warning: 'Submitting enters Action Fabric approval. Live mode may cancel this exact subscription.',
    confirm: 'Submit cancellation', history: 'Cancellation history' },
  workflow: { title: 'Workflow & recovery', summary: 'Approvals, verification, takeovers, retries, and calendar recovery remain in Action Fabric.',
    takeovers: 'Human takeovers', review: 'Review', takeoverPrivacy: 'Complete provider challenges outside Studio; never paste credentials here.',
    empty: 'No recent life workflows.', reason: 'Rejection reason', approve: 'Approve', reject: 'Reject',
    holds: 'Calendar holds', cancelHold: 'Cancel exact hold' },
  workflowState: { draft: 'Draft', policy_check: 'Policy check', preparing: 'Preparing', executing: 'Executing',
    verifying: 'Verifying', waiting_user: 'Waiting for you', retrying: 'Retrying', compensating: 'Compensating',
    succeeded: 'Succeeded', denied: 'Denied', cancelled: 'Cancelled', failed: 'Failed', dead_letter: 'Needs review', compensated: 'Compensated' },
  errors: { load: 'Failed to load Life & Leisure', action: 'Life action failed', authority: 'Source authority change failed',
    plan: 'Constraint or plan operation failed', workflow: 'Workflow review failed' },
  success: { queued: 'Action entered the governed workflow', source: 'Life source created', constraint: 'Constraints frozen',
    plan: 'Deterministic plan generated', reviewed: 'Workflow review recorded', activated: 'Source authority updated',
    revoked: 'Life source permanently revoked' },
}

type Messages = typeof en
type DeepPartial<T> = { [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K] }
function merge<T extends Record<string, any>>(base: T, override: DeepPartial<T>): T {
  const output: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) output[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? merge((base[key] ?? {}) as Record<string, any>, value as Record<string, any>) : value
  return output as T
}

const zh = merge(en, {
  title: '生活与娱乐', subtitle: '把日程、健康、预算和偏好收敛成一个受治理的休闲计划。', refresh: '刷新',
  adminBoundary: '来源权限、激活、撤销与工作流审批需要超级管理员。', common: { back: '返回' },
  mode: { observe: '观察', shadow: '影子', live: '真实' },
  health: { unknown: '未知', healthy: '健康', degraded: '降级', unhealthy: '异常', revoked: '已撤销' },
  today: { kicker: '个人编排', title: '今天', stopped: '已紧急停止', ready: '受治理运行时', sources: '来源', plans: '活动计划',
    commitments: '日程承诺', takeovers: '人工接管', schedule: '日程承诺', emptySchedule: '尚无已观察的日程。', activePlans: '休闲计划',
    emptyPlans: '尚未生成计划。', sessions: '个时段', holds: '活动日历占位' },
  sources: { title: '来源', summary: '观察语义化的日历、联系人、旅行、音乐、游戏和订阅数据。', empty: '尚未配置生活来源。',
    sync: '同步一页', health: '设置健康状态', currency: '币种', subscriptionIds: '精确订阅 ID，用逗号分隔', activate: '复核激活',
    revoke: '撤销', confirmTitle: '确认来源权限', exactTargets: '精确可写目标',
    activationWarning: '真实模式只能创建日历占位，或取消明确列出的订阅。', confirm: '应用权限变更', add: '添加来源', id: '语义来源 ID',
    name: '显示名称', boundary: '凭据、原始联系渠道、Provider 条目 ID、Cookie 与 Provider Payload 永不进入 Studio。', approved: '已批准', denied: '已拒绝' },
  planner: { title: '计划器', summary: '对休闲选项评分或排期前，先固化确定性约束。', freeze: '固化约束', currency: '币种',
    budget: '预算（最小货币单位）', screen: '屏幕时长（分钟）', leisure: '休闲时长（分钟）', radius: '出行半径（公里）',
    preferences: '偏好类别', noPlan: '无计划', generate: '生成计划', verify: '验证材料',
    materialChanged: '计划固化后材料发生变化；创建日历占位前请重新生成。', planDigest: '计划', constraintDigest: '约束', minutes: '分钟',
    sessions: '个时段', session: '精确时段', calendar: '日历目标', hold: '复核日历占位', empty: '请先固化约束并生成计划。',
    confirmTitle: '确认精确日历占位', option: '选项', window: '精确时间窗', cost: '精确成本',
    holdWarning: '提交后进入 Action Fabric 审批；真实模式可能把该精确时间窗写入所选日历。', confirmHold: '提交精确占位' },
  library: { title: '娱乐库', summary: '标准化休闲选项与隐私保护的联系人别名。', empty: '暂无当前可用选项。', contacts: '联系人别名', handoffs: '跨域提案' },
  subscriptions: { title: '订阅', summary: '复核标准化周期性支出与可取消资格。', renews: '续费', cancel: '复核取消', empty: '尚无已观察订阅。',
    confirmTitle: '确认精确订阅取消', service: '服务与套餐', cost: '周期费用', deadline: '取消截止时间', sourceDigest: '观察材料', reason: '原因代码',
    warning: '提交后进入 Action Fabric 审批；真实模式可能取消该精确订阅。', confirm: '提交取消', history: '取消历史' },
  workflow: { title: '工作流与恢复', summary: '审批、验证、接管、重试与日历恢复统一由 Action Fabric 治理。', takeovers: '人工接管', review: '复核',
    takeoverPrivacy: 'Provider 挑战请在 Studio 外完成，切勿在此粘贴凭据。', empty: '暂无生活工作流。', reason: '拒绝原因', approve: '批准', reject: '拒绝',
    holds: '日历占位', cancelHold: '取消精确占位' },
  errors: { load: '生活与娱乐加载失败', action: '生活动作执行失败', authority: '来源权限变更失败', plan: '约束或计划操作失败', workflow: '工作流审批失败' },
  success: { queued: '动作已进入受治理工作流', source: '生活来源已创建', constraint: '约束已固化', plan: '确定性计划已生成',
    reviewed: '工作流审批已记录', activated: '来源权限已更新', revoked: '生活来源已永久撤销' },
})

const zhTW = merge(zh, { title: '生活與娛樂', subtitle: '把行程、健康、預算與偏好收斂成受治理的休閒計畫。', refresh: '重新整理' })
const ja = merge(en, { title: '生活とレジャー', subtitle: '予定、健康、予算、好みから管理された余暇計画を作成します。', refresh: '更新' })
const ko = merge(en, { title: '생활 및 여가', subtitle: '일정, 건강, 예산, 선호를 관리형 여가 계획으로 구성합니다.', refresh: '새로 고침' })
const fr = merge(en, { title: 'Vie et loisirs', subtitle: 'Transformez engagements, santé, budget et préférences en plan de loisirs gouverné.', refresh: 'Actualiser' })
const es = merge(en, { title: 'Vida y ocio', subtitle: 'Convierte compromisos, bienestar, presupuesto y preferencias en un plan gobernado.', refresh: 'Actualizar' })
const de = merge(en, { title: 'Leben und Freizeit', subtitle: 'Termine, Wohlbefinden, Budget und Vorlieben in einem gesteuerten Freizeitplan.', refresh: 'Aktualisieren' })
const pt = merge(en, { title: 'Vida e lazer', subtitle: 'Converta compromissos, bem-estar, orçamento e preferências em um plano governado.', refresh: 'Atualizar' })
const ru = merge(en, { title: 'Жизнь и досуг', subtitle: 'Объедините планы, здоровье, бюджет и предпочтения в управляемый план досуга.', refresh: 'Обновить' })

export const lifeMessages: Record<string, Messages> = { en, zh, 'zh-TW': zhTW, ja, ko, fr, es, de, pt, ru }
export const lifeSystemMessages = {
  en: { title: 'Life & Leisure', summary: 'Governed commitments, leisure planning, calendar holds, and subscription cancellation.' },
  zh: { title: '生活与娱乐', summary: '受治理的日程、休闲计划、日历占位与订阅取消。' },
  'zh-TW': { title: '生活與娛樂', summary: '受治理的行程、休閒計畫、日曆保留與訂閱取消。' },
  ja: { title: '生活とレジャー', summary: '管理された予定、余暇計画、カレンダー予約、サブスク解約。' },
  ko: { title: '생활 및 여가', summary: '관리형 일정, 여가 계획, 캘린더 예약 및 구독 취소.' },
  fr: { title: 'Vie et loisirs', summary: 'Engagements, loisirs, réservations et résiliations gouvernés.' },
  es: { title: 'Vida y ocio', summary: 'Compromisos, ocio, reservas y cancelaciones gobernados.' },
  de: { title: 'Leben und Freizeit', summary: 'Gesteuerte Termine, Freizeitplanung, Kalender und Kündigungen.' },
  pt: { title: 'Vida e lazer', summary: 'Compromissos, lazer, reservas e cancelamentos governados.' },
  ru: { title: 'Жизнь и досуг', summary: 'Управляемые планы, досуг, календарь и отмена подписок.' },
}
