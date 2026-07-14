/**
 * Centralized schema definitions for all Hermes SQLite tables.
 * All table schemas are defined here for unified management and migration.
 */

// ============================================================================
// Usage Store (usage-store.ts)
// ============================================================================

export const USAGE_TABLE = 'session_usage'

export const USAGE_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  session_id: 'TEXT NOT NULL',
  run_id: "TEXT NOT NULL DEFAULT ''",
  source: "TEXT NOT NULL DEFAULT ''",
  agent: "TEXT NOT NULL DEFAULT ''",
  usage_scope: "TEXT NOT NULL DEFAULT 'run'",
  purpose: "TEXT NOT NULL DEFAULT ''",
  api_calls: 'INTEGER NOT NULL DEFAULT 0',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  model: "TEXT NOT NULL DEFAULT ''",
  provider: "TEXT NOT NULL DEFAULT ''",
  profile: "TEXT NOT NULL DEFAULT 'default'",
  is_estimated: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL DEFAULT 0',
}

export const USAGE_RUN_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_usage_run
  ON ${USAGE_TABLE}(session_id, run_id, source) WHERE run_id <> ''`

// ============================================================================
// Session Store (session-store.ts)
// ============================================================================

export const SESSIONS_TABLE = 'sessions'

export const SESSIONS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  profile: 'TEXT NOT NULL DEFAULT \'default\'',
  source: 'TEXT NOT NULL DEFAULT \'api_server\'',
  agent: 'TEXT NOT NULL DEFAULT \'\'',
  agent_mode: 'TEXT NOT NULL DEFAULT \'\'',
  agent_session_id: 'TEXT NOT NULL DEFAULT \'\'',
  agent_native_session_id: 'TEXT NOT NULL DEFAULT \'\'',
  user_id: 'TEXT',
  model: 'TEXT NOT NULL DEFAULT \'\'',
  provider: 'TEXT NOT NULL DEFAULT \'\'',
  api_mode: 'TEXT NOT NULL DEFAULT \'\'',
  title: 'TEXT',
  parent_session_id: 'TEXT',
  fork_point_message_id: 'TEXT',
  started_at: 'INTEGER NOT NULL',
  ended_at: 'INTEGER',
  end_reason: 'TEXT',
  message_count: 'INTEGER NOT NULL DEFAULT 0',
  tool_call_count: 'INTEGER NOT NULL DEFAULT 0',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  billing_provider: 'TEXT',
  estimated_cost_usd: 'REAL NOT NULL DEFAULT 0',
  actual_cost_usd: 'REAL',
  cost_status: 'TEXT NOT NULL DEFAULT \'\'',
  preview: 'TEXT NOT NULL DEFAULT \'\'',
  last_active: 'INTEGER NOT NULL',
  is_archived: 'INTEGER NOT NULL DEFAULT 0',
  workspace: 'TEXT',
}

export const MESSAGES_TABLE = 'messages'

export const MESSAGES_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  session_id: 'TEXT NOT NULL',
  role: 'TEXT NOT NULL',
  content: 'TEXT NOT NULL DEFAULT \'\'',
  display_role: 'TEXT',
  display_content: 'TEXT',
  tool_call_id: 'TEXT',
  tool_calls: 'TEXT',
  tool_name: 'TEXT',
  timestamp: 'INTEGER NOT NULL',
  token_count: 'INTEGER',
  finish_reason: 'TEXT',
  reasoning: 'TEXT',
  reasoning_details: 'TEXT',
  reasoning_content: 'TEXT',
}

export const MESSAGES_INDEX = 'CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)'

// ============================================================================
// Workspace Run Changes
// ============================================================================

export const WORKSPACE_RUN_CHANGES_TABLE = 'workspace_run_changes'

export const WORKSPACE_RUN_CHANGES_SCHEMA: Record<string, string> = {
  change_id: 'TEXT PRIMARY KEY',
  room_id: "TEXT NOT NULL DEFAULT ''",
  message_id: "TEXT NOT NULL DEFAULT ''",
  session_id: 'TEXT NOT NULL',
  run_id: 'TEXT NOT NULL DEFAULT \'\'',
  source: 'TEXT NOT NULL DEFAULT \'run\'',
  workspace: 'TEXT NOT NULL DEFAULT \'\'',
  workspace_kind: 'TEXT NOT NULL DEFAULT \'git\'',
  started_at: 'INTEGER NOT NULL DEFAULT 0',
  finished_at: 'INTEGER NOT NULL DEFAULT 0',
  files_changed: 'INTEGER NOT NULL DEFAULT 0',
  additions: 'INTEGER NOT NULL DEFAULT 0',
  deletions: 'INTEGER NOT NULL DEFAULT 0',
  truncated: 'INTEGER NOT NULL DEFAULT 0',
  total_patch_bytes: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL',
}

export const WORKSPACE_RUN_CHANGE_FILES_TABLE = 'workspace_run_change_files'

export const WORKSPACE_RUN_CHANGE_FILES_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  change_id: 'TEXT NOT NULL',
  session_id: 'TEXT NOT NULL',
  path: 'TEXT NOT NULL',
  old_path: 'TEXT',
  change_type: 'TEXT NOT NULL DEFAULT \'modified\'',
  additions: 'INTEGER NOT NULL DEFAULT 0',
  deletions: 'INTEGER NOT NULL DEFAULT 0',
  size_before: 'INTEGER',
  size_after: 'INTEGER',
  patch: 'TEXT',
  patch_bytes: 'INTEGER NOT NULL DEFAULT 0',
  truncated: 'INTEGER NOT NULL DEFAULT 0',
  binary: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL',
}

export const WORKSPACE_RUN_CHANGES_INDEXES = {
  idx_workspace_run_changes_session: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_changes_session ON workspace_run_changes(session_id, created_at)',
  idx_workspace_run_changes_run: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_changes_run ON workspace_run_changes(run_id)',
  idx_workspace_run_changes_room: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_changes_room ON workspace_run_changes(room_id, created_at)',
}

export const WORKSPACE_RUN_CHANGE_FILES_INDEXES = {
  idx_workspace_run_change_files_change: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_change_files_change ON workspace_run_change_files(change_id)',
  idx_workspace_run_change_files_session: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_change_files_session ON workspace_run_change_files(session_id, created_at)',
}

// ============================================================================
// Workflow Store
// ============================================================================

export const WORKFLOWS_TABLE = 'workflows'

export const WORKFLOWS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  name: 'TEXT NOT NULL',
  profile: "TEXT NOT NULL DEFAULT 'default'",
  workspace: 'TEXT',
  nodes_json: "TEXT NOT NULL DEFAULT '[]'",
  edges_json: "TEXT NOT NULL DEFAULT '[]'",
  viewport_json: "TEXT NOT NULL DEFAULT '{}'",
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
}

export const WORKFLOWS_INDEXES = {
  idx_workflows_profile: 'CREATE INDEX IF NOT EXISTS idx_workflows_profile ON workflows(profile)',
  idx_workflows_updated_at: 'CREATE INDEX IF NOT EXISTS idx_workflows_updated_at ON workflows(updated_at)',
}

export const WORKFLOW_RUNS_TABLE = 'workflow_runs'

export const WORKFLOW_RUNS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  workflow_id: 'TEXT NOT NULL',
  profile: "TEXT NOT NULL DEFAULT 'default'",
  workspace: 'TEXT',
  start_node_ids_json: "TEXT NOT NULL DEFAULT '[]'",
  status: "TEXT NOT NULL DEFAULT 'queued'",
  snapshot_nodes_json: "TEXT NOT NULL DEFAULT '[]'",
  snapshot_edges_json: "TEXT NOT NULL DEFAULT '[]'",
  compiled_loops_json: "TEXT NOT NULL DEFAULT '[]'",
  started_at: 'INTEGER',
  finished_at: 'INTEGER',
  created_at: 'INTEGER NOT NULL',
  error: 'TEXT',
}

export const WORKFLOW_RUNS_INDEXES = {
  idx_workflow_runs_workflow: 'CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id)',
  idx_workflow_runs_status: 'CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)',
  idx_workflow_runs_created_at: 'CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_at ON workflow_runs(created_at)',
}

export const WORKFLOW_RUN_NODE_SESSIONS_TABLE = 'workflow_run_node_sessions'

export const WORKFLOW_RUN_NODE_SESSIONS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  run_id: 'TEXT NOT NULL',
  workflow_id: 'TEXT NOT NULL',
  node_id: 'TEXT NOT NULL',
  execution_id: "TEXT NOT NULL DEFAULT ''",
  iteration_path_json: "TEXT NOT NULL DEFAULT '[]'",
  consumed_edge_evaluation_ids_json: "TEXT NOT NULL DEFAULT '[]'",
  session_id: 'TEXT NOT NULL',
  profile: "TEXT NOT NULL DEFAULT 'default'",
  agent: "TEXT NOT NULL DEFAULT ''",
  agent_mode: "TEXT NOT NULL DEFAULT ''",
  status: "TEXT NOT NULL DEFAULT 'queued'",
  sequence: 'INTEGER NOT NULL DEFAULT 0',
  started_at: 'INTEGER',
  finished_at: 'INTEGER',
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
  error: 'TEXT',
}

export const WORKFLOW_RUN_NODE_SESSIONS_INDEXES = {
  idx_workflow_run_node_sessions_run: 'CREATE INDEX IF NOT EXISTS idx_workflow_run_node_sessions_run ON workflow_run_node_sessions(run_id)',
  idx_workflow_run_node_sessions_workflow: 'CREATE INDEX IF NOT EXISTS idx_workflow_run_node_sessions_workflow ON workflow_run_node_sessions(workflow_id)',
  idx_workflow_run_node_sessions_node: 'CREATE INDEX IF NOT EXISTS idx_workflow_run_node_sessions_node ON workflow_run_node_sessions(node_id)',
  idx_workflow_run_node_sessions_session: 'CREATE INDEX IF NOT EXISTS idx_workflow_run_node_sessions_session ON workflow_run_node_sessions(session_id)',
  idx_workflow_run_node_sessions_status: 'CREATE INDEX IF NOT EXISTS idx_workflow_run_node_sessions_status ON workflow_run_node_sessions(status)',
  idx_workflow_run_node_sessions_sequence: 'CREATE INDEX IF NOT EXISTS idx_workflow_run_node_sessions_sequence ON workflow_run_node_sessions(run_id, sequence)',
  uniq_workflow_run_node_sessions_run_execution: 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_workflow_run_node_sessions_run_execution ON workflow_run_node_sessions(run_id, execution_id)',
}

export const WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE = 'workflow_run_edge_evaluations'

export const WORKFLOW_RUN_EDGE_EVALUATIONS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY', run_id: 'TEXT NOT NULL', workflow_id: 'TEXT NOT NULL', edge_id: 'TEXT NOT NULL',
  source_node_id: 'TEXT NOT NULL', source_execution_id: "TEXT NOT NULL DEFAULT ''", iteration_path_json: "TEXT NOT NULL DEFAULT '[]'",
  target_node_id: 'TEXT NOT NULL', source_outcome: 'TEXT NOT NULL',
  status: 'TEXT NOT NULL', route: 'TEXT NOT NULL', reason: 'TEXT', sequence: 'INTEGER NOT NULL',
  orchestration_json: "TEXT NOT NULL DEFAULT '{}'", condition_evaluation_json: 'TEXT', evaluated_at: 'INTEGER NOT NULL',
}

export const WORKFLOW_RUN_EDGE_EVALUATIONS_INDEXES = {
  idx_workflow_run_edge_evaluations_run_sequence: 'CREATE INDEX IF NOT EXISTS idx_workflow_run_edge_evaluations_run_sequence ON workflow_run_edge_evaluations(run_id, sequence)',
  idx_workflow_run_edge_evaluations_edge: 'CREATE INDEX IF NOT EXISTS idx_workflow_run_edge_evaluations_edge ON workflow_run_edge_evaluations(edge_id)',
}

export const WORKFLOW_RUN_LOOP_EPOCHS_TABLE = 'workflow_run_loop_epochs'
export const WORKFLOW_RUN_LOOP_EPOCHS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY', run_id: 'TEXT NOT NULL', workflow_id: 'TEXT NOT NULL', loop_id: 'TEXT NOT NULL',
  iteration: 'INTEGER NOT NULL', iteration_path_json: "TEXT NOT NULL DEFAULT '[]'", status: 'TEXT NOT NULL',
  exit_reason: 'TEXT', sequence: 'INTEGER NOT NULL', started_at: 'INTEGER NOT NULL', finished_at: 'INTEGER NOT NULL',
}
export const WORKFLOW_RUN_LOOP_EPOCHS_INDEXES = {
  idx_workflow_run_loop_epochs_run_sequence: 'CREATE INDEX IF NOT EXISTS idx_workflow_run_loop_epochs_run_sequence ON workflow_run_loop_epochs(run_id, sequence)',
  uniq_workflow_run_loop_epochs_identity: 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_workflow_run_loop_epochs_identity ON workflow_run_loop_epochs(run_id, loop_id, iteration_path_json)',
}

// ============================================================================
// Compression Snapshot (compression-snapshot.ts)
// ============================================================================

export const COMPRESSION_SNAPSHOT_TABLE = 'chat_compression_snapshots'

export const COMPRESSION_SNAPSHOT_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  summary: 'TEXT NOT NULL DEFAULT \'\'',
  last_message_index: 'INTEGER NOT NULL DEFAULT 0',
  message_count_at_time: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Model Context (model-context.ts)
// ============================================================================

export const MODEL_CONTEXT_TABLE = 'model_context'

export const MODEL_CONTEXT_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  provider: 'TEXT NOT NULL',
  model: 'TEXT NOT NULL',
  context_limit: 'INTEGER NOT NULL',
}

export const MODEL_CONTEXT_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_model_context_provider_model ON model_context(provider, model)'

// ============================================================================
// Users and Profile Access
// ============================================================================

export const USERS_TABLE = 'users'

export const USERS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  username: 'TEXT NOT NULL UNIQUE',
  password_hash: 'TEXT NOT NULL',
  role: "TEXT NOT NULL DEFAULT 'admin'",
  status: "TEXT NOT NULL DEFAULT 'active'",
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
  last_login_at: 'INTEGER',
  avatar: "TEXT NOT NULL DEFAULT ''",
}

export const USER_PROFILES_TABLE = 'user_profiles'

export const USER_PROFILES_SCHEMA: Record<string, string> = {
  user_id: 'INTEGER NOT NULL',
  profile_name: "TEXT NOT NULL DEFAULT 'default'",
  is_default: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL',
}

export const USER_PROFILES_INDEXES = {
  idx_user_profiles_user: 'CREATE INDEX IF NOT EXISTS idx_user_profiles_user ON user_profiles(user_id)',
  idx_user_profiles_profile: 'CREATE INDEX IF NOT EXISTS idx_user_profiles_profile ON user_profiles(profile_name)',
  idx_user_profiles_default: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_default ON user_profiles(user_id) WHERE is_default = 1',
}

// ============================================================================
// LAN Devices
// ============================================================================

export const DEVICES_TABLE = 'devices'

export const DEVICES_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  status: "TEXT NOT NULL DEFAULT 'none'",
  inbound_status: "TEXT NOT NULL DEFAULT 'none'",
  outbound_status: "TEXT NOT NULL DEFAULT 'none'",
  device_public_key: "TEXT NOT NULL DEFAULT ''",
  computer_name: "TEXT NOT NULL DEFAULT ''",
  endpoint_kind: "TEXT NOT NULL DEFAULT 'custom'",
  ip: "TEXT NOT NULL DEFAULT ''",
  http_port: 'INTEGER NOT NULL DEFAULT 0',
  url: "TEXT NOT NULL DEFAULT ''",
  os_json: "TEXT NOT NULL DEFAULT '{}'",
  hermes_agent_version: "TEXT NOT NULL DEFAULT ''",
  hermes_web_ui_version: "TEXT NOT NULL DEFAULT ''",
  response_ms: 'INTEGER NOT NULL DEFAULT 0',
  requested_at: 'INTEGER NOT NULL DEFAULT 0',
  decided_at: 'INTEGER',
  outbound_requested_at: 'INTEGER NOT NULL DEFAULT 0',
  outbound_decided_at: 'INTEGER',
  inbound_history_deleted_at: 'INTEGER',
  last_seen_at: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL',
}

export const DEVICES_INDEXES = {
  idx_devices_status: 'CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status)',
  idx_devices_last_seen: 'CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at)',
}

// ============================================================================
// MCU Devices
// ============================================================================

export const MCU_DEVICES_TABLE = 'mcu_devices'

export const MCU_DEVICES_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  name: "TEXT NOT NULL DEFAULT ''",
  device_code: 'TEXT NOT NULL UNIQUE',
  is_official: 'INTEGER NOT NULL DEFAULT 0',
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const MCU_DEVICES_INDEXES = {
  idx_mcu_devices_created_at: 'CREATE INDEX IF NOT EXISTS idx_mcu_devices_created_at ON mcu_devices(created_at)',
}

export const STT_PROVIDER_SETTINGS_TABLE = 'stt_provider_settings'

export const STT_PROVIDER_SETTINGS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  user_id: 'INTEGER NOT NULL',
  provider: 'TEXT NOT NULL',
  settings_json: `TEXT NOT NULL DEFAULT '{}'`,
  secrets_json: `TEXT NOT NULL DEFAULT '{}'`,
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const STT_PROVIDER_SETTINGS_INDEXES = {
  idx_stt_provider_settings_user: 'CREATE INDEX IF NOT EXISTS idx_stt_provider_settings_user ON stt_provider_settings(user_id)',
  idx_stt_provider_settings_user_provider: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_stt_provider_settings_user_provider ON stt_provider_settings(user_id, provider)',
}

export const STT_USER_SETTINGS_TABLE = 'stt_user_settings'

export const STT_USER_SETTINGS_SCHEMA: Record<string, string> = {
  user_id: 'INTEGER PRIMARY KEY',
  active_provider: "TEXT NOT NULL DEFAULT 'browser'",
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const STT_PROFILE_PROVIDER_SETTINGS_TABLE = 'stt_profile_provider_settings'

export const STT_PROFILE_PROVIDER_SETTINGS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  profile: "TEXT NOT NULL DEFAULT 'default'",
  provider: 'TEXT NOT NULL',
  settings_json: `TEXT NOT NULL DEFAULT '{}'`,
  secrets_json: `TEXT NOT NULL DEFAULT '{}'`,
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const STT_PROFILE_PROVIDER_SETTINGS_INDEXES = {
  idx_stt_profile_provider_settings_profile: 'CREATE INDEX IF NOT EXISTS idx_stt_profile_provider_settings_profile ON stt_profile_provider_settings(profile)',
  idx_stt_profile_provider_settings_profile_provider: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_stt_profile_provider_settings_profile_provider ON stt_profile_provider_settings(profile, provider)',
}

export const STT_PROFILE_SETTINGS_TABLE = 'stt_profile_settings'

export const STT_PROFILE_SETTINGS_SCHEMA: Record<string, string> = {
  profile: "TEXT PRIMARY KEY DEFAULT 'default'",
  active_provider: "TEXT NOT NULL DEFAULT 'browser'",
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const TTS_PROVIDER_SETTINGS_TABLE = 'tts_provider_settings'

export const TTS_PROVIDER_SETTINGS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  user_id: 'INTEGER NOT NULL',
  provider: 'TEXT NOT NULL',
  settings_json: `TEXT NOT NULL DEFAULT '{}'`,
  secrets_json: `TEXT NOT NULL DEFAULT '{}'`,
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const TTS_PROVIDER_SETTINGS_INDEXES = {
  idx_tts_provider_settings_user: 'CREATE INDEX IF NOT EXISTS idx_tts_provider_settings_user ON tts_provider_settings(user_id)',
  idx_tts_provider_settings_user_provider: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tts_provider_settings_user_provider ON tts_provider_settings(user_id, provider)',
}

export const TTS_USER_SETTINGS_TABLE = 'tts_user_settings'

export const TTS_USER_SETTINGS_SCHEMA: Record<string, string> = {
  user_id: 'INTEGER PRIMARY KEY',
  active_provider: "TEXT NOT NULL DEFAULT 'edge'",
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const TTS_PROFILE_PROVIDER_SETTINGS_TABLE = 'tts_profile_provider_settings'

export const TTS_PROFILE_PROVIDER_SETTINGS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  profile: "TEXT NOT NULL DEFAULT 'default'",
  provider: 'TEXT NOT NULL',
  settings_json: `TEXT NOT NULL DEFAULT '{}'`,
  secrets_json: `TEXT NOT NULL DEFAULT '{}'`,
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const TTS_PROFILE_PROVIDER_SETTINGS_INDEXES = {
  idx_tts_profile_provider_settings_profile: 'CREATE INDEX IF NOT EXISTS idx_tts_profile_provider_settings_profile ON tts_profile_provider_settings(profile)',
  idx_tts_profile_provider_settings_profile_provider: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tts_profile_provider_settings_profile_provider ON tts_profile_provider_settings(profile, provider)',
}

export const TTS_PROFILE_SETTINGS_TABLE = 'tts_profile_settings'

export const TTS_PROFILE_SETTINGS_SCHEMA: Record<string, string> = {
  profile: "TEXT PRIMARY KEY DEFAULT 'default'",
  active_provider: "TEXT NOT NULL DEFAULT 'edge'",
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

// ============================================================================
// Group Chat (services/hermes/group-chat/index.ts)
// ============================================================================

export const GC_ROOMS_TABLE = 'gc_rooms'

export const GC_ROOMS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  name: 'TEXT NOT NULL',
  inviteCode: 'TEXT UNIQUE',
  triggerTokens: 'INTEGER NOT NULL DEFAULT 100000',
  maxHistoryTokens: 'INTEGER NOT NULL DEFAULT 32000',
  tailMessageCount: 'INTEGER NOT NULL DEFAULT 10',
  totalTokens: 'INTEGER NOT NULL DEFAULT 0',
  sessionSeed: "TEXT NOT NULL DEFAULT '0'",
  workspace: "TEXT NOT NULL DEFAULT ''",
  ownerAuthUserId: 'INTEGER',
}

export const GC_MESSAGES_TABLE = 'gc_messages'

export const GC_MESSAGES_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  senderId: 'TEXT NOT NULL',
  senderName: 'TEXT NOT NULL',
  content: 'TEXT NOT NULL',
  timestamp: 'INTEGER NOT NULL',
  role: "TEXT NOT NULL DEFAULT 'user'",
  tool_call_id: 'TEXT',
  tool_calls: 'TEXT',
  tool_name: 'TEXT',
  finish_reason: 'TEXT',
  reasoning: 'TEXT',
  reasoning_details: 'TEXT',
  reasoning_content: 'TEXT',
}

export const GC_ROOM_AGENTS_TABLE = 'gc_room_agents'

export const GC_ROOM_AGENTS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  agentId: 'TEXT NOT NULL',
  profile: 'TEXT NOT NULL',
  name: 'TEXT NOT NULL',
  description: "TEXT NOT NULL DEFAULT ''",
  invited: 'INTEGER NOT NULL DEFAULT 0',
}

export const GC_CONTEXT_SNAPSHOTS_TABLE = 'gc_context_snapshots'

export const GC_CONTEXT_SNAPSHOTS_SCHEMA: Record<string, string> = {
  roomId: 'TEXT PRIMARY KEY',
  summary: 'TEXT NOT NULL DEFAULT \'\'',
  lastMessageId: 'TEXT NOT NULL',
  lastMessageTimestamp: 'INTEGER NOT NULL',
  updatedAt: 'INTEGER NOT NULL',
}

export const GC_ROOM_MEMBERS_TABLE = 'gc_room_members'

export const GC_ROOM_MEMBERS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  userId: 'TEXT NOT NULL',
  userName: 'TEXT NOT NULL',
  description: "TEXT NOT NULL DEFAULT ''",
  joinedAt: 'INTEGER NOT NULL',
  updatedAt: 'INTEGER NOT NULL',
  avatar: "TEXT NOT NULL DEFAULT ''",
  authUserId: 'INTEGER',
}

export const GC_PENDING_SESSION_DELETES_TABLE = 'gc_pending_session_deletes'

export const GC_PENDING_SESSION_DELETES_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  profile_name: 'TEXT NOT NULL',
  status: "TEXT NOT NULL DEFAULT 'pending'",
  attempt_count: 'INTEGER NOT NULL DEFAULT 0',
  last_error: 'TEXT',
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
  next_attempt_at: 'INTEGER NOT NULL DEFAULT 0',
}

export const GC_SESSION_PROFILES_TABLE = 'gc_session_profiles'

export const GC_SESSION_PROFILES_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  room_id: 'TEXT NOT NULL',
  agent_id: 'TEXT NOT NULL',
  profile_name: 'TEXT NOT NULL',
  created_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Schema Sync Utilities
// ============================================================================

import { getDb, getStoragePath } from '../index'

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

/**
 * 检查表是否存在
 */
function tableExists(db: NonNullable<ReturnType<typeof getDb>>, tableName: string): boolean {
  const result = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName)
  return !!result
}

/**
 * 创建表（带完整 schema）
 */
function createTable(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  schema: Record<string, string>,
  primaryKey?: string
): void {
  const colDefs = Object.entries(schema).map(([col, def]) => `${quoteIdentifier(col)} ${def}`)

  // 只在 schema 中没有主键时才添加复合主键
  const hasPrimaryKeyInSchema = Object.values(schema).some((def) =>
    def.toUpperCase().includes("PRIMARY KEY")
  )

  if (primaryKey && !hasPrimaryKeyInSchema) {
    colDefs.push(`PRIMARY KEY (${primaryKey})`)
  }

  db.exec(`CREATE TABLE ${quoteIdentifier(tableName)} (${colDefs.join(', ')})`)
}

function canAddColumnToExistingTable(schemaDef: string): boolean {
  const normalized = schemaDef.toUpperCase()
  if (normalized.includes('PRIMARY KEY')) return false
  if (normalized.includes('NOT NULL') && !normalized.includes('DEFAULT')) return false
  return true
}

function addMissingSafeColumns(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  schema: Record<string, string>,
): void {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>
  const existingColumns = new Set(columns.map(col => col.name))

  for (const [columnName, columnDef] of Object.entries(schema)) {
    if (existingColumns.has(columnName)) continue
    if (!canAddColumnToExistingTable(columnDef)) {
      console.warn(`[Schema] ${tableName}.${columnName} cannot be added safely to existing table; skipping`)
      continue
    }
    db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${columnDef}`)
  }
}

