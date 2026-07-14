import { createHash } from 'crypto'
import type { FabricAuthorizationProvider, FabricAuthorizationRequest } from '../action-fabric/authorization'
import { registerFabricAuthorizationProvider, clearFabricAuthorizationProvider } from '../action-fabric/authorization'
import { withPersonalTwinDb } from '../personal-twin/database'
import { getWeixinCredentialFingerprint } from '../weixin-sender'
import { getHealthAutomationSettings } from './settings'

const EXECUTORS:Record<string,string>={
  'health.source.sync':'health-source','health.artifact.analyze.local':'health-local-analysis',
  'health.artifact.analyze.remote':'health-remote-analysis','health.plan.adjust':'health-plan',
  'health.plan.restore':'health-plan','health.followup.schedule':'health-plan',
  'health.reminder.send':'health-weixin','health.checkin.request':'health-weixin',
}

export interface HealthRuntimeProviderAvailability {
  connectors?: readonly string[]
  remoteProcessors?: readonly string[]
}

export function createHealthRuntimeAuthorizationProvider(profile='default',availability:HealthRuntimeProviderAvailability={}):FabricAuthorizationProvider {
  const connectors=new Set(availability.connectors??[])
  const remoteProcessors=new Set(availability.remoteProcessors??[])
  return {id:'health-runtime-standing',version:1,authorize(request){
    if(request.environment!=='production'||EXECUTORS[request.capabilityId]!==request.executorId)return null
    const settings=getHealthAutomationSettings()
    if(settings.profile!==profile||!requirementsSatisfied(request,settings,new Date(),connectors,remoteProcessors))return null
    return {authorizationVersion:settings.version,expiresAt:new Date(Date.now()+30_000).toISOString(),
      grantedRequirements:[...request.requirements]}
  }}
}

export function registerHealthRuntimeAuthorization(profile='default',availability:HealthRuntimeProviderAvailability={}):void {
  registerFabricAuthorizationProvider(createHealthRuntimeAuthorizationProvider(profile,availability))
}
export function clearHealthRuntimeAuthorization():void{clearFabricAuthorizationProvider()}

function requirementsSatisfied(request:Readonly<FabricAuthorizationRequest>,settings:ReturnType<typeof getHealthAutomationSettings>,now:Date,
  availableConnectors:ReadonlySet<string>,remoteProcessors:ReadonlySet<string>):boolean {
  const input=request.input
  if(request.capabilityId==='health.reminder.send'||request.capabilityId==='health.checkin.request'){
    return same(request.requirements,['live_mode:enabled','recipient:configured_self'])&&settings.liveDeliveryEnabled
      && input.recipient==='configured-self'&&request.targetAtoms.length===1
      && request.targetAtoms[0]==='health:recipient:configured-self'&&getWeixinCredentialFingerprint(settings.profile)!==null
  }
  if(request.capabilityId==='health.source.sync')return same(request.requirements,['connector_credential:configured'])
    &&typeof input.connectorId==='string'&&availableConnectors.has(input.connectorId)&&settings.configuredConnectors.includes(input.connectorId)
  if(request.capabilityId==='health.artifact.analyze.local')return same(request.requirements,['artifact:local_read'])
    &&artifactMatches(input.artifactId,input.manifestDigest)
  if(request.capabilityId==='health.artifact.analyze.remote')return same(request.requirements,
    ['one_time_consent:exact_artifact_manifest','processor:exact_id'])&&typeof input.processorId==='string'
    &&remoteProcessors.has(input.processorId)&&settings.configuredProcessors.includes(input.processorId)&&artifactMatches(input.artifactId,input.manifestDigest)
    &&reservationMatches(input.consentId,input.artifactId,input.manifestDigest,input.processorId,now)
  if(request.capabilityId==='health.plan.adjust')return same(request.requirements,['health_plan:write'])
    &&planMatches(input.planId,input.expectedVersion)
  if(request.capabilityId==='health.plan.restore')return same(request.requirements,['health_plan:write'])
    &&planMatches(input.planId,input.expectedCurrentVersion)
  if(request.capabilityId==='health.followup.schedule')return same(request.requirements,['health_schedule:write'])
    &&input.ownerUserId===request.requestedByUserId
  return false
}

function planMatches(planId:unknown,version:unknown):boolean{
  if(typeof planId!=='string'||!Number.isSafeInteger(version))return false
  return withPersonalTwinDb(db=>{const row=db.prepare('SELECT version FROM twin_health_plans WHERE plan_id=?').get(planId) as {version:number}|undefined
    return row?.version===version})
}
function artifactMatches(artifactId:unknown,digest:unknown):boolean{
  if(typeof artifactId!=='string'||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))return false
  return withPersonalTwinDb(db=>{const row=db.prepare(`SELECT id,media_type,content_hash,relative_path,size_bytes,sensitivity
    FROM twin_artifacts WHERE id=?`).get(artifactId) as {id:string;media_type:string;content_hash:string;relative_path:string;size_bytes:number;sensitivity:string}|undefined
    if(!row||row.sensitivity!=='health')return false
    return hash({schemaVersion:1,artifactId:row.id,mediaType:row.media_type,contentHash:row.content_hash,
      relativePath:row.relative_path,sizeBytes:row.size_bytes})===digest})
}
function reservationMatches(id:unknown,artifactId:unknown,digest:unknown,processor:unknown,now:Date):boolean{
  if(typeof id!=='string')return false
  return withPersonalTwinDb(db=>{const row=db.prepare(`SELECT artifact_id,artifact_manifest_digest,processor,expires_at,consumed_at
    FROM twin_artifact_consent_reservations WHERE reservation_id=?`).get(id) as {artifact_id:string;artifact_manifest_digest:string;
      processor:string;expires_at:string;consumed_at:string|null}|undefined
    return !!row&&row.artifact_id===artifactId&&row.artifact_manifest_digest===digest&&row.processor===processor
      &&row.consumed_at===null&&Date.parse(row.expires_at)>now.getTime()})
}
function same(left:readonly string[],right:readonly string[]):boolean{return left.length===right.length&&right.every(item=>left.includes(item))}
function hash(value:unknown):string{return createHash('sha256').update(stable(value)).digest('hex')}
function stable(value:unknown):string{if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value)
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>)
    .sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;throw new Error('invalid')}
