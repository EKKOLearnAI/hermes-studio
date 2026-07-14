import { createHash, randomUUID } from 'crypto'
import { logger } from '../../logger'
import { startActionFabricRuntime, stopActionFabricRuntime } from '../action-fabric/runtime'
import { createFabricIntent } from '../action-fabric/workflows'
import type { FabricActionIntentInput } from '../action-fabric/types'
import { withPersonalTwinDb } from '../personal-twin/database'
import type { TwinProjection } from '../personal-twin/types'
import { HEALTH_PROJECTION_KEYS } from './projectors'
import { decideHealthInterventions, type HealthActionCandidate, type HealthActiveAction,
  type HealthRecentAction } from './interventions'
import { mapHealthActionCandidateToFabric } from './fabric-intents'
import { getHealthAutomationSettings } from './settings'
import { finalizeHealthRuntimeActionReservation, registerHealthRuntimeAction, reserveHealthRuntimeAction } from './outcomes'
import { claimHealthOutboxDelivery, completeHealthOutboxDelivery, failHealthOutboxDelivery,
  prepareHealthOutboxDelivery,type HealthOutboxClaim } from './runtime-store'
import { configureHealthFabricExecutorDependencies } from './executors/configuration'
import { createDurableHealthAnalysisServices, createDurableHealthPlanRepository,
  createDurableHealthSourceService } from './runtime-dependencies'
import { createWeixinReceiptSender } from '../weixin-sender'
import { registerHealthRuntimeAuthorization, clearHealthRuntimeAuthorization } from './runtime-authorization'
import { ensureBuiltInAssistantRoles, updateAssistantRole } from '../personal-twin/assistant-roles'
import { createProductionVisionAdapter } from './production-vision'
import { createHealthConsentBroker } from './consent'
import { createAuthorizedAuxiliaryVisionExecutorAnalyzer, createHealthConsentReservationConsumer } from './executors/analysis'

export interface HealthLoopLifecycleHooks {
  prepare(): Promise<void>
  startFabric(): Promise<void>
  startConsumer(): Promise<void>
  stopConsumer(): Promise<void>
  stopFabric(): Promise<void>
}
export interface HealthLoopLifecycle { start():Promise<void>; stop():Promise<void> }

export function createHealthLoopLifecycle(hooks:HealthLoopLifecycleHooks):HealthLoopLifecycle {
  let tail=Promise.resolve();let active=false
  const queue=(operation:()=>Promise<void>)=>{const result=tail.then(operation);tail=result.catch(()=>undefined);return result}
  return {
    start:()=>queue(async()=>{if(active)return;let consumerBegun=false
      try {await hooks.prepare();await hooks.startFabric();consumerBegun=true;await hooks.startConsumer();active=true}
      catch(error){if(consumerBegun){try{await hooks.stopConsumer()}catch{}}
        try{await hooks.stopFabric()}catch{}throw error}}),
    stop:()=>queue(async()=>{if(!active)return;let failure:unknown=null
      try{await hooks.stopConsumer()}catch(error){failure=error}
      try{await hooks.stopFabric()}catch(error){if(failure===null)failure=error}finally{active=false}
      if(failure!==null)throw failure}),
  }
}

const workerId=`health-runtime-${randomUUID()}`
let timer:ReturnType<typeof setInterval>|null=null
let poll:Promise<void>|null=null
let productionProcessor:ReturnType<typeof createHealthOutboxProcessor>|null=null
let remoteProcessorIds:string[]=[]

