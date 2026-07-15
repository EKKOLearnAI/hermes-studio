const en = {
  title: 'Commerce Command Center', subtitle: 'Compare, approve, and verify purchases through one governed transaction loop.',
  refresh: 'Refresh', adminBoundary: 'Account authority, activation, revocation, and workflow approval require a super administrator.',
  common: { cancel: 'Cancel' },
  status: { kicker: 'Commerce autonomy', title: 'Provider and execution readiness', ready: 'Runtime ready',
    unavailable: 'Runtime unavailable', stopped: 'Emergency stopped', accounts: 'Accounts', live: 'Live accounts',
    offers: 'Active offers', transactions: 'Active transactions', takeovers: 'Takeovers', noAccounts: 'No commerce accounts are configured.' },
  mode: { observe: 'Observe', shadow: 'Shadow', live: 'Live' },
  health: { unknown: 'Unknown', healthy: 'Healthy', degraded: 'Degraded', unhealthy: 'Unhealthy', revoked: 'Revoked' },
  plan: { title: 'Offer to order', summary: 'Build immutable comparison, cart, and quote material before any order.',
    query: 'Product query', quantity: 'Quantity', max: 'Maximum total (minor units)', search: 'Search offers',
    compare: 'Compare', noOffers: 'No normalized offers yet.', selected: 'Selected offer:', noneEligible: 'No eligible offer',
    destination: 'Destination token', recipient: 'Recipient token', substitution: 'Substitution', deny: 'Deny',
    sameSku: 'Same SKU only', cart: 'Prepare cart', quote: 'Refresh quote', order: 'Review order' },
  confirm: { title: 'Confirm exact order', summary: 'Review the immutable commercial material that Action Fabric will govern.',
    provider: 'Provider', merchant: 'Merchant', item: 'Item', destination: 'Destination digest', substitution: 'Substitution',
    expires: 'Quote expires', total: 'Exact total', liveWarning: 'This is a live external order. Approval may create a real obligation.',
    shadowWarning: 'This order remains in the deterministic shadow provider.', submit: 'Submit exact order' },
  transaction: { title: 'Transaction and fulfillment', summary: 'Verified order, payment, delivery, cancellation, and refund states.',
    empty: 'No commerce transactions yet.', select: 'Select a transaction to inspect its timeline.', state: 'State',
    amount: 'Amount', mode: 'Mode', policyEpoch: 'Policy epoch', noTimeline: 'No verified checkpoints yet.',
    approval: 'Fresh approval ID', pay: 'Review payment', track: 'Track delivery', reason: 'Reason code',
    cancelOrder: 'Cancel order', refundAmount: 'Refund (minor units)', refund: 'Request refund' },
  payment: { title: 'Confirm exact payment', summary: 'Payment is bound to this order, quote digest, amount, and fresh approval.',
    order: 'Provider order', amount: 'Exact amount', approval: 'Approval ID',
    warning: 'Submitting may charge the configured provider payment method. Credentials remain outside Studio.', submit: 'Submit payment' },
  governance: { title: 'Authority and recovery', summary: 'Activation gates, workflow approval, takeovers, and irreversible revocation.',
    nextMode: 'Next mode', perAction: 'Per action (minor units)', daily: 'Daily (minor units)', merchants: 'Allowed merchant IDs',
    destinations: 'Allowed destination digests', activate: 'Review activation', markHealthy: 'Mark healthy', revoke: 'Revoke account',
    boundary: 'Studio never accepts provider credentials, payment credentials, raw browser primitives, or full addresses.',
    approved: 'approved', denied: 'denied', workflows: 'Governed workflows', takeovers: 'Human takeovers', approve: 'Approve',
    reject: 'Reject', noWorkflows: 'No recent commerce workflows.', noTakeovers: 'No active takeover is required.',
    takeoverPrivacy: 'Complete the challenge in the governed provider surface; secrets never enter Studio.',
    confirmTitle: 'Confirm account authority change', confirmSummary: 'Mode and spending limits change the assistant authority boundary.',
    confirm: 'Apply authority change' },
  workflowState: { draft: 'Draft', policy_check: 'Policy check', preparing: 'Preparing', executing: 'Executing',
    verifying: 'Verifying', waiting_user: 'Waiting for you', retrying: 'Retrying', compensating: 'Compensating',
    succeeded: 'Succeeded', denied: 'Denied', cancelled: 'Cancelled', failed: 'Failed', dead_letter: 'Needs review', compensated: 'Compensated' },
  transactionState: { proposed: 'Proposed', quoted: 'Quoted', waiting_approval: 'Waiting approval',
    submitting_order: 'Submitting order', lookup_required: 'Lookup required', order_pending: 'Order pending',
    waiting_payment: 'Waiting payment', submitting_payment: 'Submitting payment', paid: 'Paid', fulfilling: 'Fulfilling',
    delivered: 'Delivered', cancelling: 'Cancelling', cancelled: 'Cancelled', refunding: 'Refunding', refunded: 'Refunded',
    waiting_user: 'Waiting for you', failed: 'Failed' },
  errors: { load: 'Failed to load Commerce Command Center', action: 'Commerce action failed',
    transaction: 'Failed to load transaction', workflow: 'Workflow review failed', activation: 'Account authority change failed' },
  success: { queued: 'Commerce action entered the governed workflow', reviewed: 'Workflow review recorded',
    activated: 'Account authority updated', revoked: 'Commerce account permanently revoked' },
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
  title: '商业自治中心', subtitle: '通过统一受治理交易闭环完成比价、审批、购买与履约验证。', refresh: '刷新',
  adminBoundary: '账户权限、模式激活、撤销与工作流审批需要超级管理员。', common: { cancel: '取消' },
  status: { kicker: '商业自治', title: 'Provider 与执行就绪状态', ready: '运行时已就绪', unavailable: '运行时不可用',
    stopped: '已紧急停止', accounts: '账户', live: 'Live 账户', offers: '有效 Offer', transactions: '活动交易',
    takeovers: '人工接管', noAccounts: '尚未配置商业账户。' },
  mode: { observe: '观察', shadow: '影子', live: '真实' },
  health: { unknown: '未知', healthy: '健康', degraded: '降级', unhealthy: '异常', revoked: '已撤销' },
  plan: { title: '从 Offer 到订单', summary: '任何下单前先固化比价、购物车与报价材料。', query: '商品需求', quantity: '数量',
    max: '最高总额（最小货币单位）', search: '搜索 Offer', compare: '比价', noOffers: '尚无标准化 Offer。', selected: '已选 Offer：',
    noneEligible: '没有符合条件的 Offer', destination: '配送目标令牌', recipient: '收件人令牌', substitution: '替换规则',
    deny: '禁止替换', sameSku: '仅同 SKU', cart: '准备购物车', quote: '刷新报价', order: '复核订单' },
  confirm: { title: '确认精确订单', summary: '复核即将交给 Action Fabric 治理的不可变商业材料。', provider: 'Provider',
    merchant: '商家', item: '商品', destination: '配送目标摘要', substitution: '替换规则', expires: '报价过期时间',
    total: '精确总额', liveWarning: '这是 Live 外部订单，批准后可能产生真实交易义务。',
    shadowWarning: '该订单仍在确定性影子 Provider 中执行。', submit: '提交精确订单' },
  transaction: { title: '交易与履约', summary: '订单、支付、配送、取消与退款的已验证状态。', empty: '尚无商业交易。',
    select: '选择一笔交易查看时间线。', state: '状态', amount: '金额', mode: '模式', policyEpoch: '策略纪元',
    noTimeline: '尚无已验证检查点。', approval: '新鲜审批 ID', pay: '复核支付', track: '跟踪配送', reason: '原因代码',
    cancelOrder: '取消订单', refundAmount: '退款金额（最小货币单位）', refund: '申请退款' },
  payment: { title: '确认精确支付', summary: '支付绑定到本订单、报价摘要、金额和新鲜审批。', order: 'Provider 订单',
    amount: '精确金额', approval: '审批 ID', warning: '提交后可能从 Provider 配置的支付方式扣款；支付凭据始终不进入 Studio。', submit: '提交支付' },
  governance: { title: '权限与恢复', summary: '激活门禁、工作流审批、人工接管与不可逆撤销。', nextMode: '目标模式',
    perAction: '单次限额（最小货币单位）', daily: '每日限额（最小货币单位）', merchants: '允许的商家 ID',
    destinations: '允许的配送目标摘要', activate: '复核激活', markHealthy: '标记健康', revoke: '撤销账户',
    boundary: 'Studio 不接收 Provider 凭据、支付凭据、原始浏览器控制或完整地址。', approved: '已批准', denied: '已拒绝',
    workflows: '受治理工作流', takeovers: '人工接管', approve: '批准', reject: '拒绝', noWorkflows: '暂无商业工作流。',
    noTakeovers: '当前无需人工接管。', takeoverPrivacy: '请在受治理 Provider 界面完成挑战，秘密不会进入 Studio。',
    confirmTitle: '确认账户权限变更', confirmSummary: '模式和消费限额会改变助手的权限边界。', confirm: '应用权限变更' },
  errors: { load: '商业自治中心加载失败', action: '商业动作执行失败', transaction: '交易加载失败', workflow: '工作流审批失败', activation: '账户权限变更失败' },
  success: { queued: '商业动作已进入受治理工作流', reviewed: '工作流审批已记录', activated: '账户权限已更新', revoked: '商业账户已永久撤销' },
})

