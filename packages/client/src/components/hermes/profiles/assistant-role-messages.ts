import type { Ref } from 'vue'
import { computed } from 'vue'

const en = {
  runtimeProfiles: 'Runtime Profiles', assistantRoles: 'Assistant Roles', createRole: 'Create role', retry: 'Retry',
  loading: 'Loading assistant roles…', empty: 'No assistant roles yet.', builtIn: 'Built-in', custom: 'Custom', enabled: 'Enabled', disabled: 'Disabled',
  edit: 'Edit', clone: 'Clone', delete: 'Delete', preview: 'Preview context', staleMapping: 'The mapped Runtime Profile is missing. Choose a valid profile before using this role.',
  phase3Warning: 'Capability permissions are declarative until Action Fabric enforcement is enabled in Phase 3.',
  identity: 'Identity and persona', name: 'Name', description: 'Description', persona: 'Persona', memoryNamespace: 'Memory namespace', profileMapping: 'Runtime Profile mapping', noProfile: 'No mapping',
  dataScope: 'Data scope', domains: 'Domains', sections: 'Sections', includeProvenance: 'Include provenance', capability: 'Capability declaration', allow: 'Allowed capabilities (comma separated)', deny: 'Denied capabilities (comma separated)',
  metadata: 'Decision and escalation metadata', decisionAuthority: 'Decision authority (JSON)', spendingLimits: 'Spending limits (JSON)', escalationRules: 'Escalation rules (JSON array)', recipes: 'Context recipes', recipeLimitsNotice: 'Recipes are persisted and used by server context previews.', addRecipe: 'Add recipe', deleteRecipe: 'Delete recipe', recipeNameRequired: 'Every recipe needs a name.', queryTemplate: 'Query template', partialSave: 'Part of the update failed. Authoritative server data has been reloaded.', perSection: 'Items per section', totalCharacters: 'Total characters',
  cancel: 'Cancel', save: 'Save', nameRequired: 'Name is required.', personaRequired: 'Persona is required.', memoryRequired: 'Memory namespace is required.', invalidJson: 'Decision, spending, and escalation metadata must be valid JSON.',
  previewTitle: 'Server context preview', previewEmpty: 'Run a preview to inspect the server context bundle.', rendered: 'Rendered instructions', provenance: 'Provenance', truncated: 'Context was truncated to the configured limits.', query: 'Preview query', serverBundle: 'This is the bundle returned by the server.',
} as const

type Messages = { [K in keyof typeof en]: string }
const zh: Messages = {
  runtimeProfiles: '运行时身份', assistantRoles: '助手角色', createRole: '新建角色', retry: '重试', loading: '正在加载助手角色…', empty: '暂无助手角色。', builtIn: '内置', custom: '自定义', enabled: '已启用', disabled: '已停用',
  edit: '编辑', clone: '克隆', delete: '删除', preview: '预览上下文', staleMapping: '映射的运行时身份不存在。请先选择有效身份再使用此角色。', phase3Warning: '能力权限在 Phase 3 启用 Action Fabric 强制执行前仅为声明。',
  identity: '身份与角色设定', name: '名称', description: '描述', persona: '角色提示', memoryNamespace: '记忆命名空间', profileMapping: '运行时身份映射', noProfile: '不映射', dataScope: '数据范围', domains: '领域', sections: '分区', includeProvenance: '包含来源', capability: '能力声明', allow: '允许的能力（逗号分隔）', deny: '禁止的能力（逗号分隔）',
  metadata: '决策与升级元数据', decisionAuthority: '决策权限（JSON）', spendingLimits: '消费限额（JSON）', escalationRules: '升级规则（JSON 数组）', recipes: '上下文配方', recipeLimitsNotice: '配方会持久化，并用于服务端上下文预览。', addRecipe: '添加配方', deleteRecipe: '删除配方', recipeNameRequired: '每个配方都需要名称。', queryTemplate: '查询模板', partialSave: '部分更新失败，已重新加载服务端权威数据。', perSection: '每分区条数', totalCharacters: '总字符数',
  cancel: '取消', save: '保存', nameRequired: '名称不能为空。', personaRequired: '角色提示不能为空。', memoryRequired: '记忆命名空间不能为空。', invalidJson: '决策、消费和升级元数据必须是有效 JSON。', previewTitle: '服务端上下文预览', previewEmpty: '运行预览以查看服务端上下文包。', rendered: '渲染后的指令', provenance: '来源', truncated: '上下文已按配置限额截断。', query: '预览查询', serverBundle: '这里展示服务端返回的上下文包。',
}

export function useAssistantRoleMessages(locale: Ref<unknown>) {
  const messages = computed<Messages>(() => String(locale.value).toLowerCase().startsWith('zh') ? zh : en)
  return { messages }
}