const lifecycle=createHealthLoopLifecycle({
  async prepare(){
    const settings=getHealthAutomationSettings()
    ensureDefaultPlan(new Date().toISOString())
    const analysis=createDurableHealthAnalysisServices(settings.profile)
    const remoteVision=await createProductionVisionAdapter(settings.profile)
    remoteProcessorIds=remoteVision?[remoteVision.processorId]:[]
    configureHealthFabricExecutorDependencies({profile:settings.profile,
      sourceService:createDurableHealthSourceService(settings.profile),planRepository:createDurableHealthPlanRepository(),
      localAnalyzer:analysis.localAnalyzer,localArtifactResolver:analysis.artifactResolver,
      localResultWriter:analysis.resultWriter,remoteArtifactResolver:analysis.artifactResolver,
      remoteResultWriter:analysis.resultWriter,
      ...(remoteVision?{remoteAnalyzer:createAuthorizedAuxiliaryVisionExecutorAnalyzer(remoteVision.analyzer,settings.profile),
        remoteConsentConsumer:createHealthConsentReservationConsumer(createHealthConsentBroker({allowedProcessors:remoteProcessorIds}))}:{}),
      weixinSender:createWeixinReceiptSender(settings.profile)})
    refreshHealthRuntimeAuthorization()
    productionProcessor=createHealthOutboxProcessor({consumerId:'health-loop-v1',workerId})
  },
  startFabric:startActionFabricRuntime,
  async startConsumer(){
    timer=setInterval(()=>pollOnce(),250);timer.unref?.();pollOnce()
  },
  async stopConsumer(){if(timer){clearInterval(timer);timer=null}if(poll)await poll;productionProcessor=null},
  async stopFabric(){try{await stopActionFabricRuntime()}finally{
    clearHealthRuntimeAuthorization();configureHealthFabricExecutorDependencies(null);remoteProcessorIds=[]}},
})

export function startHealthLoopRuntime():Promise<void>{return lifecycle.start()}
export function stopHealthLoopRuntime():Promise<void>{return lifecycle.stop()}

/** Refresh immediately before creating an intent so dynamic literal targets cannot race policy evaluation. */
export function refreshHealthRuntimeAuthorization(exactTargets:readonly string[]=[]):void {
  const settings=getHealthAutomationSettings()
  const connectors=['health-state','s400'].filter(id=>settings.configuredConnectors.includes(id))
  const processors=remoteProcessorIds.filter(id=>settings.configuredProcessors.includes(id))
  ensureHealthRuntimeRole(connectors,processors,exactTargets)
  clearHealthRuntimeAuthorization()
  registerHealthRuntimeAuthorization(settings.profile,{connectors,remoteProcessors:processors})
}

export interface HealthOutboxProcessorOptions {
  consumerId:string
  workerId:string
  now?:()=>string
  createIntent?:(input:FabricActionIntentInput)=>{intentId:string;workflowId:string}
  /** Injection seam for crash recovery tests; production never supplies it. */
  afterIntent?:()=>void|Promise<void>
  /** Injection seam after durable reservation and before Fabric effect. */
  beforeIntent?:()=>void|Promise<void>
  ownerUserId?:string
}

export function createHealthOutboxProcessor(options:HealthOutboxProcessorOptions):{
  processOnce(override?:{now?:string}):Promise<{processed:boolean;outcome:'completed'|'failed'|'crashed'|'idle';outboxId:string|null}>
} {
  const createIntentEffect=options.createIntent??(input=>{const result=createFabricIntent(input)
    return {intentId:result.intent.id,workflowId:result.workflow.id}})
  const owner=options.ownerUserId??'user-self'
  return { async processOnce(override={}) {
    const now=timestamp(override.now??options.now?.()??new Date().toISOString())
    const claim=claimHealthOutboxDelivery({consumerId:options.consumerId,workerId:options.workerId,
      now,leaseMs:30_000,maxAttempts:5})
    if(!claim)return {processed:false,outcome:'idle',outboxId:null}
    try {
      validateOutboxPayload(claim)
      const prepared=claim.preparedJson===null?prepareRuntimeMaterial(claim,now,owner):parsePreparedMaterial(claim)
      if(!prepared.fabricIntent||!prepared.action){completeHealthOutboxDelivery(claim,{intentId:null,workflowId:null},now)
        return {processed:true,outcome:'completed',outboxId:claim.outboxId}}
      const materialDigest=hash(prepared)
      reserveHealthRuntimeAction({...prepared.action,materialDigest},{consumerId:claim.consumerId,workerId:claim.workerId,
        attempt:claim.attempt,now})
      if(options.beforeIntent)await options.beforeIntent()
      const effect=createIntentEffect(prepared.fabricIntent)
      if(options.afterIntent)await options.afterIntent()
      finalizeHealthRuntimeActionReservation(prepared.action.actionId,materialDigest,effect.intentId,effect.workflowId,now)
      completeHealthOutboxDelivery(claim,{intentId:effect.intentId,workflowId:effect.workflowId},now)
      return {processed:true,outcome:'completed',outboxId:claim.outboxId}
    } catch(error) {
      if(error instanceof Error&&error.message==='HEALTH_RUNTIME_SIMULATED_CRASH')throw error
      failHealthOutboxDelivery(claim,error,now,5)
      return {processed:true,outcome:'failed',outboxId:claim.outboxId}
    }
  } }
}

