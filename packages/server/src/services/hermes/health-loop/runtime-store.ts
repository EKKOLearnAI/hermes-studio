import { withPersonalTwinDb } from '../personal-twin/database'

const TOPICS = ['twin.observation.recorded', 'twin.event.recorded'] as const

export interface HealthOutboxClaim {
  consumerId: string
  workerId: string
  outboxId: string
  topic: typeof TOPICS[number]
  aggregateId: string
  payloadJson: string
  attempt: number
  leaseUntil: string
  preparedJson: string | null
  preparedDigest: string | null
  preparedAt: string | null
}

interface ClaimOptions {
  consumerId: string
  workerId: string
  now: string
  leaseMs: number
  maxAttempts: number
}

export function claimHealthOutboxDelivery(options: ClaimOptions): HealthOutboxClaim | null {
  validateId(options.consumerId, 100)
  validateId(options.workerId, 100)
  const now = timestamp(options.now)
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1 || options.leaseMs > 300_000
    || !Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 16) {
    throw new Error('HEALTH_RUNTIME_CLAIM_INVALID')
  }
  return withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare(`SELECT o.id,o.topic,o.aggregate_id,o.payload_json,
        d.status,d.attempts,d.lease_until,d.prepared_json,d.prepared_digest,d.prepared_at
        FROM twin_outbox o LEFT JOIN twin_health_outbox_deliveries d
          ON d.consumer_id=? AND d.outbox_id=o.id
        WHERE o.topic IN (?,?) AND o.available_at<=?
          AND (d.outbox_id IS NULL OR (d.status='leased' AND d.lease_until<=? AND d.attempts<?))
        ORDER BY o.available_at,o.created_at,o.id LIMIT 1`).get(
        options.consumerId, TOPICS[0], TOPICS[1], now, now, options.maxAttempts,
      ) as { id:string; topic:typeof TOPICS[number]; aggregate_id:string; payload_json:string;
        status:string|null; attempts:number|null; lease_until:string|null;prepared_json:string|null;
        prepared_digest:string|null;prepared_at:string|null } | undefined
      if (!row) { db.exec('COMMIT'); return null }
      const attempt = (row.attempts ?? 0) + 1
      const leaseUntil = new Date(Date.parse(now) + options.leaseMs).toISOString()
      if (row.status === null) {
        db.prepare(`INSERT INTO twin_health_outbox_deliveries
          (consumer_id,outbox_id,status,attempts,lease_owner,lease_until,last_error_code,intent_id,workflow_id,completed_at)
          VALUES(?,?,'leased',?,?,?,NULL,NULL,NULL,NULL)`).run(
          options.consumerId, row.id, attempt, options.workerId, leaseUntil,
        )
      } else {
        const changed = db.prepare(`UPDATE twin_health_outbox_deliveries
          SET attempts=?,lease_owner=?,lease_until=?,last_error_code=NULL
          WHERE consumer_id=? AND outbox_id=? AND status='leased' AND lease_until<=? AND attempts=?`).run(
          attempt, options.workerId, leaseUntil, options.consumerId, row.id, now, attempt - 1,
        )
        if (changed.changes !== 1) throw new Error('HEALTH_RUNTIME_CLAIM_CONFLICT')
      }
      db.exec('COMMIT')
      return { consumerId: options.consumerId, workerId: options.workerId, outboxId: row.id,
        topic: row.topic, aggregateId: row.aggregate_id, payloadJson: row.payload_json, attempt, leaseUntil,
        preparedJson:row.prepared_json??null,preparedDigest:row.prepared_digest??null,preparedAt:row.prepared_at??null }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  })
}

export function prepareHealthOutboxDelivery(claim:HealthOutboxClaim,material:{json:string;digest:string},preparedAt:string):void {
  validateClaim(claim)
  const at=timestamp(preparedAt)
  if(typeof material.json!=='string'||Buffer.byteLength(material.json,'utf8')>1_048_576
    ||!/^[a-f0-9]{64}$/.test(material.digest))throw new Error('HEALTH_RUNTIME_PREPARED_INVALID')
  withPersonalTwinDb(db=>{
    const changed=db.prepare(`UPDATE twin_health_outbox_deliveries SET prepared_json=?,prepared_digest=?,prepared_at=?
      WHERE consumer_id=? AND outbox_id=? AND status='leased' AND lease_owner=? AND attempts=? AND prepared_json IS NULL`).run(
      material.json,material.digest,at,claim.consumerId,claim.outboxId,claim.workerId,claim.attempt)
    if(changed.changes!==1)throw new Error('HEALTH_RUNTIME_LEASE_LOST')
  })
}

export function completeHealthOutboxDelivery(
  claim: HealthOutboxClaim,
  result: { intentId: string | null; workflowId: string | null },
  completedAt: string,
): void {
  validateClaim(claim)
  if ((result.intentId === null) !== (result.workflowId === null)) throw new Error('HEALTH_RUNTIME_RESULT_INVALID')
  if (result.intentId) { validateId(result.intentId, 200); validateId(result.workflowId!, 200) }
  const at = timestamp(completedAt)
  withPersonalTwinDb(db => {
    const changed = db.prepare(`UPDATE twin_health_outbox_deliveries SET status='completed',lease_owner=NULL,
      lease_until=NULL,last_error_code=NULL,intent_id=?,workflow_id=?,completed_at=?
      WHERE consumer_id=? AND outbox_id=? AND status='leased' AND lease_owner=? AND attempts=?`).run(
      result.intentId, result.workflowId, at, claim.consumerId, claim.outboxId, claim.workerId, claim.attempt,
    )
    if (changed.changes !== 1) throw new Error('HEALTH_RUNTIME_LEASE_LOST')
  })
}

export function failHealthOutboxDelivery(
  claim: HealthOutboxClaim,
  error: unknown,
  now: string,
  maxAttempts: number,
): void {
  validateClaim(claim)
  const at = timestamp(now)
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 16) throw new Error('HEALTH_RUNTIME_CLAIM_INVALID')
  const code = stableErrorCode(error)
  withPersonalTwinDb(db => {
    const terminal = claim.attempt >= maxAttempts
    const changed = db.prepare(`UPDATE twin_health_outbox_deliveries
      SET status=?,lease_owner=NULL,lease_until=?,last_error_code=?,completed_at=?
      WHERE consumer_id=? AND outbox_id=? AND status='leased' AND lease_owner=? AND attempts=?`).run(
      terminal ? 'dead_letter' : 'leased', terminal ? null : at, code, terminal ? at : null,
      claim.consumerId, claim.outboxId, claim.workerId, claim.attempt,
    )
    if (changed.changes !== 1) throw new Error('HEALTH_RUNTIME_LEASE_LOST')
  })
}

function validateClaim(value: HealthOutboxClaim): void {
  if (!value || typeof value !== 'object') throw new Error('HEALTH_RUNTIME_CLAIM_INVALID')
  validateId(value.consumerId, 100); validateId(value.workerId, 100); validateId(value.outboxId, 200)
  if (!TOPICS.includes(value.topic) || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 16) {
    throw new Error('HEALTH_RUNTIME_CLAIM_INVALID')
  }
}

function validateId(value: string, maximum: number): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error('HEALTH_RUNTIME_IDENTIFIER_INVALID')
}

function timestamp(value: string): string {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(milliseconds)) throw new Error('HEALTH_RUNTIME_TIMESTAMP_INVALID')
  return new Date(milliseconds).toISOString()
}

function stableErrorCode(error: unknown): string {
  const candidate = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(candidate) ? candidate : 'HEALTH_RUNTIME_PROCESSING_FAILED'
}
