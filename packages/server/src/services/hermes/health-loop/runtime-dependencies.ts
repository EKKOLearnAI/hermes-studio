import { createHash } from 'crypto'
import { withPersonalTwinDb } from '../personal-twin/database'
import { ingestHealthEnvelope } from './ingestion'
import { createHealthArtifactVault } from './artifacts'
import { createStructuredHealthAnalyzer } from './analyzers/structured'
import { createHealthStateConnector } from './connectors/health-state'
import { createS400HealthConnector } from './connectors/s400'
import type { HealthConnector } from './connectors'
import type { HealthSourceService, HealthSourceSyncResult } from './executors/source'
import type { HealthPlanRepository, HealthPlanSnapshot, HealthFollowupRecord } from './executors/plan'
import type { HealthAnalysisArtifactResolver, HealthAnalysisResultWriter, HealthAnalysisResultWriteRequest,
  PersistedHealthAnalysisResult, HealthExecutorAnalyzer } from './executors/analysis'
import type { HealthAnalysisRequest } from './analysis'

type LedgerKind='source'|'plan'|'followup'|'analysis'
interface LedgerRow {execution_token:string;material_digest:string;kind:LedgerKind;result_json:string}

export function createDurableHealthSourceService(profile='default', provided?:readonly HealthConnector[]):HealthSourceService {
  const available=provided??[createHealthStateConnector({profile}),createS400HealthConnector({profile})]
  const connectors=new Map<string,HealthConnector>(available.map(connector=>[connector.id,connector]))
  return {
    async lookup(token,digest){return readLedger<HealthSourceSyncResult>(token,digest,'source')},
    async write(request){
      const prior=readLedger<HealthSourceSyncResult>(request.executionToken,request.materialDigest,'source')
      if(prior)return prior
      const connector=connectors.get(request.connectorId)
      if(!connector)throw new Error('HEALTH_SOURCE_CONNECTOR_NOT_CONFIGURED')
      const status=await connector.status()
      if(!status.configured||!['authorized','not_required'].includes(status.authorizationState)) {
        throw new Error('HEALTH_SOURCE_CONNECTOR_NOT_AUTHORIZED')
      }
      const batch=await connector.sync({...(request.cursor?{cursor:request.cursor}:{}),now:request.requestedAt})
      const result:HealthSourceSyncResult={executionToken:request.executionToken,materialDigest:request.materialDigest,
        connectorId:request.connectorId,requestedAt:request.requestedAt,cursor:request.cursor,
        syncId:`health-sync-${hash({connectorId:request.connectorId,token:request.executionToken})}`,
        status:batch.attemptedCount===batch.ingestedCount?'succeeded':'partial',recordIds:[]}
      writeLedger(request.executionToken,request.materialDigest,'source',result)
      return readLedger<HealthSourceSyncResult>(request.executionToken,request.materialDigest,'source')!
    },
  }
}

