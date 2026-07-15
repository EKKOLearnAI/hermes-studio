import { computed } from 'vue'
import type { Ref } from 'vue'

const en = {
  actionFabric: 'Action Fabric', banner: 'Internal and external executors share one server-owned policy, authorization, verification, emergency-control, and sanitized-audit boundary.',
  actionCenter: 'Action Center', capabilities: 'Capabilities and authorization', emergencyStop: 'Emergency stop',
  refresh: 'Retry authoritative load', loading: 'Loading Action Fabric…', empty: 'No action workflows yet.',
  refreshWarning: 'Some authoritative data could not be refreshed. Retry the affected load; do not replay the action.',
  degraded: 'Action Fabric data is degraded.', staleSelection: 'The selected workflow is no longer available. Close this detail and retry the list.',
  running: 'Running', waiting: 'Waiting for review', failed: 'Failed / recoverable', reversible: 'Reversible', completed: 'Completed',
  viewDetails: 'View workflow details', workflow: 'Workflow', role: 'Role', capability: 'Capability', state: 'State',
  policyReasons: 'Policy reasons', sanitizedSummary: 'Sanitized summary', steps: 'Sanitized steps and evidence', evidence: 'Evidence',
  retryHistory: 'Retry history', auditReferences: 'Audit references', compensationEligible: 'Compensation eligible',
  compensationUnavailable: 'Compensation unavailable', reason: 'Reason', approve: 'Approve', reject: 'Reject', retry: 'Retry',
  cancel: 'Cancel', compensate: 'Compensate', close: 'Close', confirmTitle: 'Confirm Action Fabric operation',
  confirmAction: 'Confirm operation for workflow', noPolicy: 'No policy decision is attached.', noSteps: 'No persisted steps.',
  noAudit: 'No audit references loaded.', attempt: 'Attempt', lastError: 'Last error', retryAt: 'Retry at',
  executor: 'Executor', executors: 'Executor registry', risk: 'Risk', environment: 'Environment', health: 'Health',
  executorBoundary: 'External executors use profile-scoped runtimes, governed browser sessions, or encrypted paired devices. Action Fabric still owns target authorization and result verification.',
  simulatorExecutor: 'Simulator · no external effect', internalExecutor: 'Internal · Hermes-owned',
  connectorExecutor: 'Connector · external integration', mcpExecutor: 'MCP · profile runtime', browserExecutor: 'Browser · governed session',
  androidExecutor: 'Android · encrypted companion',
  idempotency: 'Idempotency', reversibleLabel: 'Reversible', verification: 'Verification', enabled: 'Enabled', disabled: 'Disabled',
  roleAuthorization: 'Role authorization declarations', allowDeclaration: 'Allowed declaration', denyDeclaration: 'Denied declaration',
  notDeclared: 'Not declared', noCapabilities: 'No capabilities returned by the server.', noExecutors: 'No executors returned by the server.',
  noRoles: 'No Assistant Roles returned by the server.', currentControl: 'Current control', version: 'Version', lastUpdated: 'Last updated',
  level0: 'Level 0 — Normal operation', level0Description: 'New and active permitted actions may proceed.',
  level1: 'Level 1 — Pause new actions', level1Description: 'Reject new intents while leaving active work unchanged.',
  level2: 'Level 2 — Stop interruptible work', level2Description: 'Also interrupt work whose executor declares safe interruption.',
  level3: 'Level 3 — Disable external writes', level3Description: 'Also disable future external-write executors and invoke the revocation boundary.',
  chooseLevel: 'Emergency stop level', controlReason: 'Control change reason', applyControl: 'Apply emergency stop level',
  reasonRequired: 'A reason is required before changing the emergency stop level.', confirmControl: 'Confirm emergency stop change',
  saving: 'Saving authoritative change…', updated: 'Authoritative server state reloaded.', yes: 'Yes', no: 'No',
} as const

type Messages = { [K in keyof typeof en]: string }
const zh: Messages = {
  actionFabric: '行动编排', banner: '内部与外部执行器统一受服务端策略、授权、验证、紧急控制和脱敏审计边界约束。', actionCenter: '行动中心', capabilities: '能力与授权', emergencyStop: '紧急停止',
  refresh: '重试权威数据加载', loading: '正在加载行动编排…', empty: '暂无行动工作流。', refreshWarning: '部分权威数据刷新失败。请仅重试对应的读取，不要重放操作。', degraded: '行动编排数据已降级。', staleSelection: '所选工作流已不可用。请关闭详情并重试列表。',
  running: '运行中', waiting: '等待审核', failed: '失败 / 可恢复', reversible: '可补偿', completed: '已完成', viewDetails: '查看工作流详情', workflow: '工作流', role: '角色', capability: '能力', state: '状态', policyReasons: '策略原因', sanitizedSummary: '已清理摘要', steps: '已清理步骤与证据', evidence: '证据', retryHistory: '重试历史', auditReferences: '审计引用', compensationEligible: '可执行补偿', compensationUnavailable: '不可执行补偿', reason: '原因', approve: '批准', reject: '拒绝', retry: '重试', cancel: '取消', compensate: '补偿', close: '关闭', confirmTitle: '确认行动编排操作', confirmAction: '确认工作流操作', noPolicy: '没有关联的策略决策。', noSteps: '没有持久化步骤。', noAudit: '尚未加载审计引用。', attempt: '尝试', lastError: '最近错误', retryAt: '重试时间',
  executor: '执行器', executors: '执行器注册表', risk: '风险', environment: '环境', health: '健康', executorBoundary: '外部执行器使用 Profile 范围运行时、受治理浏览器会话或加密配对设备；目标授权和结果验证仍由 Action Fabric 负责。', simulatorExecutor: '模拟器 · 无外部影响', internalExecutor: '内部 · Hermes 持有', connectorExecutor: '连接器 · 外部集成', mcpExecutor: 'MCP · Profile 运行时', browserExecutor: '浏览器 · 受治理会话', androidExecutor: 'Android · 加密 Companion', idempotency: '幂等性', reversibleLabel: '可逆', verification: '验证', enabled: '已启用', disabled: '已停用', roleAuthorization: '角色授权声明', allowDeclaration: '允许声明', denyDeclaration: '拒绝声明', notDeclared: '未声明', noCapabilities: '服务端未返回能力。', noExecutors: '服务端未返回执行器。', noRoles: '服务端未返回助手角色。',
  currentControl: '当前控制', version: '版本', lastUpdated: '最后更新', level0: '级别 0 — 正常运行', level0Description: '允许的新行动与活动行动可以继续。', level1: '级别 1 — 暂停新行动', level1Description: '拒绝新意图，现有活动工作保持不变。', level2: '级别 2 — 停止可中断工作', level2Description: '同时中断执行器声明可安全中断的工作。', level3: '级别 3 — 禁用外部写入', level3Description: '同时禁用未来的外部写入执行器并调用撤销边界。', chooseLevel: '紧急停止级别', controlReason: '控制变更原因', applyControl: '应用紧急停止级别', reasonRequired: '更改紧急停止级别前必须填写原因。', confirmControl: '确认紧急停止变更', saving: '正在保存权威变更…', updated: '已重新加载服务端权威状态。', yes: '是', no: '否',
}

export function useActionFabricMessages(locale: Ref<unknown>) {
  const messages = computed<Messages>(() => String(locale.value).toLowerCase().startsWith('zh') ? zh : en)
  return { messages }
}