interface PreparedHealthRuntimeMaterial {
  schemaVersion:'health-runtime-prepared/v1';evaluationAt:string;effectiveDate:string
  projection:{digest:string;versions:Record<string,number>};activeActions:HealthActiveAction[];recentActions:HealthRecentAction[]
  plan:{planId:string;version:number;digest:string};decision:{ruleVersion:string;primary:HealthActionCandidate|null}
  fabricIntent:FabricActionIntentInput|null
  action:(Omit<Parameters<typeof registerHealthRuntimeAction>[0],'workflowId'>)|null
}

function prepareRuntimeMaterial(claim:HealthOutboxClaim,now:string,owner:string):PreparedHealthRuntimeMaterial {
  ensureDefaultPlan(now)
  const snapshot=loadTrustedSnapshot(now)
  const plan=loadPlan()
  const decision=decideHealthInterventions({projections:snapshot.projections,now,plan:plan.state,
    effectiveDate:now.slice(0,10),activeActions:snapshot.activeActions,recentActions:snapshot.recentActions})
  const candidate=decision.primary?.capabilityId?withRuntimeIdempotency(decision.primary,decision.ruleVersion,snapshot.digest):null
  const mapped=candidate?mapHealthActionCandidateToFabric(candidate,{planId:plan.planId,expectedPlanVersion:plan.version,
    ownerUserId:owner,dueAt:new Date(Date.parse(now)+86_400_000).toISOString(),
    expiresAt:new Date(Date.parse(now)+86_400_000).toISOString()}):null
  const settings=getHealthAutomationSettings()
  const fabricIntent:FabricActionIntentInput|null=candidate&&mapped?{capabilityId:mapped.capabilityId,
    requestedByRoleId:'health-manager',requestedByUserId:owner,idempotencyKey:candidate.idempotencyKey,
    goal:'Apply the selected bounded health intervention',target:mapped.target,input:mapped.input,
    constraints:{healthRuleVersion:decision.ruleVersion,projectionDigest:snapshot.digest,effectiveDate:candidate.effectiveDate},
    rationale:candidate.rationale,environments:[settings.liveDeliveryEnabled?'production':'sandbox']}:null
  const action=candidate&&mapped?{actionId:`health-action-${candidate.idempotencyKey.slice('health-intervention-'.length)}`,
    interventionId:candidate.id,userId:owner,capabilityId:mapped.capabilityId,category:candidate.category,
    priority:candidate.priority,supersedable:candidate.risk==='none'||candidate.risk==='low',risk:candidate.risk,
    authority:candidate.authority,supersedes:candidate.supersedes,sourceOutboxId:claim.outboxId,
    effectiveDate:candidate.effectiveDate,createdAt:now}:null
  const material:PreparedHealthRuntimeMaterial={schemaVersion:'health-runtime-prepared/v1',evaluationAt:now,
    effectiveDate:now.slice(0,10),projection:{digest:snapshot.digest,versions:Object.fromEntries(snapshot.projections.map(p=>[p.key,p.version]))},
    activeActions:snapshot.activeActions,recentActions:snapshot.recentActions,
    plan:{planId:plan.planId,version:plan.version,digest:plan.digest},decision:{ruleVersion:decision.ruleVersion,primary:candidate},
    fabricIntent,action}
  const json=stable(material);const digest=hash(material)
  prepareHealthOutboxDelivery(claim,{json,digest},now)
  return material
}

