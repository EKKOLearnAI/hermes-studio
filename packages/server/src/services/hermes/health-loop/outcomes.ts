import type { DatabaseSync } from 'node:sqlite'
import { stableTwinId, upsertTwinEntity } from '../personal-twin/store'
import { withPersonalTwinDb } from '../personal-twin/database'

export const HEALTH_OUTCOMES = ['completed','partial','skipped','deferred','adverse_feedback',
  'unsuitable','data_incorrect','expired'] as const
export type HealthOutcome = typeof HEALTH_OUTCOMES[number]

export interface HealthRuntimeActionInput {
  actionId:string; interventionId:string; workflowId:string; userId:string; capabilityId:string
  category:'training'|'recovery'|'nutrition'|'posture'|'skin'|'internal_health'; supersedable:boolean
  priority:number; risk:'none'|'low'|'medium'|'high'|'critical'; authority:'auto'|'approval'|'inform_only'
  sourceOutboxId:string; effectiveDate:string; supersedes:readonly string[]; createdAt?:string
}
export interface RecordHealthOutcomeInput {
  feedbackId:string; outcome:HealthOutcome; actionId:string; interventionId:string
  workflowId:string; userId:string; occurredAt:string
}
export interface RecordedHealthOutcome extends RecordHealthOutcomeInput {
  reviewRequired:boolean
  supersededActionIds:string[]
}

export function registerHealthRuntimeAction(input: HealthRuntimeActionInput): void {
  validateAction(input)
  upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
  const createdAt = timestamp(input.createdAt ?? new Date().toISOString())
  withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
    const inserted = db.prepare(`INSERT INTO twin_health_actions
      (action_id,intervention_id,workflow_id,user_id,capability_id,category,priority,supersedable,risk,authority,source_outbox_id,
        effective_date,status,created_at,superseded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'active',?,NULL) ON CONFLICT(action_id) DO NOTHING`).run(
      input.actionId,input.interventionId,input.workflowId,input.userId,input.capabilityId,input.category,input.priority,input.supersedable?1:0,
      input.risk,input.authority,input.sourceOutboxId,input.effectiveDate,createdAt,
    )
    const existing = db.prepare('SELECT * FROM twin_health_actions WHERE action_id=?').get(input.actionId) as unknown as ActionRow
    if (!existing || existing.intervention_id !== input.interventionId || existing.workflow_id !== input.workflowId
      || existing.user_id !== input.userId || existing.capability_id !== input.capabilityId
      || existing.category !== input.category || existing.supersedable !== (input.supersedable?1:0)
      || existing.source_outbox_id !== input.sourceOutboxId || existing.effective_date !== input.effectiveDate
      || existing.priority !== input.priority || existing.risk !== input.risk || existing.authority !== input.authority) {
      throw new Error('HEALTH_ACTION_MATERIAL_CONFLICT')
    }
    if (inserted.changes===1&&input.supersedes.length) {
      const targets=db.prepare(`SELECT action_id FROM twin_health_actions WHERE status='active' AND action_id IN
        (${input.supersedes.map(()=>'?').join(',')}) ORDER BY action_id`).all(...input.supersedes) as Array<{action_id:string}>
      if(targets.length!==input.supersedes.length||targets.some((row,index)=>row.action_id!==[...input.supersedes].sort()[index])) {
        throw new Error('HEALTH_ACTION_SUPERSESSION_CONFLICT')
      }
      db.prepare(`UPDATE twin_health_actions SET status='superseded',superseded_at=? WHERE action_id IN
        (${input.supersedes.map(()=>'?').join(',')}) AND status='active'`).run(createdAt,...input.supersedes)
    }
    void inserted
    db.exec('COMMIT')
    } catch(error) { db.exec('ROLLBACK'); throw error }
  })
}

