import { createHash, createPublicKey } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isProxy } from 'node:util/types'
import { isFabricSensitiveString } from '../action-fabric/audit'
import { deviceIdFromPublicKey } from '../../system-info'
import {
  ANDROID_CAPABILITY_HEALTH,
  ANDROID_COMMAND_KINDS,
  ANDROID_COMMAND_STATUSES,
  ANDROID_NOTIFICATION_SENSITIVITY,
  ANDROID_RECEIPT_STATUSES,
  AndroidCompanionCapability,
  AndroidCompanionCommand,
  AndroidCompanionDevice,
  AndroidCompanionIdentityConflictError,
  AndroidCompanionNotFoundError,
  AndroidCompanionValidationError,
  AndroidCompanionVersionConflictError,
  AndroidExecutionReceipt,
  type AndroidCapabilityReportItem,
  type AndroidCommandStatus,
  type AndroidNotificationObservation,
  type AndroidNotificationSensitivity,
  type AndroidReceiptStatus,
} from './types'

export interface PairAndroidDeviceInput {
  deviceId: string
  installationId: string
  signingPublicKey: string
  exchangePublicKey: string
  label: string
  androidVersion: string
  appVersion: string
  initialCapabilitiesDigest: string
  pairedAt?: string
}

export interface AndroidCapabilityReportInput {
  deviceId: string
  expectedDeviceVersion: number
  revision: number
  capabilities: AndroidCapabilityReportItem[]
  reportedAt: string
}

export interface QueueAndroidCommandInput {
  id: string
  workflowId: string
  executionToken: string
  materialDigest: string
  deviceId: string
  capabilityId: string
  capabilityVersion: number
  kind: AndroidCompanionCommand['kind']
  payload: Record<string, unknown>
  expiresAt: string
}

export interface TransitionAndroidCommandInput {
  id: string
  expectedVersion: number
  status: AndroidCommandStatus
  deliverySequence?: number | null
  response?: Record<string, unknown> | null
  errorCode?: string | null
}

export interface PrepareAndroidReceiptInput {
  workflowId: string
  intentId: string
  materialDigest: string
  deviceId: string
  capabilityId: string
  capabilityVersion: number
  target: Record<string, unknown>
}

export interface TransitionAndroidReceiptInput {
  workflowId: string
  materialDigest: string
  expectedVersion: number
  status: AndroidReceiptStatus
  commandId?: string | null
  result?: Record<string, unknown> | null
  verification?: Record<string, unknown> | null
  errorCode?: string | null
}

export interface ObserveAndroidNotificationInput {
  id: string
  deviceId: string
  packageBinding: string
  notificationKeyHash: string
  category: string
  channelHash: string | null
  titleSummary: string
  textSummary: string
  sensitivity: AndroidNotificationSensitivity
  sourceSequence: number
  provenanceDigest: string
  postedAt: string
}

export interface RemoveAndroidNotificationInput {
  deviceId: string
  notificationKeyHash: string
  postedAt: string
  sourceSequence: number
  removedAt: string
}

type DeviceRow = {
  id: string; installation_id: string; signing_public_key: string; exchange_public_key: string
  signing_fingerprint: string; exchange_fingerprint: string; label: string; android_version: string
  app_version: string; state: AndroidCompanionDevice['state']; capabilities_revision: number
  capabilities_digest: string | null; last_received_sequence: number; last_sent_sequence: number
  version: number; paired_at: string; revoked_at: string | null; revocation_reason: string | null
  last_seen_at: string | null; created_at: string; updated_at: string
}

type CapabilityRow = {
  device_id: string; capability_id: string; capability_version: number; package_binding: string
  package_fingerprint: string; driver_version: string; permissions_json: string; verification_strategy: string
  health: AndroidCompanionCapability['health']; enabled: number; report_revision: number
  created_at: string; updated_at: string
}

type CommandRow = {
  id: string; workflow_id: string; execution_token: string; material_digest: string; device_id: string
  capability_id: string; capability_version: number; kind: AndroidCompanionCommand['kind']; payload_json: string
  status: AndroidCommandStatus; delivery_sequence: number | null; delivery_attempts: number
  response_json: string | null; error_code: string | null; version: number; expires_at: string
  created_at: string; updated_at: string; completed_at: string | null
}

type ReceiptRow = {
  workflow_id: string; intent_id: string; material_digest: string; device_id: string; capability_id: string
  capability_version: number; target_json: string; status: AndroidReceiptStatus; command_id: string | null
  result_json: string | null; verification_json: string | null; error_code: string | null; version: number
  created_at: string; updated_at: string; completed_at: string | null
}

type NotificationRow = {
  id: string; device_id: string; package_binding: string; notification_key_hash: string; category: string
  channel_hash: string | null; title_summary: string; text_summary: string
  sensitivity: AndroidNotificationSensitivity; source_sequence: number; provenance_digest: string
  posted_at: string; removed_at: string | null; version: number; created_at: string; updated_at: string
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const SEMANTIC_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9][a-z0-9-]*)+$/
const PACKAGE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/
const PERMISSION = /^[A-Za-z][A-Za-z0-9_.]{1,159}$/
const FORBIDDEN_RAW_CAPABILITY = /(?:^|[._:-])(?:tap|click|coordinate|selector|node|script|shell|terminal|raw|intent|url)(?:$|[._:-])/i
const SENSITIVE_KEY = /(?:auth(?:entication|orization)?|bearer|cookie|credential|password|passphrase|secret|token|api.?key|private.?key|headers?|session|selector|coordinate|node.?id|local.?path|file.?path)/i
const TERMINAL_COMMAND = new Set<AndroidCommandStatus>(['succeeded', 'failed', 'cancelled'])
const TERMINAL_RECEIPT = new Set<AndroidReceiptStatus>(['verified', 'mismatch', 'failed'])
const COMMAND_TRANSITIONS: Record<AndroidCommandStatus, readonly AndroidCommandStatus[]> = {
  queued: ['delivered', 'failed', 'cancelled'],
  delivered: ['delivered', 'acknowledged', 'succeeded', 'failed', 'unknown', 'waiting_user', 'cancelled'],
  acknowledged: ['delivered', 'succeeded', 'failed', 'unknown', 'waiting_user', 'cancelled'],
  unknown: ['delivered', 'succeeded', 'failed', 'waiting_user', 'cancelled'],
  waiting_user: ['delivered', 'cancelled'],
  succeeded: [], failed: [], cancelled: [],
}
const RECEIPT_TRANSITIONS: Record<AndroidReceiptStatus, readonly AndroidReceiptStatus[]> = {
  prepared: ['executing', 'failed', 'waiting_user'],
  executing: ['executed', 'unknown', 'failed', 'waiting_user'],
  executed: ['verifying', 'failed', 'waiting_user'],
  verifying: ['verified', 'mismatch', 'unknown', 'failed', 'waiting_user'],
  unknown: ['executing', 'verifying', 'failed', 'waiting_user'],
  waiting_user: ['executing', 'verifying', 'failed'],
  verified: [], mismatch: [], failed: [],
}