function parsePreparedMaterial(claim:HealthOutboxClaim):PreparedHealthRuntimeMaterial {
  if(claim.preparedJson===null||claim.preparedDigest===null||claim.preparedAt===null
    ||Buffer.byteLength(claim.preparedJson,'utf8')>1_048_576)throw new Error('HEALTH_RUNTIME_PREPARED_INVALID')
  let value:unknown;try{value=JSON.parse(claim.preparedJson)}catch{throw new Error('HEALTH_RUNTIME_PREPARED_INVALID')}
  assertPreparedBoundary(value)
  if(hash(value)!==claim.preparedDigest)throw new Error('HEALTH_RUNTIME_PREPARED_TAMPERED')
  return value as PreparedHealthRuntimeMaterial
}

function assertPreparedBoundary(value:unknown):asserts value is PreparedHealthRuntimeMaterial {
  if(!plain(value)||Object.keys(value).sort().join(',')!==
    'action,activeActions,decision,effectiveDate,evaluationAt,fabricIntent,plan,projection,recentActions,schemaVersion'
    ||value.schemaVersion!=='health-runtime-prepared/v1'||typeof value.evaluationAt!=='string'
    ||typeof value.effectiveDate!=='string'||!plain(value.projection)||!plain(value.plan)||!plain(value.decision)
    ||!Array.isArray(value.activeActions)||!Array.isArray(value.recentActions)
    ||(value.fabricIntent!==null&&!plain(value.fabricIntent))||(value.action!==null&&!plain(value.action))) {
    throw new Error('HEALTH_RUNTIME_PREPARED_INVALID')
  }
  assertSafeJson(value,0,new Set<object>())
}