export function createDurableHealthPlanRepository():HealthPlanRepository {
  return {
    async read(planId){return readPlan(planId)},
    async adjust(request){return withPersonalTwinDb(db=>transaction(db,()=>{
      const prior=readLedgerInDb<{previous:HealthPlanSnapshot;current:HealthPlanSnapshot}>(db,request.executionToken,request.materialDigest,'plan')
      if(prior)return {previous:prior.previous,current:prior.current}
      const row=planRow(db,request.planId)
      if(!row||row.version!==request.expectedVersion||row.digest!==request.expectedDigest)return null
      const state=parseObject(row.state_json,'HEALTH_PLAN_CORRUPT')
      const next=applyPlanOperation(state,request.operation)
      const digest=hash(next);const version=row.version+1;const now=new Date().toISOString()
      const changed=db.prepare(`UPDATE twin_health_plans SET version=?,digest=?,state_json=?,updated_at=?
        WHERE plan_id=? AND version=? AND digest=?`).run(version,digest,JSON.stringify(next),now,row.plan_id,row.version,row.digest)
      if(changed.changes!==1)return null
      const result={previous:snapshot(row),current:{planId:row.plan_id,version,digest}}
      insertLedger(db,request.executionToken,request.materialDigest,'plan',{...result,_previousState:state},now);return result
    }))},
    async restore(request){return withPersonalTwinDb(db=>transaction(db,()=>{
      const prior=readLedgerInDb<HealthPlanSnapshot>(db,request.executionToken,request.materialDigest,'plan')
      if(prior)return prior
      const row=planRow(db,request.planId)
      if(!row||row.version!==request.expectedCurrentVersion||row.digest!==request.expectedCurrentDigest)return null
      const historical=db.prepare(`SELECT result_json FROM twin_health_executor_ledger WHERE kind='plan'
        AND json_extract(result_json,'$.previous.planId')=?
        AND json_extract(result_json,'$.previous.version')=?
        AND json_extract(result_json,'$.previous.digest')=? ORDER BY created_at LIMIT 1`).get(
        request.planId,request.restoreVersion,request.restoreDigest) as {result_json:string}|undefined
      if(!historical)return null
      const ledger=parseObject(historical.result_json,'HEALTH_PLAN_LEDGER_CORRUPT') as unknown as {previous:HealthPlanSnapshot}
      const stateRow=db.prepare(`SELECT result_json FROM twin_health_executor_ledger WHERE kind='plan'
        AND json_extract(result_json,'$.previous.digest')=? LIMIT 1`).get(request.restoreDigest) as {result_json:string}|undefined
      void stateRow
      // The prior state itself is retained in the adjustment ledger under the private `_previousState` field.
      const previousState=(parseObject(historical.result_json,'HEALTH_PLAN_LEDGER_CORRUPT') as Record<string,unknown>)._previousState
      if(!plain(previousState)||hash(previousState)!==request.restoreDigest||ledger.previous.version!==request.restoreVersion)return null
      const now=new Date().toISOString()
      const changed=db.prepare(`UPDATE twin_health_plans SET version=?,digest=?,state_json=?,updated_at=?
        WHERE plan_id=? AND version=? AND digest=?`).run(request.restoreVersion,request.restoreDigest,
        JSON.stringify(previousState),now,request.planId,request.expectedCurrentVersion,request.expectedCurrentDigest)
      if(changed.changes!==1)return null
      const result={planId:request.planId,version:request.restoreVersion,digest:request.restoreDigest}
      insertLedger(db,request.executionToken,request.materialDigest,'plan',result,now);return result
    }))},
    async scheduleFollowup(request){return withPersonalTwinDb(db=>transaction(db,()=>{
      const prior=readLedgerInDb<HealthFollowupRecord>(db,request.executionToken,request.materialDigest,'followup')
      if(prior)return prior
      const existing=db.prepare('SELECT * FROM twin_health_followups WHERE followup_id=?').get(request.followupId) as
        {followup_id:string;owner_user_id:string;category:string;operation:string;reason_code:string;due_at:string;scheduled_at:string;status:HealthFollowupRecord['status']}|undefined
      if(existing){if(existing.owner_user_id!==request.ownerUserId||existing.category!==request.category||existing.operation!==request.operation
        ||existing.reason_code!==request.reasonCode||existing.due_at!==request.dueAt)throw new Error('HEALTH_FOLLOWUP_CONFLICT')
        const result={followupId:existing.followup_id,scheduledAt:existing.scheduled_at,status:existing.status}
        insertLedger(db,request.executionToken,request.materialDigest,'followup',result,new Date().toISOString());return result}
      const now=new Date().toISOString();db.prepare(`INSERT INTO twin_health_followups
        (followup_id,owner_user_id,category,operation,reason_code,due_at,scheduled_at,status)
        VALUES(?,?,?,?,?,?,?,'scheduled')`).run(request.followupId,request.ownerUserId,request.category,
        request.operation,request.reasonCode,request.dueAt,now)
      const result:HealthFollowupRecord={followupId:request.followupId,scheduledAt:now,status:'scheduled'}
      insertLedger(db,request.executionToken,request.materialDigest,'followup',result,now);return result
    }))},
    async readFollowup(id){return withPersonalTwinDb(db=>{const row=db.prepare('SELECT followup_id,scheduled_at,status FROM twin_health_followups WHERE followup_id=?').get(id) as
      {followup_id:string;scheduled_at:string;status:HealthFollowupRecord['status']}|undefined
      return row?{followupId:row.followup_id,scheduledAt:row.scheduled_at,status:row.status}:null})},
  }
}