export function recordHealthOutcome(input: RecordHealthOutcomeInput): RecordedHealthOutcome {
  validateOutcome(input)
  const occurredAt = timestamp(input.occurredAt)
  return withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const action = db.prepare('SELECT * FROM twin_health_actions WHERE action_id=?').get(input.actionId) as ActionRow | undefined
      if (!action || action.intervention_id !== input.interventionId || action.workflow_id !== input.workflowId
        || action.user_id !== input.userId) throw new Error('HEALTH_OUTCOME_BINDING_MISMATCH')
      const prior = db.prepare(`SELECT event_type,payload_json,occurred_at FROM twin_events
        WHERE source='health-outcome' AND source_id=? AND event_type LIKE 'health.outcome.%'`).get(input.feedbackId) as
        {event_type:string;payload_json:string;occurred_at:string}|undefined
      if (prior) {
        const replay = parseOutcomePayload(prior.payload_json, prior.event_type, prior.occurred_at, input.feedbackId)
        if (!sameOutcome(replay, { ...input, occurredAt })) throw new Error('HEALTH_OUTCOME_IDEMPOTENCY_CONFLICT')
        db.exec('COMMIT')
        return replay
      }
      const superseded = input.outcome === 'adverse_feedback'
        ? (db.prepare(`SELECT action_id FROM twin_health_actions WHERE user_id=? AND status='active'
            AND action_id<>? AND priority<? AND supersedable=1 AND risk IN ('none','low') AND authority<>'inform_only'
            AND capability_id IN ('health.followup.schedule','health.checkin.request','health.plan.adjust') ORDER BY action_id`)
          .all(input.userId,input.actionId,action.priority) as Array<{action_id:string}>)
          .map(row => row.action_id)
        : []
      if (superseded.length) {
        const placeholders = superseded.map(() => '?').join(',')
        db.prepare(`UPDATE twin_health_actions SET status='superseded',superseded_at=?
          WHERE action_id IN (${placeholders}) AND status='active'`).run(occurredAt,...superseded)
      }
      db.prepare(`UPDATE twin_health_actions SET status='completed' WHERE action_id=? AND status='active'`).run(input.actionId)
      const result: RecordedHealthOutcome = { ...input, occurredAt,
        reviewRequired: input.outcome === 'adverse_feedback' || input.outcome === 'data_incorrect',
        supersededActionIds: superseded }
      appendEvent(db, `health.outcome.${input.outcome}`, input.feedbackId, input.userId,
        outcomePayload(result), occurredAt)
      appendEvent(db, 'health.strategy.recomputed', `${input.feedbackId}-strategy`, input.userId,
        strategyPayload(input.outcome,input.actionId),occurredAt)
      if (input.outcome === 'adverse_feedback') appendEvent(db, 'health.review.requested',
        `${input.feedbackId}-review`, input.userId, { schemaVersion:1, actionId:input.actionId,
          interventionId:input.interventionId, reasonCode:'adverse_feedback', priority:'safety' }, occurredAt)
      if (input.outcome === 'data_incorrect') appendEvent(db, 'health.correction.requested',
        `${input.feedbackId}-correction`, input.userId, { schemaVersion:1, actionId:input.actionId,
          interventionId:input.interventionId, reasonCode:'source_data_reported_incorrect' }, occurredAt)
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  })
}

function strategyPayload(outcome:HealthOutcome,actionId:string):Record<string,unknown>{
  const strategy:Record<HealthOutcome,string>={completed:'standard',partial:'simplify',skipped:'reduce_frequency',
    deferred:'respect_deferral',adverse_feedback:'pause_for_safe_review',unsuitable:'seek_non_medical_alternative',
    data_incorrect:'await_correction_review',expired:'reduce_frequency'}
  return {schemaVersion:1,actionId,outcome,strategy:strategy[outcome],safetyPolicy:'unchanged',riskPolicy:'unchanged'}
}

function appendEvent(db: DatabaseSync, eventType:string, sourceId:string, actor:string,
  payload:Record<string,unknown>, occurredAt:string): void {
  const id = stableTwinId('event', ['health-outcome',sourceId,eventType])
  db.prepare(`INSERT INTO twin_events
    (id,event_type,subject_id,payload_json,occurred_at,ingested_at,source,source_id,actor,confidence,
      confirmation_state,evidence_json,schema_version)
    VALUES(?,?,'person:self',?,?,?,'health-outcome',?,?,1,'reported','[]',1)`).run(
    id,eventType,JSON.stringify(payload),occurredAt,occurredAt,sourceId,actor,
  )
  db.prepare(`INSERT INTO twin_outbox(id,topic,aggregate_id,payload_json,status,available_at,created_at)
    VALUES(?,'twin.event.recorded',?,?,'pending',?,?)`).run(
    stableTwinId('outbox',['twin.event.recorded',id]),id,
    JSON.stringify({recordId:id,eventType,source:'health-outcome',sourceId}),occurredAt,occurredAt,
  )
}