export class AndroidCompanionStore {
  constructor(private readonly database: DatabaseSync) {}

  pairDevice(input: PairAndroidDeviceInput): { disposition: 'created' | 'replayed'; device: AndroidCompanionDevice } {
    const normalized = normalizePairing(input)
    return transaction(this.database, () => {
      const byId = this.deviceRow(normalized.deviceId)
      const byInstallation = this.database.prepare(
        'SELECT * FROM android_companion_devices WHERE installation_id=?',
      ).get(normalized.installationId) as DeviceRow | undefined
      const existing = byId ?? byInstallation
      if (existing) {
        if (!sameDeviceIdentity(existing, normalized)
          || this.enrollmentCapabilitiesDigest(existing.id) !== normalized.initialCapabilitiesDigest) {
          throw new AndroidCompanionIdentityConflictError('Android companion identity changed')
        }
        if (existing.state === 'revoked') {
          throw new AndroidCompanionIdentityConflictError('Revoked Android companion cannot be paired again')
        }
        return { disposition: 'replayed', device: deviceFromRow(existing) }
      }
      const now = normalized.pairedAt
      this.database.prepare(`INSERT INTO android_companion_devices
        (id,installation_id,signing_public_key,exchange_public_key,signing_fingerprint,exchange_fingerprint,
         label,android_version,app_version,state,capabilities_revision,capabilities_digest,last_received_sequence,
         last_sent_sequence,version,paired_at,revoked_at,revocation_reason,last_seen_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'paired',0,NULL,0,0,1,?,NULL,NULL,NULL,?,?)`).run(
        normalized.deviceId, normalized.installationId, normalized.signingPublicKey, normalized.exchangePublicKey,
        normalized.signingFingerprint, normalized.exchangeFingerprint, normalized.label,
        normalized.androidVersion, normalized.appVersion, now, now, now,
      )
      this.database.prepare('INSERT INTO android_companion_meta(key,value) VALUES(?,?)').run(
        enrollmentDigestKey(normalized.deviceId), normalized.initialCapabilitiesDigest,
      )
      return { disposition: 'created', device: this.requiredDevice(normalized.deviceId) }
    })
  }

  getDevice(deviceId: string): AndroidCompanionDevice | null {
    const row = this.deviceRow(deviceIdentifier(deviceId))
    return row ? deviceFromRow(row) : null
  }

  listDevices(limit = 100): AndroidCompanionDevice[] {
    return (this.database.prepare('SELECT * FROM android_companion_devices ORDER BY updated_at DESC,id LIMIT ?')
      .all(listLimit(limit)) as unknown as DeviceRow[]).map(deviceFromRow)
  }

  revokeDevice(deviceId: string, expectedVersion: number, reason: string): AndroidCompanionDevice {
    const id = deviceIdentifier(deviceId)
    const version = positiveVersion(expectedVersion)
    const reasonCode = errorCode(reason)
    return transaction(this.database, () => {
      const current = this.deviceRow(id)
      if (!current) throw new AndroidCompanionNotFoundError(`Android companion not found: ${id}`)
      if (current.state === 'revoked') {
        if (current.revocation_reason !== reasonCode) {
          throw new AndroidCompanionIdentityConflictError('Android companion revocation reason changed')
        }
        return deviceFromRow(current)
      }
      if (current.version !== version) throw new AndroidCompanionVersionConflictError('Android companion version changed')
      const now = new Date().toISOString()
      this.database.prepare(`UPDATE android_companion_devices SET state='revoked',revoked_at=?,revocation_reason=?,
        version=version+1,updated_at=? WHERE id=? AND version=?`).run(now, reasonCode, now, id, version)
      return this.requiredDevice(id)
    })
  }