export function createDurableHealthAnalysisServices(profile='default'):{artifactResolver:HealthAnalysisArtifactResolver;
  resultWriter:HealthAnalysisResultWriter;localAnalyzer:HealthExecutorAnalyzer} {
  const vault=createHealthArtifactVault();const structured=createStructuredHealthAnalyzer()
  const artifactResolver:HealthAnalysisArtifactResolver={async resolve(artifactId){const artifact=artifactRow(artifactId)
    return artifact?{artifactId,manifestDigest:artifactManifestDigest(artifact)}:null}}
  const localAnalyzer:HealthExecutorAnalyzer={async analyze(request){const artifact=artifactRow(request.artifactId)
    if(!artifact||artifactManifestDigest(artifact)!==request.manifestDigest)throw new Error('HEALTH_ANALYSIS_ARTIFACT_MISMATCH')
    const metadata=parseObject(artifact.metadata_json,'HEALTH_ANALYSIS_METADATA_INVALID')
    const spec=parseAnalysisSpec(metadata.healthAnalysis);const read=await vault.read(request.artifactId)
    const analysisRequest:HealthAnalysisRequest={schemaVersion:'health-analysis-request/v1',profile,purpose:spec.purpose,
      sourceId:`fabric.${request.artifactId}`,observedAt:request.requestedAt,artifactIds:[request.artifactId],
      selectedRegions:spec.selectedRegions,requestedFields:spec.requestedFields}
    return {result:await structured.analyze({request:analysisRequest,format:spec.format,content:read.content})}}}
  const resultWriter:HealthAnalysisResultWriter={
    async lookup(token,digest){return readLedger<PersistedHealthAnalysisResult>(token,digest,'analysis')},
    async write(request){const prior=readLedger<PersistedHealthAnalysisResult>(request.executionToken,request.materialDigest,'analysis')
      if(prior)return prior
      const observationIds=request.result.envelope?[...ingestHealthEnvelope(request.result.envelope).observations.map(item=>item.id)]:[]
      const status=request.result.status==='completed'?'succeeded':request.result.status==='recapture_required'?'needs_review':'needs_review'
      const stored:PersistedHealthAnalysisResult={executionToken:request.executionToken,materialDigest:request.materialDigest,
        artifactId:request.artifactId,manifestDigest:request.manifestDigest,processorId:request.processorId,
        reservationId:request.reservationId,requestedAt:request.requestedAt,
        analysisId:`health-analysis-${hash({token:request.executionToken,digest:request.materialDigest})}`,
        status,observationIds,processorReceiptId:request.processorReceiptId,
        verificationStatus:request.processorId===null||request.processorReceiptId!==null?'verified':'unverifiable'}
      writeLedger(request.executionToken,request.materialDigest,'analysis',stored)
      return readLedger<PersistedHealthAnalysisResult>(request.executionToken,request.materialDigest,'analysis')!},
  }
  return {artifactResolver,resultWriter,localAnalyzer}
}

function applyPlanOperation(state:Record<string,unknown>,operation:Record<string,unknown>):Record<string,unknown>{
  const next=JSON.parse(JSON.stringify(state)) as Record<string,unknown>
  if(operation.operation==='reduce_training_intensity')next.trainingIntensity=operation.maximumIntensity
  else if(operation.operation==='prioritize_food_protein')next.proteinTargetG=operation.targetG
  else if(operation.operation==='reduce_constrained_chain_load')next.trainingChains=operation.chains
  else if(operation.operation==='review_energy_deficit')next.energyDeficitReviewRequired=true
  else throw new Error('HEALTH_PLAN_OPERATION_INVALID')
  return next
}
interface PlanRow{plan_id:string;version:number;digest:string;state_json:string}
function planRow(db:import('node:sqlite').DatabaseSync,id:string):PlanRow|undefined{return db.prepare('SELECT * FROM twin_health_plans WHERE plan_id=?').get(id) as PlanRow|undefined}
function readPlan(id:string):HealthPlanSnapshot|null{return withPersonalTwinDb(db=>{const row=planRow(db,id);return row?snapshot(row):null})}
function snapshot(row:PlanRow):HealthPlanSnapshot{return {planId:row.plan_id,version:row.version,digest:row.digest}}
function artifactRow(id:string):{id:string;media_type:string;content_hash:string;relative_path:string;size_bytes:number;metadata_json:string}|null{
  return withPersonalTwinDb(db=>(db.prepare(`SELECT id,media_type,content_hash,relative_path,size_bytes,metadata_json
    FROM twin_artifacts WHERE id=?`).get(id) as never)??null)}