function outcomePayload(value:RecordedHealthOutcome): Record<string,unknown> {
  return { schemaVersion:1,outcome:value.outcome,actionId:value.actionId,interventionId:value.interventionId,
    workflowId:value.workflowId,userId:value.userId,reviewRequired:value.reviewRequired,
    supersededActionIds:value.supersededActionIds }
}
function parseOutcomePayload(payloadJson:string,eventType:string,occurredAt:string,feedbackId:string): RecordedHealthOutcome {
  let value:unknown
  try { value=JSON.parse(payloadJson) } catch { throw new Error('HEALTH_OUTCOME_CORRUPT') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HEALTH_OUTCOME_CORRUPT')
  const p=value as Record<string,unknown>; const outcome=eventType.slice('health.outcome.'.length) as HealthOutcome
  if (!HEALTH_OUTCOMES.includes(outcome) || p.outcome!==outcome || !Array.isArray(p.supersededActionIds)
    || p.supersededActionIds.some(item=>typeof item!=='string') || typeof p.reviewRequired!=='boolean') throw new Error('HEALTH_OUTCOME_CORRUPT')
  return { feedbackId,outcome,actionId:String(p.actionId),interventionId:String(p.interventionId),
    workflowId:String(p.workflowId),userId:String(p.userId),occurredAt,
    reviewRequired:p.reviewRequired,supersededActionIds:p.supersededActionIds as string[] }
}
function sameOutcome(left:RecordedHealthOutcome,right:RecordHealthOutcomeInput):boolean {
  return left.feedbackId===right.feedbackId && left.outcome===right.outcome && left.actionId===right.actionId
    && left.interventionId===right.interventionId && left.workflowId===right.workflowId
    && left.userId===right.userId && left.occurredAt===right.occurredAt
}

interface ActionRow { action_id:string;intervention_id:string;workflow_id:string;user_id:string;capability_id:string;
  category:string;priority:number;supersedable:number;risk:string;authority:string;source_outbox_id:string;effective_date:string }
function validateAction(input:HealthRuntimeActionInput):void {
  validateId(input.actionId,160);validateId(input.interventionId,160);validateId(input.workflowId,200)
  validateId(input.userId,160);validateId(input.capabilityId,160);validateId(input.sourceOutboxId,200)
  if (!Number.isSafeInteger(input.priority)||input.priority<0||input.priority>10000
    || !['training','recovery','nutrition','posture','skin','internal_health'].includes(input.category)
    || typeof input.supersedable!=='boolean'
    || !Array.isArray(input.supersedes)||input.supersedes.length>256||new Set(input.supersedes).size!==input.supersedes.length
    || input.supersedes.some(id=>{try{validateId(id,160);return false}catch{return true}})
    || !['none','low','medium','high','critical'].includes(input.risk)
    || !['auto','approval','inform_only'].includes(input.authority)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.effectiveDate)) {
    throw new Error('HEALTH_ACTION_INVALID')
  }
}
function validateOutcome(input:RecordHealthOutcomeInput):void {
  if (!input||typeof input!=='object'||!HEALTH_OUTCOMES.includes(input.outcome)) throw new Error('HEALTH_OUTCOME_INVALID')
  validateId(input.feedbackId,160);validateId(input.actionId,160);validateId(input.interventionId,160)
  validateId(input.workflowId,200);validateId(input.userId,160)
}
function validateId(value:string,maximum:number):void {
  if(typeof value!=='string'||value.length<1||value.length>maximum||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error('HEALTH_OUTCOME_INVALID')
  }
}
function timestamp(value:string):string { const t=Date.parse(value);if(!Number.isFinite(t))throw new Error('HEALTH_OUTCOME_INVALID');return new Date(t).toISOString() }
