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
    const now=new Date()
    if(settings.profile!==profile||!requirementsSatisfied(request,settings,now,connectors,remoteProcessors))return null
    const requestDigest=hash(request)
    const evidenceDigest=hash({settings,connectors:[...connectors].sort(),remoteProcessors:[...remoteProcessors].sort(),
      credentialFingerprint:request.capabilityId==='health.reminder.send'||request.capabilityId==='health.checkin.request'
        ?getWeixinCredentialFingerprint(settings.profile):null,resource:authorizationResourceMaterial(request)})
    return withPersonalTwinDb(db=>{
      const row=db.prepare(`SELECT evidence_digest,settings_version,grant_json,expires_at
        FROM twin_health_authorization_grants WHERE request_digest=?`).get(requestDigest) as
        {evidence_digest:string;settings_version:number;grant_json:string;expires_at:string}|undefined
      if(row){
        if(row.evidence_digest!==evidenceDigest||row.settings_version!==settings.version||Date.parse(row.expires_at)<=now.getTime())return null
        return parseStoredGrant(row.grant_json,row.settings_version,row.expires_at,request.requirements)
      }
      const resourceExpiry=request.capabilityId==='health.artifact.analyze.remote'?reservationExpiry(request.input.consentId):null
      const expiresAt=new Date(Math.min(now.getTime()+30_000,resourceExpiry??Number.POSITIVE_INFINITY)).toISOString()
      const grant={authorizationVersion:settings.version,expiresAt,grantedRequirements:[...request.requirements]}
      db.prepare(`INSERT INTO twin_health_authorization_grants
        (request_digest,evidence_digest,settings_version,grant_json,issued_at,expires_at) VALUES(?,?,?,?,?,?)`).run(
        requestDigest,evidenceDigest,settings.version,stable(grant),now.toISOString(),expiresAt)
      return grant
    })
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
function reservationExpiry(id:unknown):number|null{
  if(typeof id!=='string')return null
  return withPersonalTwinDb(db=>{const row=db.prepare('SELECT expires_at FROM twin_artifact_consent_reservations WHERE reservation_id=?')
    .get(id) as {expires_at:string}|undefined;const value=Date.parse(row?.expires_at??'');return Number.isFinite(value)?value:null})
}
function authorizationResourceMaterial(request:Readonly<FabricAuthorizationRequest>):unknown{
  const input=request.input
  return withPersonalTwinDb(db=>{
    if(request.capabilityId==='health.artifact.analyze.remote'&&typeof input.consentId==='string')return db.prepare(`SELECT
      reservation_id,consent_id,artifact_id,artifact_manifest_digest,processor,expires_at,consumed_at
      FROM twin_artifact_consent_reservations WHERE reservation_id=?`).get(input.consentId)??null
    if((request.capabilityId==='health.plan.adjust'||request.capabilityId==='health.plan.restore')&&typeof input.planId==='string')return db.prepare(
      'SELECT plan_id,version,digest FROM twin_health_plans WHERE plan_id=?').get(input.planId)??null
    if((request.capabilityId==='health.artifact.analyze.local'||request.capabilityId==='health.artifact.analyze.remote')
      &&typeof input.artifactId==='string')return db.prepare(`SELECT id,media_type,content_hash,relative_path,size_bytes,sensitivity
        FROM twin_artifacts WHERE id=?`).get(input.artifactId)??null
    return null
  })
}
function parseStoredGrant(json:string,version:number,expiresAt:string,requirements:readonly string[]):{
  authorizationVersion:number;expiresAt:string;grantedRequirements:string[]}|null{
  let value:unknown;try{value=JSON.parse(json)}catch{return null}
  if(!value||typeof value!=='object'||Array.isArray(value))return null
  const grant=value as Record<string,unknown>
  if(Object.keys(grant).sort().join(',')!=='authorizationVersion,expiresAt,grantedRequirements'
    ||grant.authorizationVersion!==version||grant.expiresAt!==expiresAt||!Array.isArray(grant.grantedRequirements)
    ||!same(grant.grantedRequirements as string[],requirements))return null
  return {authorizationVersion:version,expiresAt,grantedRequirements:[...(grant.grantedRequirements as string[])]}
}
function same(left:readonly string[],right:readonly string[]):boolean{return left.length===right.length&&right.every(item=>left.includes(item))}
function hash(value:unknown):string{return createHash('sha256').update(stable(value)).digest('hex')}
function stable(value:unknown):string{if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value)
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>)
    .sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;throw new Error('invalid')}