function createIndexes(
  db: NonNullable<ReturnType<typeof getDb>>,
  indexes?: Record<string, string>,
): void {
  if (!indexes) return

  for (const indexSQL of Object.values(indexes)) {
    db.exec(indexSQL)
  }
}

function indexExists(
  db: NonNullable<ReturnType<typeof getDb>>,
  indexName: string,
): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`
  ).get(indexName))
}

function syncWorkflowRunNodeSessions(
  db: NonNullable<ReturnType<typeof getDb>>,
): void {
  if (!tableExists(db, WORKFLOW_RUN_NODE_SESSIONS_TABLE)) {
    syncTable(WORKFLOW_RUN_NODE_SESSIONS_TABLE, WORKFLOW_RUN_NODE_SESSIONS_SCHEMA, {
      indexes: WORKFLOW_RUN_NODE_SESSIONS_INDEXES,
    })
    return
  }

  const hasExecutionId = tableHasColumn(db, WORKFLOW_RUN_NODE_SESSIONS_TABLE, 'execution_id')
  const hasBlankExecutionIds = hasExecutionId && Boolean(db.prepare(
    `SELECT 1 FROM ${quoteIdentifier(WORKFLOW_RUN_NODE_SESSIONS_TABLE)} WHERE execution_id = '' LIMIT 1`
  ).get())
  const needsMigration =
    !hasExecutionId ||
    hasBlankExecutionIds ||
    indexExists(db, 'uniq_workflow_run_node_sessions_run_node') ||
    !indexExists(db, 'uniq_workflow_run_node_sessions_run_execution')

  if (!needsMigration) {
    syncTable(WORKFLOW_RUN_NODE_SESSIONS_TABLE, WORKFLOW_RUN_NODE_SESSIONS_SCHEMA)
    return
  }

  db.exec('BEGIN')
  try {
    syncTable(WORKFLOW_RUN_NODE_SESSIONS_TABLE, WORKFLOW_RUN_NODE_SESSIONS_SCHEMA)
    db.prepare(
      `UPDATE ${quoteIdentifier(WORKFLOW_RUN_NODE_SESSIONS_TABLE)} ` +
      `SET execution_id = node_id WHERE execution_id = ''`
    ).run()
    db.exec('DROP INDEX IF EXISTS uniq_workflow_run_node_sessions_run_node')
    createIndexes(db, WORKFLOW_RUN_NODE_SESSIONS_INDEXES)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function syncWorkflowRunEdgeEvaluations(
  db: NonNullable<ReturnType<typeof getDb>>,
): void {
  if (!tableExists(db, WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE)) {
    syncTable(WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE, WORKFLOW_RUN_EDGE_EVALUATIONS_SCHEMA, {
      indexes: WORKFLOW_RUN_EDGE_EVALUATIONS_INDEXES,
    })
    return
  }

  const hasIncompatibleLegacySchema =
    !tableHasColumn(db, WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE, 'source_outcome') ||
    !tableHasColumn(db, WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE, 'route')
  if (!hasIncompatibleLegacySchema) {
    syncTable(WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE, WORKFLOW_RUN_EDGE_EVALUATIONS_SCHEMA, {
      indexes: WORKFLOW_RUN_EDGE_EVALUATIONS_INDEXES,
    })
    return
  }

  const archiveTable = `${WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE}__legacy_v1`
  db.exec('BEGIN')
  try {
    if (tableExists(db, archiveTable)) {
      throw new Error(`cannot archive legacy ${WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE}: ${archiveTable} already exists`)
    }
    db.exec(
      `ALTER TABLE ${quoteIdentifier(WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE)} ` +
      `RENAME TO ${quoteIdentifier(archiveTable)}`
    )
    for (const indexName of Object.keys(WORKFLOW_RUN_EDGE_EVALUATIONS_INDEXES)) {
      db.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(indexName)}`)
    }
    syncTable(WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE, WORKFLOW_RUN_EDGE_EVALUATIONS_SCHEMA, {
      indexes: WORKFLOW_RUN_EDGE_EVALUATIONS_INDEXES,
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function migrateLegacySttProviderSettingsUserIdDefault(
  db: NonNullable<ReturnType<typeof getDb>>,
): void {
  if (!tableExists(db, STT_PROVIDER_SETTINGS_TABLE)) return

  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(STT_PROVIDER_SETTINGS_TABLE)})`).all() as Array<{
    name: string
    dflt_value: string | null
  }>
  const userIdColumn = columns.find((column) => column.name === 'user_id')

  if (!userIdColumn || userIdColumn.dflt_value === null) {
    return
  }

  const replacementTableName = `${STT_PROVIDER_SETTINGS_TABLE}__rebuilt`
  const preservedColumns = ['id', 'user_id', 'provider', 'settings_json', 'secrets_json', 'created_at', 'updated_at']
  const quotedPreservedColumns = preservedColumns.map((column) => quoteIdentifier(column)).join(', ')

  db.exec('BEGIN')
  try {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(replacementTableName)}`)
    createTable(db, replacementTableName, STT_PROVIDER_SETTINGS_SCHEMA)
    db.exec(
      `INSERT INTO ${quoteIdentifier(replacementTableName)} (${quotedPreservedColumns}) ` +
      `SELECT ${quotedPreservedColumns} FROM ${quoteIdentifier(STT_PROVIDER_SETTINGS_TABLE)}`
    )
    db.exec(`DROP TABLE ${quoteIdentifier(STT_PROVIDER_SETTINGS_TABLE)}`)
    db.exec(`ALTER TABLE ${quoteIdentifier(replacementTableName)} RENAME TO ${quoteIdentifier(STT_PROVIDER_SETTINGS_TABLE)}`)
    createIndexes(db, STT_PROVIDER_SETTINGS_INDEXES)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function copyLegacyProviderSettingsToDefaultProfile(
  db: NonNullable<ReturnType<typeof getDb>>,
  sourceTableName: string,
  targetTableName: string,
): void {
  if (!tableExists(db, sourceTableName) || !tableExists(db, targetTableName)) return

  db.prepare(
    `INSERT OR IGNORE INTO ${quoteIdentifier(targetTableName)} ` +
    `(profile, provider, settings_json, secrets_json, created_at, updated_at) ` +
    `SELECT 'default', old.provider, old.settings_json, old.secrets_json, old.created_at, old.updated_at ` +
    `FROM ${quoteIdentifier(sourceTableName)} old ` +
    `WHERE old.provider IS NOT NULL ` +
    `AND NOT EXISTS (` +
    `SELECT 1 FROM ${quoteIdentifier(sourceTableName)} newer ` +
    `WHERE newer.provider = old.provider ` +
    `AND (newer.updated_at > old.updated_at OR (newer.updated_at = old.updated_at AND newer.rowid > old.rowid))` +
    `)`
  ).run()
}