function assertSafeJson(value:unknown,depth:number,seen:Set<object>):void {
  if(depth>32)throw new Error('HEALTH_RUNTIME_PREPARED_INVALID')
  if(value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return
  if(!value||typeof value!=='object'||seen.has(value))throw new Error('HEALTH_RUNTIME_PREPARED_INVALID')
  seen.add(value)
  for(const key of Object.keys(value)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('HEALTH_RUNTIME_PREPARED_INVALID')
    assertSafeJson((value as Record<string,unknown>)[key],depth+1,seen)}
}

function validateOutboxPayload(claim:HealthOutboxClaim):void {
  let value:unknown
  try{value=JSON.parse(claim.payloadJson)}catch{throw new Error('HEALTH_RUNTIME_OUTBOX_INVALID')}
  if(!plain(value))throw new Error('HEALTH_RUNTIME_OUTBOX_INVALID')
  const expected=claim.topic==='twin.observation.recorded'?['recordId','metric','source','sourceId']
    :['recordId','eventType','source','sourceId']
  const keys=Object.keys(value)
  if(keys.some(key=>!expected.includes(key))||value.recordId!==claim.aggregateId
    || expected.some(key=>typeof value[key]!=='string'||String(value[key]).length<1||String(value[key]).length>200)) {
    throw new Error('HEALTH_RUNTIME_OUTBOX_INVALID')
  }
}

function loadTrustedSnapshot(now:string):{projections:TwinProjection[];digest:string;
  activeActions:HealthActiveAction[];recentActions:HealthRecentAction[]} {
  return withPersonalTwinDb(db=>{
    db.exec('BEGIN')
    try{
      const rows=db.prepare(`SELECT projection_key,subject_id,value_json,source_record_id,version,updated_at
        FROM twin_projections WHERE subject_id='person:self' AND projection_key LIKE 'health.%' ORDER BY projection_key`).all() as Array<{
          projection_key:string;subject_id:string;value_json:string;source_record_id:string;version:number;updated_at:string}>
      if(rows.length!==HEALTH_PROJECTION_KEYS.length||rows.some((row,index)=>row.projection_key!==[...HEALTH_PROJECTION_KEYS].sort()[index]
        ||!Number.isSafeInteger(row.version)||row.version<1))throw new Error('HEALTH_RUNTIME_PROJECTION_SNAPSHOT_INVALID')
      const projections=rows.map(row=>{let value:unknown;try{value=JSON.parse(row.value_json)}catch{throw new Error('HEALTH_RUNTIME_PROJECTION_SNAPSHOT_INVALID')}
        if(!plain(value))throw new Error('HEALTH_RUNTIME_PROJECTION_SNAPSHOT_INVALID')
        return {key:row.projection_key,subjectId:row.subject_id,value,sourceRecordId:row.source_record_id,
          version:row.version,updatedAt:timestamp(row.updated_at)} as TwinProjection})
      const digest=hash({rule:'trusted-health-projection-snapshot/v1',projections:projections.map(item=>({key:item.key,
        version:item.version,sourceRecordId:item.sourceRecordId,updatedAt:item.updatedAt,value:item.value}))})
      const actionRows=db.prepare(`SELECT action_id,intervention_id,category,priority,supersedable,risk,authority,status
        FROM twin_health_actions ORDER BY action_id LIMIT 257`).all() as Array<{action_id:string;intervention_id:string;
        category:HealthRecentAction['category'];priority:number;supersedable:number;risk:HealthActiveAction['risk'];
        authority:HealthActiveAction['authority'];status:string}>
      if(actionRows.length>256)throw new Error('HEALTH_RUNTIME_ACTION_HISTORY_INVALID')
      const reservedRows=db.prepare(`SELECT action_id,intervention_id,category,priority,supersedable,risk,authority,'active' AS status
        FROM twin_health_action_reservations WHERE status='reserved' ORDER BY action_id LIMIT 257`).all() as typeof actionRows
      if(actionRows.length+reservedRows.length>256)throw new Error('HEALTH_RUNTIME_ACTION_HISTORY_INVALID')
      const activeActions=[...actionRows,...reservedRows].filter(row=>row.status==='active').map(row=>({id:row.action_id,
        candidateId:row.intervention_id,priority:row.priority,supersedable:row.supersedable===1,
        risk:row.risk,authority:row.authority}))
      const actionById=new Map(actionRows.map(row=>[row.action_id,row]))
      const outcomeRows=db.prepare(`SELECT event_type,payload_json,occurred_at FROM twin_events
        WHERE source='health-outcome' AND event_type LIKE 'health.outcome.%' ORDER BY occurred_at DESC,id LIMIT 257`).all() as
        Array<{event_type:string;payload_json:string;occurred_at:string}>
      if(outcomeRows.length>256)throw new Error('HEALTH_RUNTIME_ACTION_HISTORY_INVALID')
      const recentActions=outcomeRows.map(row=>{
        let payload:unknown;try{payload=JSON.parse(row.payload_json)}catch{throw new Error('HEALTH_RUNTIME_ACTION_HISTORY_INVALID')}
        if(!plain(payload)||Object.keys(payload).sort().join(',')!==
          'actionId,interventionId,outcome,reviewRequired,schemaVersion,supersededActionIds,userId,workflowId'
          ||typeof payload.actionId!=='string'||typeof payload.interventionId!=='string') {
          throw new Error('HEALTH_RUNTIME_ACTION_HISTORY_INVALID')
        }
        const action=actionById.get(payload.actionId)
        if(!action||action.intervention_id!==payload.interventionId||Date.parse(row.occurred_at)>Date.parse(now)) {
          throw new Error('HEALTH_RUNTIME_ACTION_HISTORY_INVALID')
        }
        return {candidateId:action.intervention_id,category:action.category,actedAt:timestamp(row.occurred_at)}
      })
      db.exec('COMMIT');return {projections,digest,activeActions,recentActions}
    }catch(error){db.exec('ROLLBACK');throw error}
  })
}

function ensureDefaultPlan(now:string):void {
  withPersonalTwinDb(db=>{
    const state={trainingIntensity:'high'}
    db.prepare(`INSERT INTO twin_health_plans(plan_id,version,digest,state_json,updated_at)
      VALUES('health-plan-default',1,?,?,?) ON CONFLICT(plan_id) DO NOTHING`).run(hash(state),JSON.stringify(state),now)
  })
}
function loadPlan():{planId:string;version:number;digest:string;state:Record<string,unknown>} {
  return withPersonalTwinDb(db=>{const row=db.prepare("SELECT * FROM twin_health_plans WHERE plan_id='health-plan-default'").get() as
    {plan_id:string;version:number;digest:string;state_json:string}|undefined
    if(!row||!Number.isSafeInteger(row.version)||row.version<1||!/^[a-f0-9]{64}$/.test(row.digest))throw new Error('HEALTH_RUNTIME_PLAN_INVALID')
    let state:unknown;try{state=JSON.parse(row.state_json)}catch{throw new Error('HEALTH_RUNTIME_PLAN_INVALID')}
    if(!plain(state)||hash(state)!==row.digest)throw new Error('HEALTH_RUNTIME_PLAN_INVALID')
    return {planId:row.plan_id,version:row.version,digest:row.digest,state}})
}
function withRuntimeIdempotency(candidate:HealthActionCandidate,ruleVersion:string,projectionDigest:string):HealthActionCandidate {
  const digest=hash({ruleVersion,projectionDigest,actionId:candidate.id,effectiveDate:candidate.effectiveDate})
  return {...candidate,idempotencyKey:`health-intervention-${digest}`}
}
function hash(value:unknown):string{return createHash('sha256').update(stable(value)).digest('hex')}
function stable(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value)
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value)
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`
  if(plain(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  throw new Error('HEALTH_RUNTIME_MATERIAL_INVALID')
}
function plain(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype}
function timestamp(value:string):string{const time=Date.parse(value);if(!Number.isFinite(time))throw new Error('HEALTH_RUNTIME_TIMESTAMP_INVALID');return new Date(time).toISOString()}

function pollOnce():void {
  if(poll||!productionProcessor)return
  const current=productionProcessor.processOnce().then(()=>undefined).finally(()=>{if(poll===current)poll=null})
  poll=current
  current.catch(error=>logger.error({errorClass:stableError(error)},'[health-loop] runtime poll failed'))
}
function stableError(error:unknown):string {
  return error instanceof Error&&/^[A-Z][A-Z0-9_]{1,127}$/.test(error.message)?error.message:'HEALTH_RUNTIME_PROCESSING_FAILED'
}

function ensureHealthRuntimeRole(connectors:string[],processors:string[],exactTargets:readonly string[]):void {
  ensureBuiltInAssistantRoles()
  updateAssistantRole('health-manager',{capabilityScope:{allow:['health.plan.adjust','health.checkin.request',
    'health.followup.schedule','health.reminder.send','health.source.sync','health.artifact.analyze.local',
    'health.artifact.analyze.remote'],deny:[],enforcement:'action_fabric_v1'},decisionAuthority:{maxRisk:'medium',
    requireApprovalAbove:'low',allowedTargets:['health:plan:health-plan-default','health:recipient:configured-self',
      'health:owner:user-self',...connectors.map(id=>`health:connector:${id}`),
      ...processors.map(id=>`health:processor:${id}`),...exactTargets].filter((value,index,array)=>array.indexOf(value)===index)}})
}
