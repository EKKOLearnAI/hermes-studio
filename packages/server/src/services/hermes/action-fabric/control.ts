import { appendFabricAuditEvent, appendFabricOutbox, withFabricAuditedTransaction } from './audit'
import { withActionFabricDb } from './database'
import type { FabricControlState } from './types'

type ControlRow = {
  level: 0 | 1 | 2 | 3
  version: number
  actor_user_id: string | null
  reason: string
  updated_at: string
}

const MAX_ACTOR = 200
const MAX_REASON = 2_000

export function getFabricControlState(): FabricControlState {
  return withActionFabricDb(db => parseControl(db.prepare(
    'SELECT level, version, actor_user_id, reason, updated_at FROM fabric_control_state WHERE id = 1',
  ).get() as ControlRow))
}

export function setFabricEmergencyStop(
  level: 0 | 1 | 2 | 3,
  actorUserId: string,
  reason: string,
  expectedVersion?: number,
): FabricControlState {
  validateControlInput(level, actorUserId, reason, expectedVersion)
  return withFabricAuditedTransaction(db => {
    const current = db.prepare(
      'SELECT level, version, actor_user_id, reason, updated_at FROM fabric_control_state WHERE id = 1',
    ).get() as ControlRow
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new Error('FABRIC_CONTROL_VERSION_CONFLICT')
    }
    const updatedAt = new Date().toISOString()
    const nextVersion = current.version + 1
    const result = db.prepare(`
        UPDATE fabric_control_state
        SET level = ?, version = ?, actor_user_id = ?, reason = ?, updated_at = ?
        WHERE id = 1 AND version = ?
      `).run(level, nextVersion, actorUserId, reason, updatedAt, current.version)
    if (result.changes !== 1) throw new Error('FABRIC_CONTROL_VERSION_CONFLICT')
    const state: FabricControlState = { level, version: nextVersion, actorUserId, reason, updatedAt }
    appendFabricAuditEvent(db, {
      eventType: 'control.emergency_stop.changed',
      actorUserId,
      aggregateType: 'control',
      aggregateId: 'global',
      payload: { previousLevel: current.level, level, version: nextVersion, reason },
      occurredAt: updatedAt,
    })
    appendFabricOutbox(db, 'fabric.control.changed', 'global', {
      level: state.level,
      version: state.version,
      actorUserId: state.actorUserId,
      reason: state.reason,
      updatedAt: state.updatedAt,
    })
    return state
  })
}

function parseControl(row: ControlRow): FabricControlState {
  return {
    level: row.level,
    version: row.version,
    actorUserId: row.actor_user_id,
    reason: row.reason,
    updatedAt: row.updated_at,
  }
}

function validateControlInput(
  level: number,
  actorUserId: string,
  reason: string,
  expectedVersion: number | undefined,
): void {
  if (!Number.isInteger(level) || level < 0 || level > 3) throw new Error('FABRIC_CONTROL_INVALID_LEVEL')
  if (typeof actorUserId !== 'string' || actorUserId.trim().length === 0
    || actorUserId.length > MAX_ACTOR || /[\u0000-\u001f]/.test(actorUserId)) {
    throw new Error('FABRIC_CONTROL_INVALID_ACTOR')
  }
  if (typeof reason !== 'string' || reason.length > MAX_REASON || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(reason)) {
    throw new Error('FABRIC_CONTROL_INVALID_REASON')
  }
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
    throw new Error('FABRIC_CONTROL_INVALID_VERSION')
  }
}