function copyLegacyActiveSettingsToDefaultProfile(
  db: NonNullable<ReturnType<typeof getDb>>,
  sourceTableName: string,
  targetTableName: string,
): void {
  if (!tableExists(db, sourceTableName) || !tableExists(db, targetTableName)) return

  db.prepare(
    `INSERT OR IGNORE INTO ${quoteIdentifier(targetTableName)} ` +
    `(profile, active_provider, created_at, updated_at) ` +
    `SELECT 'default', active_provider, created_at, updated_at ` +
    `FROM ${quoteIdentifier(sourceTableName)} ` +
    `WHERE active_provider IS NOT NULL ` +
    `ORDER BY updated_at DESC, rowid DESC ` +
    `LIMIT 1`
  ).run()
}

function tableHasColumn(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  columnName: string,
): boolean {
  if (!tableExists(db, tableName)) return false
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>
  return columns.some(column => column.name === columnName)
}

function pruneDuplicateProfileProviderSettings(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
): void {
  if (!tableHasColumn(db, tableName, 'profile') || !tableHasColumn(db, tableName, 'provider')) return

  db.prepare(
    `DELETE FROM ${quoteIdentifier(tableName)} ` +
    `WHERE rowid NOT IN (` +
    `SELECT kept.rowid FROM ${quoteIdentifier(tableName)} kept ` +
    `WHERE NOT EXISTS (` +
    `SELECT 1 FROM ${quoteIdentifier(tableName)} newer ` +
    `WHERE newer.profile = kept.profile ` +
    `AND newer.provider = kept.provider ` +
    `AND (newer.updated_at > kept.updated_at OR (newer.updated_at = kept.updated_at AND newer.rowid > kept.rowid))` +
    `)` +
    `)`
  ).run()
}

