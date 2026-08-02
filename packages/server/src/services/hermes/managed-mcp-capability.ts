import { createHmac, timingSafeEqual } from 'node:crypto'
import { getDb } from '../../db'
import { findUserById, userCanAccessProfile } from '../../db/hermes/users-store'
import { getToken } from '../auth'
import type { GroupHandoffJob } from './group-chat'

const CAPABILITY_VERSION = 1
const DEFAULT_TTL_MS = 5 * 60_000
const SERVER_TOOLSETS: Readonly<Record<string, string>> = {
  'hermes-studio-api': 'api',
  'hermes-studio-browser': 'browser',
  'hermes-studio-devices': 'devices',
  'hermes-studio-use': 'use',
}

/** Exact managed MCP surface exposed to a Group Chat participant run. Keep
 * this list synchronized with bin/hermes-studio-mcp.mjs; the dispatcher still
 * validates every individual call against the signed list. */
export const GROUP_CHAT_MANAGED_MCP_SERVER_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'hermes-studio-api': ['hermes_studio_api_openapi_get', 'hermes_studio_api_request'],
  'hermes-studio-browser': [
    'hermes_studio_browser_tabs', 'hermes_studio_browser_navigate', 'hermes_studio_browser_snapshot',
    'hermes_studio_browser_read_text', 'hermes_studio_browser_interact',
    'hermes_studio_browser_screenshot', 'hermes_studio_browser_console',
  ],
  'hermes-studio-devices': [
    'hermes_studio_lan_devices_list', 'hermes_studio_lan_devices_scan',
    'hermes_studio_lan_peer_connect', 'hermes_studio_lan_peer_connections', 'hermes_studio_lan_peer_disconnect',
    'hermes_studio_lan_terminal_create', 'hermes_studio_lan_terminal_list', 'hermes_studio_lan_terminal_input',
    'hermes_studio_lan_terminal_read', 'hermes_studio_lan_terminal_resize', 'hermes_studio_lan_terminal_close',
    'hermes_studio_lan_command_exec', 'hermes_studio_lan_file_download', 'hermes_studio_lan_file_upload',
  ],
  'hermes-studio-use': [
    'hermes_studio_use_chat_run', 'hermes_studio_use_sessions_list', 'hermes_studio_use_sessions_count',
    'hermes_studio_use_usage_stats', 'hermes_studio_use_session_get', 'hermes_studio_use_session_messages',
    'hermes_studio_use_session_context', 'hermes_studio_use_session_delete', 'hermes_studio_use_session_rename',
    'hermes_studio_use_profiles_list', 'hermes_studio_use_available_models', 'hermes_studio_use_model_provider_get',
    'hermes_studio_use_provider_add', 'hermes_studio_use_provider_delete', 'hermes_studio_use_worker_status',
    'hermes_studio_use_workflows_list', 'hermes_studio_use_workflow_get', 'hermes_studio_use_workflow_create',
    'hermes_studio_use_workflow_update', 'hermes_studio_use_workflow_delete', 'hermes_studio_use_workflow_runs_list',
    'hermes_studio_use_workflow_run_start', 'hermes_studio_use_workflow_run_stop',
    'hermes_studio_use_workflow_rerun_node', 'hermes_studio_use_workflow_run_delete',
  ],
}

interface CapabilityClaims {
  v: 1
  roomId: string
  initiatorActorId: string
  initiatorAuthUserId: number
  participantAgentId: string
  participantActorId: string
  participantSessionId: string
  participantSessionGeneration: number
  profile: string
  jobId: string
  leaseToken: string
  authorityReaderEpoch: number
  roomAuthorizationRevision: number
  initiatorActorAuthorizationRevision: number
  initiatorActorContextRevision: number
  participantActorAuthorizationRevision: number
  participantActorContextRevision: number
  serverTools: Record<string, string[]>
  expiresAt: number
}

export interface ManagedMcpCapabilityIssuerInput {
  jobId: string
  leaseToken: string
  participantAgentId: string
  profile: string
  serverTools: Record<string, readonly string[]>
  expiresAt?: number
}