function artifactManifestDigest(row:{id:string;media_type:string;content_hash:string;relative_path:string;size_bytes:number}):string{
  return hash({schemaVersion:1,artifactId:row.id,mediaType:row.media_type,contentHash:row.content_hash,
    relativePath:row.relative_path,sizeBytes:row.size_bytes})}
function parseAnalysisSpec(value:unknown):{purpose:HealthAnalysisRequest['purpose'];selectedRegions:string[];requestedFields:string[];format:'json'|'csv'|'report_text'}{
  if(!plain(value)||Object.keys(value).sort().join(',')!=='format,purpose,requestedFields,selectedRegions'
    ||!['measurement','posture','skin','diet','internal_health'].includes(String(value.purpose))
    ||!['json','csv','report_text'].includes(String(value.format))||!Array.isArray(value.selectedRegions)||!Array.isArray(value.requestedFields)
    ||value.selectedRegions.length>32||value.requestedFields.length<1||value.requestedFields.length>128
    ||new Set(value.selectedRegions).size!==value.selectedRegions.length||new Set(value.requestedFields).size!==value.requestedFields.length
    ||[...value.selectedRegions,...value.requestedFields].some(item=>typeof item!=='string'||item.length<1||item.length>180))throw new Error('HEALTH_ANALYSIS_METADATA_INVALID')
  return value as never
}
function readLedger<T>(token:string,digest:string,kind:LedgerKind):T|null{return withPersonalTwinDb(db=>readLedgerInDb<T>(db,token,digest,kind))}
function readLedgerInDb<T>(db:import('node:sqlite').DatabaseSync,token:string,digest:string,kind:LedgerKind):T|null{
  const row=db.prepare('SELECT * FROM twin_health_executor_ledger WHERE execution_token=?').get(token) as LedgerRow|undefined
  if(!row)return null
  if(row.material_digest!==digest||row.kind!==kind)throw new Error('HEALTH_EXECUTION_TOKEN_MATERIAL_CONFLICT')
  return parseObject(row.result_json,'HEALTH_EXECUTOR_LEDGER_CORRUPT') as T
}
function writeLedger(token:string,digest:string,kind:LedgerKind,result:unknown):void{withPersonalTwinDb(db=>insertLedger(db,token,digest,kind,result,new Date().toISOString()))}
function insertLedger(db:import('node:sqlite').DatabaseSync,token:string,digest:string,kind:LedgerKind,result:unknown,now:string):void{
  if(!/^[a-f0-9]{64}$/.test(digest))throw new Error('HEALTH_EXECUTOR_MATERIAL_INVALID')
  const json=stable(result);if(Buffer.byteLength(json)>524288)throw new Error('HEALTH_EXECUTOR_RESULT_INVALID')
  db.prepare(`INSERT INTO twin_health_executor_ledger(execution_token,material_digest,kind,result_json,created_at)
    VALUES(?,?,?,?,?)`).run(token,digest,kind,json,now)
}
function transaction<T>(db:import('node:sqlite').DatabaseSync,fn:()=>T):T{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}}
function parseObject(value:string,code:string):Record<string,unknown>{let parsed:unknown;try{parsed=JSON.parse(value)}catch{throw new Error(code)}if(!plain(parsed))throw new Error(code);return parsed}
function plain(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype}
function hash(value:unknown):string{return createHash('sha256').update(stable(value)).digest('hex')}
function stable(value:unknown):string{if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value)
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(plain(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;throw new Error('HEALTH_EXECUTOR_RESULT_INVALID')}