function pruneDuplicateProfileActiveSettings(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
): void {
  if (!tableHasColumn(db, tableName, 'profile')) return

  db.prepare(
    `DELETE FROM ${quoteIdentifier(tableName)} ` +
    `WHERE rowid NOT IN (` +
    `SELECT kept.rowid FROM ${quoteIdentifier(tableName)} kept ` +
    `WHERE NOT EXISTS (` +
    `SELECT 1 FROM ${quoteIdentifier(tableName)} newer ` +
    `WHERE newer.profile = kept.profile ` +
    `AND (newer.updated_at > kept.updated_at OR (newer.updated_at = kept.updated_at AND newer.rowid > kept.rowid))` +
    `)` +
    `)`
  ).run()
}

function ensureProfileSettingsIndexes(
  db: NonNullable<ReturnType<typeof getDb>>,
  activeTableName: string,
  activeIndexName: string,
  providerTableName: string,
  providerIndexes: Record<string, string>,
): void {
  pruneDuplicateProfileActiveSettings(db, activeTableName)
  pruneDuplicateProfileProviderSettings(db, providerTableName)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(activeIndexName)} ON ${quoteIdentifier(activeTableName)}(profile)`)
  createIndexes(db, providerIndexes)
}

/**
 * 主同步函数
 * - 表不存在：创建
 * - 表存在：只追加安全的新列，不删除、不重建、不修改主键/类型
 */
export function syncTable(
  tableName: string,
  schema: Record<string, string>,
  options?: {
    primaryKey?: string  // 主键定义，如 "roomId, agentId" 或 "id"
    indexes?: Record<string, string>  // 索引定义
  }
): void {
  const db = getDb()
  if (!db) return

  // 1. 表不存在 → 直接创建
  if (!tableExists(db, tableName)) {
    createTable(db, tableName, schema, options?.primaryKey)

    // 创建索引
    createIndexes(db, options?.indexes)
    return
  }

  addMissingSafeColumns(db, tableName, schema)
}

// ============================================================================
// Unified Initializer
// ============================================================================

/**
 * Initialize missing Hermes SQLite tables with proper schemas.
 * Existing tables only receive safe additive columns.
 * Call this once at application bootstrap.
 */
export function initAllHermesTables(): void {
  const db = getDb()
  if (!db) return

  try {
    // Usage store
    syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })
    db.exec(USAGE_RUN_INDEX)

    // Session store
    syncTable(SESSIONS_TABLE, SESSIONS_SCHEMA)
    syncTable(MESSAGES_TABLE, MESSAGES_SCHEMA)
    db.exec(MESSAGES_INDEX)
    syncTable(WORKSPACE_RUN_CHANGES_TABLE, WORKSPACE_RUN_CHANGES_SCHEMA, {
      indexes: WORKSPACE_RUN_CHANGES_INDEXES,
    })
    syncTable(WORKSPACE_RUN_CHANGE_FILES_TABLE, WORKSPACE_RUN_CHANGE_FILES_SCHEMA, {
      indexes: WORKSPACE_RUN_CHANGE_FILES_INDEXES,
    })

    // Workflow store
    syncTable(WORKFLOWS_TABLE, WORKFLOWS_SCHEMA, {
      indexes: WORKFLOWS_INDEXES,
    })
    syncTable(WORKFLOW_RUNS_TABLE, WORKFLOW_RUNS_SCHEMA, {
      indexes: WORKFLOW_RUNS_INDEXES,
    })
    syncWorkflowRunNodeSessions(db)
    syncWorkflowRunEdgeEvaluations(db)
    syncTable(WORKFLOW_RUN_LOOP_EPOCHS_TABLE, WORKFLOW_RUN_LOOP_EPOCHS_SCHEMA, {
      indexes: WORKFLOW_RUN_LOOP_EPOCHS_INDEXES,
    })

    // Compression snapshot
    syncTable(COMPRESSION_SNAPSHOT_TABLE, COMPRESSION_SNAPSHOT_SCHEMA)

    // Model context
    syncTable(MODEL_CONTEXT_TABLE, MODEL_CONTEXT_SCHEMA, {
      indexes: {
        idx_model_context_provider_model: MODEL_CONTEXT_INDEX,
      }
    })

    // Users and profile access
    syncTable(USERS_TABLE, USERS_SCHEMA)
    syncTable(USER_PROFILES_TABLE, USER_PROFILES_SCHEMA, {
      primaryKey: 'user_id, profile_name',
      indexes: USER_PROFILES_INDEXES,
    })

    // LAN devices and link request status
    syncTable(DEVICES_TABLE, DEVICES_SCHEMA, {
      indexes: DEVICES_INDEXES,
    })

    // MCU devices
    syncTable(MCU_DEVICES_TABLE, MCU_DEVICES_SCHEMA, {
      indexes: MCU_DEVICES_INDEXES,
    })

    syncTable(STT_PROVIDER_SETTINGS_TABLE, STT_PROVIDER_SETTINGS_SCHEMA, {
      indexes: STT_PROVIDER_SETTINGS_INDEXES,
    })
    syncTable(STT_USER_SETTINGS_TABLE, STT_USER_SETTINGS_SCHEMA)
    migrateLegacySttProviderSettingsUserIdDefault(db)
    syncTable(STT_PROFILE_PROVIDER_SETTINGS_TABLE, STT_PROFILE_PROVIDER_SETTINGS_SCHEMA, {
      indexes: STT_PROFILE_PROVIDER_SETTINGS_INDEXES,
    })
    syncTable(STT_PROFILE_SETTINGS_TABLE, STT_PROFILE_SETTINGS_SCHEMA)
    ensureProfileSettingsIndexes(
      db,
      STT_PROFILE_SETTINGS_TABLE,
      'idx_stt_profile_settings_profile',
      STT_PROFILE_PROVIDER_SETTINGS_TABLE,
      STT_PROFILE_PROVIDER_SETTINGS_INDEXES,
    )
    copyLegacyProviderSettingsToDefaultProfile(db, STT_PROVIDER_SETTINGS_TABLE, STT_PROFILE_PROVIDER_SETTINGS_TABLE)
    copyLegacyActiveSettingsToDefaultProfile(db, STT_USER_SETTINGS_TABLE, STT_PROFILE_SETTINGS_TABLE)
    syncTable(TTS_PROVIDER_SETTINGS_TABLE, TTS_PROVIDER_SETTINGS_SCHEMA, {
      indexes: TTS_PROVIDER_SETTINGS_INDEXES,
    })
    syncTable(TTS_USER_SETTINGS_TABLE, TTS_USER_SETTINGS_SCHEMA)
    syncTable(TTS_PROFILE_PROVIDER_SETTINGS_TABLE, TTS_PROFILE_PROVIDER_SETTINGS_SCHEMA, {
      indexes: TTS_PROFILE_PROVIDER_SETTINGS_INDEXES,
    })
    syncTable(TTS_PROFILE_SETTINGS_TABLE, TTS_PROFILE_SETTINGS_SCHEMA)
    ensureProfileSettingsIndexes(
      db,
      TTS_PROFILE_SETTINGS_TABLE,
      'idx_tts_profile_settings_profile',
      TTS_PROFILE_PROVIDER_SETTINGS_TABLE,
      TTS_PROFILE_PROVIDER_SETTINGS_INDEXES,
    )
    copyLegacyProviderSettingsToDefaultProfile(db, TTS_PROVIDER_SETTINGS_TABLE, TTS_PROFILE_PROVIDER_SETTINGS_TABLE)
    copyLegacyActiveSettingsToDefaultProfile(db, TTS_USER_SETTINGS_TABLE, TTS_PROFILE_SETTINGS_TABLE)

    // Group chat - basic tables
    syncTable(GC_ROOMS_TABLE, GC_ROOMS_SCHEMA)
    syncTable(GC_MESSAGES_TABLE, GC_MESSAGES_SCHEMA)
    syncTable(GC_CONTEXT_SNAPSHOTS_TABLE, GC_CONTEXT_SNAPSHOTS_SCHEMA)
    syncTable(GC_PENDING_SESSION_DELETES_TABLE, GC_PENDING_SESSION_DELETES_SCHEMA)
    syncTable(GC_SESSION_PROFILES_TABLE, GC_SESSION_PROFILES_SCHEMA)

    // Group chat - single-column primary key tables (PRIMARY KEY in column definition)
    syncTable(GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA, {
      indexes: {
        idx_gc_room_agents_profile: 'CREATE INDEX idx_gc_room_agents_profile ON gc_room_agents(profile)',
      }
    })

    syncTable(GC_ROOM_MEMBERS_TABLE, GC_ROOM_MEMBERS_SCHEMA, {
      indexes: {
        idx_gc_room_members_user: 'CREATE INDEX idx_gc_room_members_user ON gc_room_members(userId)',
      }
    })
  } catch (e) {
    console.error('Error initializing Hermes SQLite tables:', e)
    console.error(`[Schema] Database initialization failed. Existing database was left untouched: ${getStoragePath()}`)
    throw e
  }
}