export interface ManagedMcpAuthorizationInput {
  token: string
  server: string
  toolset: string
  tool: string
  now?: number
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

async function capabilitySecret(): Promise<string> {
  return process.env.AUTH_JWT_SECRET || await getToken()
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function equalSignature(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function exactServerTools(value: Record<string, readonly string[]>): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Managed MCP exact server/tool authority is required')
  const result: Record<string, string[]> = {}
  for (const [server, tools] of Object.entries(value)) {
    if (!SERVER_TOOLSETS[server] || !Array.isArray(tools) || tools.length === 0) {
      throw new Error('Managed MCP server/tool authority is invalid')
    }
    const exact = [...new Set(tools.map(tool => String(tool || '').trim()).filter(Boolean))].sort()
    if (!exact.length) throw new Error('Managed MCP exact tool authority is required')
    result[server] = exact
  }
  if (!Object.keys(result).length) throw new Error('Managed MCP exact server/tool authority is required')
  return result
}

function requireRunningJob(storage: any, input: Pick<ManagedMcpCapabilityIssuerInput, 'jobId' | 'leaseToken' | 'participantAgentId'>): GroupHandoffJob {
  const job = storage?.getHandoffJob?.(input.jobId) as GroupHandoffJob | null
  if (!job || job.status !== 'running' || job.leaseToken !== input.leaseToken || job.targetAgentId !== input.participantAgentId) {
    throw new Error('Managed MCP durable job authority is not current')
  }
  if (storage?.isHandoffExecutionCurrent?.(job.id, job.leaseToken, job.targetAgentId, job.targetSessionId) !== true) {
    throw new Error('Managed MCP durable lease authority was revoked')
  }
  return job
}

function currentBindings(job: GroupHandoffJob, requestedProfile: string) {
  const db = getDb()
  if (!db) throw new Error('Managed MCP authority storage is unavailable')
  const initiator = db.prepare(
    `SELECT id, authUserId, authorizationRevision, contextRevision, active
     FROM gc_room_actors WHERE id = ? AND roomId = ?`,
  ).get(job.initiatorActorId, job.roomId) as {
    id: string; authUserId: number | null; authorizationRevision: number; contextRevision: number; active: number
  } | undefined
  const participantActor = db.prepare(
    `SELECT id, authorizationRevision, contextRevision, active
     FROM gc_room_actors WHERE id = ? AND roomId = ?`,
  ).get(job.targetActorId, job.roomId) as {
    id: string; authorizationRevision: number; contextRevision: number; active: number
  } | undefined
  const participant = db.prepare(
    `SELECT agentId, profile, sessionId, sessionGeneration
     FROM gc_room_agents WHERE roomId = ? AND agentId = ?`,
  ).get(job.roomId, job.targetAgentId) as {
    agentId: string; profile: string; sessionId: string; sessionGeneration: number
  } | undefined
  if (!initiator || initiator.active !== 1 || !Number.isInteger(initiator.authUserId) || Number(initiator.authUserId) <= 0) {
    throw new Error('Managed MCP initiator actor is not an active authenticated user')
  }
  if (!participantActor || participantActor.active !== 1 || !participant) {
    throw new Error('Managed MCP participant authority is unavailable')
  }
  if (participant.profile !== requestedProfile || participant.sessionId !== job.targetSessionId
    || Number(participant.sessionGeneration) !== job.targetSessionGeneration) {
    throw new Error('Managed MCP participant Profile or session incarnation changed')
  }
  const user = findUserById(Number(initiator.authUserId))
  if (!user || user.status !== 'active') throw new Error('Managed MCP initiator account is inactive')
  if (user.role !== 'super_admin' && !userCanAccessProfile(user.id, requestedProfile)) {
    throw new Error(`Managed MCP Profile assignment for "${requestedProfile}" was revoked`)
  }
  return { initiator, participantActor, participant }
}

export async function issueManagedMcpCapability(storage: any, input: ManagedMcpCapabilityIssuerInput): Promise<string> {
  const job = requireRunningJob(storage, input)
  const profile = String(input.profile || '').trim()
  if (!profile) throw new Error('Managed MCP Profile assignment is required')
  const { initiator, participantActor, participant } = currentBindings(job, profile)
  const now = Date.now()
  const requestedExpiry = input.expiresAt == null ? now + DEFAULT_TTL_MS : Math.floor(Number(input.expiresAt))
  if (!Number.isFinite(requestedExpiry)) throw new Error('Managed MCP capability expiry is invalid')
  const claims: CapabilityClaims = {
    v: CAPABILITY_VERSION,
    roomId: job.roomId,
    initiatorActorId: job.initiatorActorId,
    initiatorAuthUserId: Number(initiator.authUserId),
    participantAgentId: job.targetAgentId,
    participantActorId: job.targetActorId,
    participantSessionId: participant.sessionId,
    participantSessionGeneration: Number(participant.sessionGeneration),
    profile,
    jobId: job.id,
    leaseToken: job.leaseToken,
    authorityReaderEpoch: job.authorizationReaderEpoch,
    roomAuthorizationRevision: job.roomAuthorizationRevision,
    initiatorActorAuthorizationRevision: Number(initiator.authorizationRevision),
    initiatorActorContextRevision: Number(initiator.contextRevision),
    participantActorAuthorizationRevision: Number(participantActor.authorizationRevision),
    participantActorContextRevision: Number(participantActor.contextRevision),
    serverTools: exactServerTools(input.serverTools),
    expiresAt: Math.min(requestedExpiry, job.leaseExpiresAt || requestedExpiry),
  }
  const payload = encode(claims)
  return `${payload}.${sign(payload, await capabilitySecret())}`
}

async function decodeCapability(token: string): Promise<CapabilityClaims> {
  const parts = String(token || '').split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Managed MCP capability is malformed')
  const expected = sign(parts[0], await capabilitySecret())
  if (!equalSignature(parts[1], expected)) throw new Error('Managed MCP capability signature is invalid')
  let claims: Partial<CapabilityClaims>
  try {
    claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  } catch {
    throw new Error('Managed MCP capability payload is malformed')
  }
  if (claims.v !== CAPABILITY_VERSION || !claims.roomId || !claims.initiatorActorId || !claims.participantAgentId
    || !claims.participantActorId || !claims.participantSessionId || !claims.profile || !claims.jobId || !claims.leaseToken
    || !Number.isInteger(claims.initiatorAuthUserId) || !Number.isInteger(claims.participantSessionGeneration)
    || !Number.isInteger(claims.authorityReaderEpoch) || !Number.isInteger(claims.expiresAt)
    || !claims.serverTools || typeof claims.serverTools !== 'object' || Array.isArray(claims.serverTools)) {
    throw new Error('Managed MCP capability claims are incomplete')
  }
  return claims as CapabilityClaims
}

export async function authorizeManagedMcpCapability(storage: any, input: ManagedMcpAuthorizationInput): Promise<CapabilityClaims> {
  const claims = await decodeCapability(input.token)
  const now = input.now ?? Date.now()
  if (now >= claims.expiresAt) throw new Error('Managed MCP capability expired')
  if (SERVER_TOOLSETS[input.server] !== input.toolset || !claims.serverTools[input.server]?.includes(input.tool)) {
    throw new Error('Managed MCP tool is not authorized by the exact server/tool capability')
  }
  const job = requireRunningJob(storage, {
    jobId: claims.jobId,
    leaseToken: claims.leaseToken,
    participantAgentId: claims.participantAgentId,
  })
  if (job.roomId !== claims.roomId || job.initiatorActorId !== claims.initiatorActorId
    || job.targetActorId !== claims.participantActorId || job.targetSessionId !== claims.participantSessionId
    || job.targetSessionGeneration !== claims.participantSessionGeneration
    || job.authorizationReaderEpoch !== claims.authorityReaderEpoch
    || job.roomAuthorizationRevision !== claims.roomAuthorizationRevision) {
    throw new Error('Managed MCP durable authority revision or session incarnation changed')
  }
  const { initiator, participantActor } = currentBindings(job, claims.profile)
  if (Number(initiator.authUserId) !== claims.initiatorAuthUserId
    || Number(initiator.authorizationRevision) !== claims.initiatorActorAuthorizationRevision
    || Number(initiator.contextRevision) !== claims.initiatorActorContextRevision
    || Number(participantActor.authorizationRevision) !== claims.participantActorAuthorizationRevision
    || Number(participantActor.contextRevision) !== claims.participantActorContextRevision) {
    throw new Error('Managed MCP actor authority revision changed')
  }
  return claims
}