const zhTW = merge(zh, { title: '商業自治中心', subtitle: '透過統一受治理交易閉環完成比價、審批、購買與履約驗證。', refresh: '重新整理' })
const ja = merge(en, { title: 'コマース自治センター', subtitle: '比較、承認、購入、配送確認を管理された取引ループで実行します。', refresh: '更新' })
const ko = merge(en, { title: '커머스 자율 센터', subtitle: '비교, 승인, 구매 및 이행 검증을 하나의 관리형 거래 루프로 수행합니다.', refresh: '새로 고침' })
const fr = merge(en, { title: 'Centre d’autonomie commerciale', subtitle: 'Comparez, approuvez et vérifiez les achats dans une boucle de transaction gouvernée.', refresh: 'Actualiser' })
const es = merge(en, { title: 'Centro de autonomía comercial', subtitle: 'Compara, aprueba y verifica compras mediante un ciclo de transacción gobernado.', refresh: 'Actualizar' })
const de = merge(en, { title: 'Commerce-Autonomiezentrum', subtitle: 'Käufe in einem gesteuerten Transaktionskreislauf vergleichen, genehmigen und verifizieren.', refresh: 'Aktualisieren' })
const pt = merge(en, { title: 'Central de autonomia comercial', subtitle: 'Compare, aprove e verifique compras em um ciclo de transação governado.', refresh: 'Atualizar' })
const ru = merge(en, { title: 'Центр торговой автономии', subtitle: 'Сравнение, подтверждение и проверка покупок в управляемом контуре транзакции.', refresh: 'Обновить' })