  replaceCapabilityReport(input: AndroidCapabilityReportInput): {
    disposition: 'updated' | 'replayed'; device: AndroidCompanionDevice; capabilities: AndroidCompanionCapability[]
  } {
    const deviceId = deviceIdentifier(input.deviceId)
    const expectedVersion = positiveVersion(input.expectedDeviceVersion)
    const revision = positiveVersion(input.revision)
    const reportedAt = timestamp(input.reportedAt, 'Android capability report time')
    const capabilities = normalizeCapabilities(input.capabilities)
    const digest = digestAndroidCapabilityReport(capabilities)
    return transaction(this.database, () => {
      const current = this.deviceRow(deviceId)
      if (!current) throw new AndroidCompanionNotFoundError(`Android companion not found: ${deviceId}`)
      if (current.state !== 'paired') throw new AndroidCompanionValidationError('Android companion is revoked')
      if (current.capabilities_revision === 0 && this.enrollmentCapabilitiesDigest(deviceId) !== digest) {
        throw new AndroidCompanionIdentityConflictError('Initial Android capability report changed after approval')
      }
      if (current.capabilities_revision === revision && current.capabilities_digest === digest) {
        return { disposition: 'replayed', device: deviceFromRow(current), capabilities: this.listCapabilities(deviceId) }
      }
      if (current.version !== expectedVersion) throw new AndroidCompanionVersionConflictError('Android companion version changed')
      if (revision <= current.capabilities_revision) {
        throw new AndroidCompanionVersionConflictError('Android capability revision did not increase')
      }
      this.database.prepare('DELETE FROM android_companion_capabilities WHERE device_id=?').run(deviceId)
      const insert = this.database.prepare(`INSERT INTO android_companion_capabilities
        (device_id,capability_id,capability_version,package_binding,package_fingerprint,driver_version,
         permissions_json,verification_strategy,health,enabled,report_revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const capability of capabilities) {
        insert.run(deviceId, capability.capabilityId, capability.capabilityVersion, capability.packageBinding,
          capability.packageFingerprint, capability.driverVersion, JSON.stringify(capability.permissions),
          capability.verificationStrategy, capability.health, Number(capability.enabled), revision, reportedAt, reportedAt)
      }
      this.database.prepare(`UPDATE android_companion_devices SET capabilities_revision=?,capabilities_digest=?,
        version=version+1,updated_at=? WHERE id=? AND version=?`).run(revision, digest, reportedAt, deviceId, expectedVersion)
      return { disposition: 'updated', device: this.requiredDevice(deviceId), capabilities: this.listCapabilities(deviceId) }
    })
  }

  listCapabilities(deviceId: string): AndroidCompanionCapability[] {
    const id = deviceIdentifier(deviceId)
    return (this.database.prepare(`SELECT * FROM android_companion_capabilities
      WHERE device_id=? ORDER BY capability_id`).all(id) as unknown as CapabilityRow[]).map(capabilityFromRow)
  }

  observeNotification(input: ObserveAndroidNotificationInput): {
    disposition: 'created' | 'replayed'; observation: AndroidNotificationObservation
  } {
    const normalized = normalizeNotification(input)
    return transaction(this.database, () => {
      const device = this.deviceRow(normalized.deviceId)
      if (!device || device.state !== 'paired') throw invalid('Android companion is unavailable')
      const existing = (this.database.prepare('SELECT * FROM android_notification_observations WHERE id=?')
        .get(normalized.id) ?? this.database.prepare(`SELECT * FROM android_notification_observations
          WHERE device_id=? AND notification_key_hash=? AND posted_at=?`).get(
          normalized.deviceId, normalized.notificationKeyHash, normalized.postedAt,
        )) as NotificationRow | undefined
      if (existing) {
        if (!sameNotificationIdentity(existing, normalized)) {
          throw new AndroidCompanionIdentityConflictError('Android notification observation changed material')
        }
        if (normalized.sourceSequence < existing.source_sequence) {
          throw invalid('Android notification source sequence moved backwards')
        }
        if (normalized.sourceSequence > existing.source_sequence) {
          this.advanceDeviceReceivedSequence(device, normalized.sourceSequence, normalized.updatedAt)
          this.database.prepare(`UPDATE android_notification_observations SET source_sequence=?,version=version+1,
            updated_at=? WHERE id=? AND version=?`).run(
            normalized.sourceSequence, normalized.updatedAt, existing.id, existing.version,
          )
        }
        return { disposition: 'replayed', observation: this.requiredNotification(existing.id) }
      }
      this.advanceDeviceReceivedSequence(device, normalized.sourceSequence, normalized.updatedAt)
      this.database.prepare(`INSERT INTO android_notification_observations
        (id,device_id,package_binding,notification_key_hash,category,channel_hash,title_summary,text_summary,
         sensitivity,source_sequence,provenance_digest,posted_at,removed_at,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?)`).run(
        normalized.id, normalized.deviceId, normalized.packageBinding, normalized.notificationKeyHash,
        normalized.category, normalized.channelHash, normalized.titleSummary, normalized.textSummary,
        normalized.sensitivity, normalized.sourceSequence, normalized.provenanceDigest, normalized.postedAt,
        normalized.createdAt, normalized.updatedAt,
      )
      return { disposition: 'created', observation: this.requiredNotification(normalized.id) }
    })
  }

  removeNotification(input: RemoveAndroidNotificationInput): {
    disposition: 'updated' | 'replayed'; observation: AndroidNotificationObservation
  } {
    const normalized = normalizeNotificationRemoval(input)
    return transaction(this.database, () => {
      const device = this.deviceRow(normalized.deviceId)
      if (!device || device.state !== 'paired') throw invalid('Android companion is unavailable')
      const current = this.database.prepare(`SELECT * FROM android_notification_observations
        WHERE device_id=? AND notification_key_hash=? AND posted_at=?`).get(
        normalized.deviceId, normalized.notificationKeyHash, normalized.postedAt,
      ) as NotificationRow | undefined
      if (!current) throw new AndroidCompanionNotFoundError('Android notification observation was not found')
      if (current.removed_at !== null && current.removed_at !== normalized.removedAt) {
        throw new AndroidCompanionIdentityConflictError('Android notification removal time changed')
      }
      if (normalized.sourceSequence < current.source_sequence) {
        throw invalid('Android notification source sequence moved backwards')
      }
      if (normalized.sourceSequence === current.source_sequence) {
        if (current.removed_at === null) throw invalid('Android notification removal sequence was already consumed')
        return { disposition: 'replayed', observation: notificationFromRow(current) }
      }
      this.advanceDeviceReceivedSequence(device, normalized.sourceSequence, normalized.updatedAt)
      this.database.prepare(`UPDATE android_notification_observations SET removed_at=?,source_sequence=?,
        version=version+1,updated_at=? WHERE id=? AND version=?`).run(
        current.removed_at ?? normalized.removedAt, normalized.sourceSequence, normalized.updatedAt,
        current.id, current.version,
      )
      return {
        disposition: current.removed_at === null ? 'updated' : 'replayed',
        observation: this.requiredNotification(current.id),
      }
    })
  }

  getNotification(id: string): AndroidNotificationObservation | null {
    const row = this.notificationRow(identifier(id, 'Android notification observation id'))
    return row ? notificationFromRow(row) : null
  }

  listNotifications(input: { deviceId?: string; limit?: number } = {}): AndroidNotificationObservation[] {
    const limit = listLimit(input.limit ?? 100)
    const rows = input.deviceId
      ? this.database.prepare(`SELECT * FROM android_notification_observations WHERE device_id=?
          ORDER BY posted_at DESC,id LIMIT ?`).all(deviceIdentifier(input.deviceId), limit)
      : this.database.prepare(`SELECT * FROM android_notification_observations
          ORDER BY posted_at DESC,id LIMIT ?`).all(limit)
    return (rows as unknown as NotificationRow[]).map(notificationFromRow)
  }

  queueCommand(input: QueueAndroidCommandInput): {
    disposition: 'created' | 'replayed'; command: AndroidCompanionCommand
  } {
    const normalized = normalizeCommand(input)
    return transaction(this.database, () => {
      const device = this.deviceRow(normalized.deviceId)
      if (!device || device.state !== 'paired') throw new AndroidCompanionValidationError('Android companion is unavailable')
      const binding = this.database.prepare(`SELECT * FROM android_companion_capabilities
        WHERE device_id=? AND capability_id=?`).get(normalized.deviceId, normalized.capabilityId) as CapabilityRow | undefined
      if (!binding || binding.capability_version !== normalized.capabilityVersion
        || binding.enabled !== 1 || binding.health === 'unavailable') {
        throw new AndroidCompanionValidationError('Android semantic capability is unavailable')
      }
      const existing = (this.database.prepare('SELECT * FROM android_companion_commands WHERE id=?').get(normalized.id)
        ?? this.database.prepare(`SELECT * FROM android_companion_commands
          WHERE workflow_id=? AND execution_token=? AND kind=?`).get(
          normalized.workflowId, normalized.executionToken, normalized.kind,
        )) as CommandRow | undefined
      if (existing) {
        if (!sameCommandIdentity(existing, normalized)) {
          throw new AndroidCompanionIdentityConflictError('Android command changed material')
        }
        return { disposition: 'replayed', command: commandFromRow(existing) }
      }
      const now = new Date().toISOString()
      this.database.prepare(`INSERT INTO android_companion_commands
        (id,workflow_id,execution_token,material_digest,device_id,capability_id,capability_version,kind,payload_json,
         status,delivery_sequence,delivery_attempts,response_json,error_code,version,expires_at,created_at,updated_at,completed_at)
        VALUES(?,?,?,?,?,?,?,?,?,'queued',NULL,0,NULL,NULL,1,?,?,?,NULL)`).run(
        normalized.id, normalized.workflowId, normalized.executionToken, normalized.materialDigest,
        normalized.deviceId, normalized.capabilityId, normalized.capabilityVersion, normalized.kind,
        normalized.payloadJson, normalized.expiresAt, now, now,
      )
      return { disposition: 'created', command: this.requiredCommand(normalized.id) }
    })
  }

  getCommand(id: string): AndroidCompanionCommand | null {
    const row = this.commandRow(identifier(id, 'Android command id'))
    return row ? commandFromRow(row) : null
  }

  listCommands(options: { deviceId?: string; workflowId?: string; status?: AndroidCommandStatus; limit?: number } = {}):
  AndroidCompanionCommand[] {
    const conditions: string[] = []
    const values: Array<string | number> = []
    if (options.deviceId !== undefined) { conditions.push('device_id=?'); values.push(deviceIdentifier(options.deviceId)) }
    if (options.workflowId !== undefined) { conditions.push('workflow_id=?'); values.push(workflowIdentifier(options.workflowId)) }
    if (options.status !== undefined) {
      if (!ANDROID_COMMAND_STATUSES.includes(options.status)) throw invalid('Android command status is invalid')
      conditions.push('status=?'); values.push(options.status)
    }
    values.push(listLimit(options.limit))
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    return (this.database.prepare(`SELECT * FROM android_companion_commands ${where}
      ORDER BY updated_at DESC,id LIMIT ?`).all(...values) as unknown as CommandRow[]).map(commandFromRow)
  }

  transitionCommand(input: TransitionAndroidCommandInput): AndroidCompanionCommand {
    const id = identifier(input.id, 'Android command id')
    const expectedVersion = positiveVersion(input.expectedVersion)
    if (!ANDROID_COMMAND_STATUSES.includes(input.status)) throw invalid('Android command status is invalid')
    const sequence = input.deliverySequence == null ? null : positiveSequence(input.deliverySequence)
    const responseJson = input.response == null ? null : canonicalJson(input.response, 32_768)
    const nextError = input.errorCode == null ? null : errorCode(input.errorCode)
    return transaction(this.database, () => {
      const current = this.commandRow(id)
      if (!current) throw new AndroidCompanionNotFoundError(`Android command not found: ${id}`)
      if (current.version !== expectedVersion) throw new AndroidCompanionVersionConflictError('Android command version changed')
      if (!COMMAND_TRANSITIONS[current.status].includes(input.status)) {
        throw invalid(`Android command transition ${current.status} -> ${input.status} is invalid`)
      }
      assertCommandTransition(input.status, sequence, responseJson, nextError)
      if (sequence !== null && current.delivery_sequence !== null && sequence <= current.delivery_sequence) {
        throw invalid('Android command delivery sequence must increase')
      }
      const deliverySequence = sequence ?? current.delivery_sequence
      const deliveryAttempts = input.status === 'delivered' ? current.delivery_attempts + 1 : current.delivery_attempts
      const now = new Date().toISOString()
      this.database.prepare(`UPDATE android_companion_commands SET status=?,delivery_sequence=?,delivery_attempts=?,
        response_json=?,error_code=?,version=version+1,updated_at=?,completed_at=? WHERE id=? AND version=?`).run(
        input.status, deliverySequence, deliveryAttempts, responseJson ?? current.response_json, nextError, now,
        TERMINAL_COMMAND.has(input.status) ? now : null, id, expectedVersion,
      )
      return this.requiredCommand(id)
    })
  }

  prepareReceipt(input: PrepareAndroidReceiptInput): {
    disposition: 'created' | 'replayed'; receipt: AndroidExecutionReceipt
  } {
    const normalized = normalizeReceipt(input)
    return transaction(this.database, () => {
      const device = this.deviceRow(normalized.deviceId)
      if (!device || device.state !== 'paired') throw invalid('Android companion is unavailable')
      const binding = this.database.prepare(`SELECT * FROM android_companion_capabilities
        WHERE device_id=? AND capability_id=?`).get(normalized.deviceId, normalized.capabilityId) as CapabilityRow | undefined
      if (!binding || binding.capability_version !== normalized.capabilityVersion
        || binding.enabled !== 1 || binding.health === 'unavailable') {
        throw invalid('Android semantic capability is unavailable')
      }
      const existing = this.receiptRow(normalized.workflowId)
      if (existing) {
        if (!sameReceiptIdentity(existing, normalized)) {
          throw new AndroidCompanionIdentityConflictError('Android receipt changed material')
        }
        return { disposition: 'replayed', receipt: receiptFromRow(existing) }
      }
      const now = new Date().toISOString()
      this.database.prepare(`INSERT INTO android_execution_receipts
        (workflow_id,intent_id,material_digest,device_id,capability_id,capability_version,target_json,status,
         command_id,result_json,verification_json,error_code,version,created_at,updated_at,completed_at)
        VALUES(?,?,?,?,?,?,?,'prepared',NULL,NULL,NULL,NULL,1,?,?,NULL)`).run(
        normalized.workflowId, normalized.intentId, normalized.materialDigest, normalized.deviceId,
        normalized.capabilityId, normalized.capabilityVersion, normalized.targetJson, now, now,
      )
      return { disposition: 'created', receipt: this.requiredReceipt(normalized.workflowId) }
    })
  }

  getReceipt(workflowId: string): AndroidExecutionReceipt | null {
    const row = this.receiptRow(workflowIdentifier(workflowId))
    return row ? receiptFromRow(row) : null
  }

  transitionReceipt(input: TransitionAndroidReceiptInput): AndroidExecutionReceipt {
    const workflowId = workflowIdentifier(input.workflowId)
    const materialDigest = digest(input.materialDigest, 'Android receipt material digest')
    const expectedVersion = positiveVersion(input.expectedVersion)
    if (!ANDROID_RECEIPT_STATUSES.includes(input.status)) throw invalid('Android receipt status is invalid')
    const commandId = input.commandId == null ? null : identifier(input.commandId, 'Android command id')
    const resultJson = input.result == null ? null : canonicalJson(input.result, 32_768)
    const verificationJson = input.verification == null ? null : canonicalJson(input.verification, 32_768)
    const nextError = input.errorCode == null ? null : errorCode(input.errorCode)
    return transaction(this.database, () => {
      const current = this.receiptRow(workflowId)
      if (!current) throw new AndroidCompanionNotFoundError(`Android receipt not found: ${workflowId}`)
      if (current.material_digest !== materialDigest) throw new AndroidCompanionIdentityConflictError('Android receipt material changed')
      if (current.version !== expectedVersion) throw new AndroidCompanionVersionConflictError('Android receipt version changed')
      if (!RECEIPT_TRANSITIONS[current.status].includes(input.status)) {
        throw invalid(`Android receipt transition ${current.status} -> ${input.status} is invalid`)
      }
      if (current.command_id !== null && commandId !== null && current.command_id !== commandId) {
        throw new AndroidCompanionIdentityConflictError('Android receipt command changed')
      }
      if (commandId !== null) this.assertReceiptCommand(current, commandId)
      assertReceiptTransition(input.status, resultJson, verificationJson, nextError)
      const now = new Date().toISOString()
      this.database.prepare(`UPDATE android_execution_receipts SET status=?,command_id=?,result_json=?,
        verification_json=?,error_code=?,version=version+1,updated_at=?,completed_at=?
        WHERE workflow_id=? AND version=?`).run(
        input.status, current.command_id ?? commandId, resultJson ?? current.result_json,
        verificationJson ?? current.verification_json, nextError, now,
        TERMINAL_RECEIPT.has(input.status) ? now : null, workflowId, expectedVersion,
      )
      return this.requiredReceipt(workflowId)
    })
  }

  private assertReceiptCommand(receipt: ReceiptRow, commandId: string): void {
    const command = this.commandRow(commandId)
    if (!command || command.workflow_id !== receipt.workflow_id || command.material_digest !== receipt.material_digest
      || command.device_id !== receipt.device_id || command.capability_id !== receipt.capability_id
      || command.capability_version !== receipt.capability_version) {
      throw new AndroidCompanionIdentityConflictError('Android receipt command binding is invalid')
    }
  }

  private deviceRow(id: string): DeviceRow | null {
    return this.database.prepare('SELECT * FROM android_companion_devices WHERE id=?').get(id) as DeviceRow | undefined ?? null
  }

  private commandRow(id: string): CommandRow | null {
    return this.database.prepare('SELECT * FROM android_companion_commands WHERE id=?').get(id) as CommandRow | undefined ?? null
  }

  private receiptRow(workflowId: string): ReceiptRow | null {
    return this.database.prepare('SELECT * FROM android_execution_receipts WHERE workflow_id=?')
      .get(workflowId) as ReceiptRow | undefined ?? null
  }

  private notificationRow(id: string): NotificationRow | null {
    return this.database.prepare('SELECT * FROM android_notification_observations WHERE id=?')
      .get(id) as NotificationRow | undefined ?? null
  }

  private advanceDeviceReceivedSequence(device: DeviceRow, sequence: number, now: string): void {
    if (sequence <= device.last_received_sequence) throw invalid('Android notification source sequence is not fresh')
    this.database.prepare(`UPDATE android_companion_devices SET last_received_sequence=?,last_seen_at=?,
      version=version+1,updated_at=? WHERE id=? AND version=?`).run(sequence, now, now, device.id, device.version)
  }

  private enrollmentCapabilitiesDigest(deviceId: string): string | null {
    const row = this.database.prepare('SELECT value FROM android_companion_meta WHERE key=?')
      .get(enrollmentDigestKey(deviceId)) as { value: string } | undefined
    return row?.value ?? null
  }

  private requiredDevice(id: string): AndroidCompanionDevice {
    const row = this.deviceRow(id)
    if (!row) throw new AndroidCompanionNotFoundError(`Android companion not found: ${id}`)
    return deviceFromRow(row)
  }

  private requiredCommand(id: string): AndroidCompanionCommand {
    const row = this.commandRow(id)
    if (!row) throw new AndroidCompanionNotFoundError(`Android command not found: ${id}`)
    return commandFromRow(row)
  }

  private requiredReceipt(workflowId: string): AndroidExecutionReceipt {
    const row = this.receiptRow(workflowId)
    if (!row) throw new AndroidCompanionNotFoundError(`Android receipt not found: ${workflowId}`)
    return receiptFromRow(row)
  }

  private requiredNotification(id: string): AndroidNotificationObservation {
    const row = this.notificationRow(id)
    if (!row) throw new AndroidCompanionNotFoundError(`Android notification observation not found: ${id}`)
    return notificationFromRow(row)
  }
}

function normalizePairing(input: PairAndroidDeviceInput) {
  const signingPublicKey = publicKey(input.signingPublicKey, 'ed25519', 'Android signing public key')
  const exchangePublicKey = publicKey(input.exchangePublicKey, 'x25519', 'Android exchange public key')
  const deviceId = deviceIdentifier(input.deviceId)
  if (deviceIdFromPublicKey(signingPublicKey) !== deviceId) throw invalid('Android signing key does not match device id')
  return {
    deviceId,
    installationId: identifier(input.installationId, 'Android installation id', 160),
    signingPublicKey,
    exchangePublicKey,
    signingFingerprint: sha256(signingPublicKey),
    exchangeFingerprint: sha256(exchangePublicKey),
    label: safeText(input.label, 'Android device label', 160),
    androidVersion: safeText(input.androidVersion, 'Android version', 80),
    appVersion: safeText(input.appVersion, 'Android companion version', 80),
    initialCapabilitiesDigest: digest(input.initialCapabilitiesDigest, 'Initial Android capabilities digest'),
    pairedAt: input.pairedAt == null ? new Date().toISOString() : timestamp(input.pairedAt, 'Android paired time'),
  }
}

export function digestAndroidCapabilityReport(items: AndroidCapabilityReportItem[]): string {
  return sha256(canonicalValueJson(normalizeCapabilities(items), 65_536))
}

function normalizeCapabilities(items: AndroidCapabilityReportItem[]): AndroidCapabilityReportItem[] {
  if (!Array.isArray(items) || items.length > 128) throw invalid('Android capability report is invalid')
  const seen = new Set<string>()
  const normalized = items.map(item => {
    if (!plainRecord(item)) throw invalid('Android capability report item is invalid')
    const capabilityId = semanticId(item.capabilityId, 'Android capability id')
    if (FORBIDDEN_RAW_CAPABILITY.test(capabilityId)) throw invalid('Raw Android UI primitives are forbidden')
    if (seen.has(capabilityId)) throw invalid('Android capability report contains duplicates')
    seen.add(capabilityId)
    if (!ANDROID_CAPABILITY_HEALTH.includes(item.health)) throw invalid('Android capability health is invalid')
    if (typeof item.enabled !== 'boolean') throw invalid('Android capability enabled marker is invalid')
    if (!Array.isArray(item.permissions) || item.permissions.length > 32
      || item.permissions.some(permission => typeof permission !== 'string' || !PERMISSION.test(permission))) {
      throw invalid('Android capability permissions are invalid')
    }
    const permissions = [...new Set(item.permissions)].sort()
    return {
      capabilityId,
      capabilityVersion: positiveVersion(item.capabilityVersion),
      packageBinding: packageBinding(item.packageBinding),
      packageFingerprint: digest(item.packageFingerprint, 'Android package fingerprint'),
      driverVersion: safeText(item.driverVersion, 'Android driver version', 80),
      permissions,
      verificationStrategy: safeText(item.verificationStrategy, 'Android verification strategy', 160),
      health: item.health,
      enabled: item.enabled,
    }
  })
  return normalized.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))
}

function normalizeCommand(input: QueueAndroidCommandInput) {
  if (!ANDROID_COMMAND_KINDS.includes(input.kind)) throw invalid('Android command kind is invalid')
  const expiresAt = timestamp(input.expiresAt, 'Android command expiry')
  if (Date.parse(expiresAt) <= Date.now()) throw invalid('Android command is already expired')
  return {
    id: identifier(input.id, 'Android command id'),
    workflowId: workflowIdentifier(input.workflowId),
    executionToken: identifier(input.executionToken, 'Android execution token'),
    materialDigest: digest(input.materialDigest, 'Android command material digest'),
    deviceId: deviceIdentifier(input.deviceId),
    capabilityId: semanticId(input.capabilityId, 'Android capability id'),
    capabilityVersion: positiveVersion(input.capabilityVersion),
    kind: input.kind,
    payloadJson: canonicalJson(input.payload, 32_768),
    expiresAt,
  }
}

function normalizeReceipt(input: PrepareAndroidReceiptInput) {
  return {
    workflowId: workflowIdentifier(input.workflowId),
    intentId: intentIdentifier(input.intentId),
    materialDigest: digest(input.materialDigest, 'Android receipt material digest'),
    deviceId: deviceIdentifier(input.deviceId),
    capabilityId: semanticId(input.capabilityId, 'Android capability id'),
    capabilityVersion: positiveVersion(input.capabilityVersion),
    targetJson: canonicalJson(input.target, 32_768),
  }
}

function normalizeNotification(input: ObserveAndroidNotificationInput) {
  const id = identifier(input.id, 'Android notification observation id')
  if (id.length < 10) throw invalid('Android notification observation id is invalid')
  if (typeof input.category !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(input.category)) {
    throw invalid('Android notification category is invalid')
  }
  if (!ANDROID_NOTIFICATION_SENSITIVITY.includes(input.sensitivity)) {
    throw invalid('Android notification sensitivity is invalid')
  }
  const now = new Date().toISOString()
  return {
    id,
    deviceId: deviceIdentifier(input.deviceId),
    packageBinding: packageBinding(input.packageBinding),
    notificationKeyHash: digest(input.notificationKeyHash, 'Android notification key hash'),
    category: input.category,
    channelHash: input.channelHash === null ? null : digest(input.channelHash, 'Android notification channel hash'),
    titleSummary: boundedSummary(input.titleSummary, 'Android notification title summary', 500),
    textSummary: boundedSummary(input.textSummary, 'Android notification text summary', 1_000),
    sensitivity: input.sensitivity,
    sourceSequence: positiveSequence(input.sourceSequence),
    provenanceDigest: digest(input.provenanceDigest, 'Android notification provenance digest'),
    postedAt: timestamp(input.postedAt, 'Android notification posted time'),
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeNotificationRemoval(input: RemoveAndroidNotificationInput) {
  return {
    deviceId: deviceIdentifier(input.deviceId),
    notificationKeyHash: digest(input.notificationKeyHash, 'Android notification key hash'),
    postedAt: timestamp(input.postedAt, 'Android notification posted time'),
    sourceSequence: positiveSequence(input.sourceSequence),
    removedAt: timestamp(input.removedAt, 'Android notification removed time'),
    updatedAt: new Date().toISOString(),
  }
}

function assertCommandTransition(status: AndroidCommandStatus, sequence: number | null, response: string | null, error: string | null): void {
  if (status === 'delivered' && sequence === null) throw invalid('Delivered Android command requires a sequence')
  if (status !== 'delivered' && sequence !== null) throw invalid('Only delivery may assign an Android command sequence')
  if (status === 'succeeded' && response === null) throw invalid('Successful Android command requires a response')
  if (['failed', 'unknown', 'waiting_user'].includes(status) && error === null) {
    throw invalid('Non-terminal Android command outcome requires an error code')
  }
  if (!['failed', 'unknown', 'waiting_user'].includes(status) && error !== null) {
    throw invalid('Successful Android command transition must not include an error code')
  }
}

function assertReceiptTransition(
  status: AndroidReceiptStatus, result: string | null, verification: string | null, error: string | null,
): void {
  if (status === 'verified' && (result === null || verification === null || error !== null)) {
    throw invalid('Verified Android receipt requires result and verification without an error')
  }
  if (['mismatch', 'failed', 'unknown', 'waiting_user'].includes(status) && error === null) {
    throw invalid('Non-success Android receipt requires an error code')
  }
  if (!['mismatch', 'failed', 'unknown', 'waiting_user'].includes(status) && status !== 'verified' && error !== null) {
    throw invalid('Active Android receipt must not include an error code')
  }
}

function deviceFromRow(row: DeviceRow): AndroidCompanionDevice {
  return {
    id: row.id, installationId: row.installation_id, signingPublicKey: row.signing_public_key,
    exchangePublicKey: row.exchange_public_key, signingFingerprint: row.signing_fingerprint,
    exchangeFingerprint: row.exchange_fingerprint, label: row.label, androidVersion: row.android_version,
    appVersion: row.app_version, state: row.state, capabilitiesRevision: row.capabilities_revision,
    capabilitiesDigest: row.capabilities_digest, lastReceivedSequence: row.last_received_sequence,
    lastSentSequence: row.last_sent_sequence, version: row.version, pairedAt: row.paired_at,
    revokedAt: row.revoked_at, revocationReason: row.revocation_reason, lastSeenAt: row.last_seen_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function capabilityFromRow(row: CapabilityRow): AndroidCompanionCapability {
  return {
    deviceId: row.device_id, capabilityId: row.capability_id, capabilityVersion: row.capability_version,
    packageBinding: row.package_binding, packageFingerprint: row.package_fingerprint,
    driverVersion: row.driver_version, permissions: JSON.parse(row.permissions_json),
    verificationStrategy: row.verification_strategy, health: row.health, enabled: row.enabled === 1,
    reportRevision: row.report_revision, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function commandFromRow(row: CommandRow): AndroidCompanionCommand {
  return {
    id: row.id, workflowId: row.workflow_id, executionToken: row.execution_token,
    materialDigest: row.material_digest, deviceId: row.device_id, capabilityId: row.capability_id,
    capabilityVersion: row.capability_version, kind: row.kind, payload: JSON.parse(row.payload_json),
    status: row.status, deliverySequence: row.delivery_sequence, deliveryAttempts: row.delivery_attempts,
    response: row.response_json === null ? null : JSON.parse(row.response_json), errorCode: row.error_code,
    version: row.version, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function receiptFromRow(row: ReceiptRow): AndroidExecutionReceipt {
  return {
    workflowId: row.workflow_id, intentId: row.intent_id, materialDigest: row.material_digest,
    deviceId: row.device_id, capabilityId: row.capability_id, capabilityVersion: row.capability_version,
    target: JSON.parse(row.target_json), status: row.status, commandId: row.command_id,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    verification: row.verification_json === null ? null : JSON.parse(row.verification_json),
    errorCode: row.error_code, version: row.version, createdAt: row.created_at,
    updatedAt: row.updated_at, completedAt: row.completed_at,
  }
}

function notificationFromRow(row: NotificationRow): AndroidNotificationObservation {
  return {
    id: row.id,
    deviceId: row.device_id,
    packageBinding: row.package_binding,
    notificationKeyHash: row.notification_key_hash,
    category: row.category,
    channelHash: row.channel_hash,
    titleSummary: row.title_summary,
    textSummary: row.text_summary,
    sensitivity: row.sensitivity,
    sourceSequence: row.source_sequence,
    provenanceDigest: row.provenance_digest,
    postedAt: row.posted_at,
    removedAt: row.removed_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function sameDeviceIdentity(row: DeviceRow, value: ReturnType<typeof normalizePairing>): boolean {
  return row.id === value.deviceId && row.installation_id === value.installationId
    && row.signing_public_key === value.signingPublicKey && row.exchange_public_key === value.exchangePublicKey
}

function sameCommandIdentity(row: CommandRow, value: ReturnType<typeof normalizeCommand>): boolean {
  return row.id === value.id && row.workflow_id === value.workflowId && row.execution_token === value.executionToken
    && row.material_digest === value.materialDigest && row.device_id === value.deviceId
    && row.capability_id === value.capabilityId && row.capability_version === value.capabilityVersion
    && row.kind === value.kind && row.payload_json === value.payloadJson && row.expires_at === value.expiresAt
}

function sameReceiptIdentity(row: ReceiptRow, value: ReturnType<typeof normalizeReceipt>): boolean {
  return row.workflow_id === value.workflowId && row.intent_id === value.intentId
    && row.material_digest === value.materialDigest && row.device_id === value.deviceId
    && row.capability_id === value.capabilityId && row.capability_version === value.capabilityVersion
    && row.target_json === value.targetJson
}

function sameNotificationIdentity(row: NotificationRow, value: ReturnType<typeof normalizeNotification>): boolean {
  return row.id === value.id && row.device_id === value.deviceId && row.package_binding === value.packageBinding
    && row.notification_key_hash === value.notificationKeyHash && row.category === value.category
    && row.channel_hash === value.channelHash && row.title_summary === value.titleSummary
    && row.text_summary === value.textSummary && row.sensitivity === value.sensitivity
    && row.provenance_digest === value.provenanceDigest && row.posted_at === value.postedAt
}

function publicKey(value: unknown, type: 'ed25519' | 'x25519', label: string): string {
  if (typeof value !== 'string' || value.length < 80 || value.length > 4096) throw invalid(`${label} is invalid`)
  try {
    const key = createPublicKey(value)
    if (key.asymmetricKeyType !== type) throw new Error('wrong key type')
    const normalized = key.export({ type: 'spki', format: 'pem' }).toString()
    if (normalized !== value) throw new Error('non-canonical key')
    return normalized
  } catch {
    throw invalid(`${label} is invalid`)
  }
}

function canonicalJson(value: unknown, maxBytes: number): string {
  const normalized = normalizeJson(value, 0, new Set())
  if (!plainRecord(normalized)) throw invalid('Android companion JSON must be an object')
  return boundedJson(normalized, maxBytes)
}

function canonicalValueJson(value: unknown, maxBytes: number): string {
  const normalized = normalizeJson(value, 0, new Set())
  if (!plainRecord(normalized) && !Array.isArray(normalized)) {
    throw invalid('Android companion JSON must be an object or array')
  }
  return boundedJson(normalized, maxBytes)
}

function boundedJson(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw invalid('Android companion JSON exceeds its size limit')
  return json
}

function normalizeJson(value: unknown, depth: number, seen: Set<object>, fieldName?: string): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('Android companion JSON number is invalid')
    return value
  }
  if (typeof value === 'string') {
    const allowedDigest = !!fieldName && /(?:digest|fingerprint)$/i.test(fieldName) && /^[a-f0-9]{64}$/.test(value)
    const allowedMimeType = fieldName === 'mimeType' && /^(?:image\/png|image\/webp)$/.test(value)
    if (value.length > 4_000 || (!allowedDigest && isFabricSensitiveString(value))
      || (!allowedMimeType && /(?:^|[\\/])[A-Za-z0-9_. -]+[\\/]/.test(value))) {
      throw invalid('Android companion JSON contains sensitive data')
    }
    return value
  }
  if (value === null || typeof value !== 'object' || isProxy(value) || depth >= 6 || seen.has(value)) {
    throw invalid('Android companion JSON object is invalid')
  }
  if (!Array.isArray(value) && !plainRecord(value)) throw invalid('Android companion JSON object is invalid')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > 64) throw invalid('Android companion JSON array is too large')
      return value.map((_, index) => {
        const property = Object.getOwnPropertyDescriptor(value, String(index))
        if (!property || !('value' in property)) throw invalid('Android companion JSON accessor is forbidden')
        return normalizeJson(property.value, depth + 1, seen)
      })
    }
    const keys = Object.keys(value)
    if (keys.length > 64) throw invalid('Android companion JSON object is too large')
    const output: Record<string, unknown> = {}
    for (const key of keys.sort()) {
      if (!key || key.length > 128 || SENSITIVE_KEY.test(key)) throw invalid('Android companion JSON key is forbidden')
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (!property || !('value' in property)) throw invalid('Android companion JSON accessor is forbidden')
      output[key] = normalizeJson(property.value, depth + 1, seen, key)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function plainRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function deviceIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^hwui_[A-Za-z0-9_-]{32}$/.test(value)) throw invalid('Android device id is invalid')
  return value
}

function workflowIdentifier(value: unknown): string {
  const id = identifier(value, 'Android workflow id')
  if (!id.startsWith('workflow-')) throw invalid('Android workflow id is invalid')
  return id
}

function intentIdentifier(value: unknown): string {
  const id = identifier(value, 'Android intent id')
  if (!id.startsWith('intent-')) throw invalid('Android intent id is invalid')
  return id
}

function identifier(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || value.length > max || !IDENTIFIER.test(value)) throw invalid(`${label} is invalid`)
  return value
}

function semanticId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 160 || !SEMANTIC_ID.test(value)) throw invalid(`${label} is invalid`)
  return value
}

function packageBinding(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255 || !PACKAGE.test(value)) throw invalid('Android package binding is invalid')
  return value
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid(`${label} is invalid`)
  return value
}

function safeText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)
    || isFabricSensitiveString(value)) throw invalid(`${label} is invalid`)
  return value.trim()
}

function boundedSummary(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || isFabricSensitiveString(value)) throw invalid(`${label} is invalid`)
  return value
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalid(`${label} is invalid`)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw invalid(`${label} is invalid`)
  return value
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalid('Android companion version is invalid')
  return Number(value)
}

function positiveSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalid('Android companion sequence is invalid')
  return Number(value)
}

function errorCode(value: unknown): string {
  if (typeof value !== 'string' || !ERROR_CODE.test(value)) throw invalid('Android companion error code is invalid')
  return value
}

function listLimit(value: unknown): number {
  if (value === undefined) return 100
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid('Android companion list limit is invalid')
  return Math.min(Number(value), 500)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function enrollmentDigestKey(deviceId: string): string {
  return `pairing_capabilities_digest:${deviceId}`
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  if (database.isTransaction) return operation()
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function invalid(message: string): AndroidCompanionValidationError {
  return new AndroidCompanionValidationError(message)
}