export const commerceMessages: Record<string, Messages> = { en, zh, 'zh-TW': zhTW, ja, ko, fr, es, de, pt, ru }
export const commerceSystemMessages = {
  en: { title: 'Commerce', summary: 'Governed offer comparison, purchasing, payment, delivery, cancellation, and refund.' },
  zh: { title: '商业自治', summary: '受治理的 Offer 比较、购买、支付、配送、取消与退款。' },
  'zh-TW': { title: '商業自治', summary: '受治理的 Offer 比較、購買、支付、配送、取消與退款。' },
  ja: { title: 'コマース', summary: '管理された比較、購入、支払い、配送、取消、返金。' },
  ko: { title: '커머스', summary: '관리형 비교, 구매, 결제, 배송, 취소 및 환불.' },
  fr: { title: 'Commerce', summary: 'Comparaison, achat, paiement, livraison, annulation et remboursement gouvernés.' },
  es: { title: 'Comercio', summary: 'Comparación, compra, pago, entrega, cancelación y reembolso gobernados.' },
  de: { title: 'Commerce', summary: 'Gesteuerter Vergleich, Kauf, Zahlung, Lieferung, Stornierung und Erstattung.' },
  pt: { title: 'Comércio', summary: 'Comparação, compra, pagamento, entrega, cancelamento e reembolso governados.' },
  ru: { title: 'Торговля', summary: 'Управляемое сравнение, покупка, оплата, доставка, отмена и возврат.' },
}
