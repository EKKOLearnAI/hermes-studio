import type { Context } from 'koa'
import { randomUUID } from 'node:crypto'
import { isProxy } from 'node:util/types'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../../lib/multipart'
import { createFabricIntent } from '../../services/hermes/action-fabric'
import { createHealthArtifactVault } from '../../services/hermes/health-loop/artifacts'
import { createHealthConsentBroker, HEALTH_PROCESSING_RETENTIONS,
  type HealthProcessingManifest } from '../../services/hermes/health-loop/consent'
import { createHealthConnectorRegistry } from '../../services/hermes/health-loop/connectors'
import { createHealthStateConnector } from '../../services/hermes/health-loop/connectors/health-state'
import { createS400HealthConnector } from '../../services/hermes/health-loop/connectors/s400'
import { recordHealthOutcome, HEALTH_OUTCOMES } from '../../services/hermes/health-loop/outcomes'
import { createDurableHealthAnalysisServices } from '../../services/hermes/health-loop/runtime-dependencies'
import { refreshHealthRuntimeAuthorization } from '../../services/hermes/health-loop/runtime'
import { getHealthAutomationSettings, updateHealthAutomationSettings } from '../../services/hermes/health-loop/settings'
import { withPersonalTwinDb } from '../../services/hermes/personal-twin/database'

class HealthLoopRequestError extends Error {}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const DIGEST = /^[a-f0-9]{64}$/
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024 + 64 * 1024
const MAX_JSON_BYTES = 16_384
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SENSITIVE_KEY = /(?:token|password|secret|credential|authorization|cookie|api.?key|private.?key|path|directory|sqlite|dsn)/i
const SENSITIVE_VALUE = /(?:Bearer\s+[A-Za-z0-9._~-]+|(?:token|password|secret|credential|api.?key)\s*[:=]\s*\S+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-|AKIA[0-9A-Z]{12,}|^[A-Za-z]:[\\/]|^\\\\|^\/|(?:^|[\\/])(?:profiles?|credentials?|\.hermes|\.ssh)(?:[\\/]|$)|(?:^|[\\/])[^\\/]+\.(?:db|sqlite|sqlite3)$)/i

/** @openapi-default-errors 400:HealthLoopError,401:AuthError,403:AuthError,404:HealthLoopError,409:HealthLoopError,413:HealthLoopError,500:HealthLoopError,503:HealthLoopError */

/** @openapi-response HealthLoopOverviewResponse */
export async function overview(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    const settings = publicSettings(getHealthAutomationSettings())
    const connectors = await connectorStatuses(String(settings.profile))
    const summary = withPersonalTwinDb(db => ({
      interventionCount: Number((db.prepare('SELECT COUNT(*) AS count FROM twin_health_actions').get() as { count:number }).count),
      activeInterventionCount: Number((db.prepare("SELECT COUNT(*) AS count FROM twin_health_actions WHERE status='active'").get() as { count:number }).count),
      projectionCount: Number((db.prepare("SELECT COUNT(*) AS count FROM twin_projections WHERE projection_key LIKE 'health.%'").get() as { count:number }).count),
    }))
    return { settings, connectors, summary }
  })
}

/** @openapi-response HealthConnectorListResponse */
export async function connectors(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    noQuery(ctx)
    return { connectors: await connectorStatuses(getHealthAutomationSettings().profile) }
  })
}

/** @openapi-response HealthActionResponse */
export async function syncConnector(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    const connectorId = pathId(ctx)
    const body = exactBody(ctx, new Set(['cursor', 'requestedAt', 'idempotencyKey']))
    const registry = connectorRegistry(getHealthAutomationSettings().profile)
    if (!registry.get(connectorId)) throw coded('HEALTH_CONNECTOR_NOT_FOUND')
    const requestedAt = optionalTimestamp(body.requestedAt) ?? new Date().toISOString()
    const cursor = optionalText(body.cursor, 2048)
    refreshHealthRuntimeAuthorization([`health:connector:${connectorId}`])
    const result = createFabricIntent({
      capabilityId: 'health.source.sync', requestedByRoleId: 'health-manager', requestedByUserId: actorUserId(ctx),
      idempotencyKey: optionalId(body.idempotencyKey) ?? `health-sync-${randomUUID()}`,
      goal: 'Synchronize one configured health source', target: { kind: 'health_connector', connectorId },
      input: { schemaVersion: 1, connectorId, requestedAt, ...(cursor ? { cursor } : {}) }, constraints: {},
      rationale: 'Explicit authenticated health source synchronization', environments: ['production'],
    })
    ctx.status = 202
    return publicAction(result)
  })
}

/** @openapi-response HealthArtifactResponse */
export async function createArtifact(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    const upload = await multipartArtifact(ctx)
    const vault = createHealthArtifactVault()
    const artifact = await vault.store({ content: upload.content, declaredMediaType: upload.mediaType,
      originalFilename: upload.filename, source: 'health-loop-api', sourceId: upload.sourceId,
      ...(upload.metadata ? { metadata: upload.metadata } : {}) })
    const identity = await createDurableHealthAnalysisServices().artifactResolver.resolve(artifact.id)
    if (!identity) throw coded('HEALTH_ARTIFACT_REGISTRY_FAILED')
    refreshHealthRuntimeAuthorization([`health:artifact:${artifact.id}:${identity.manifestDigest}`])
    ctx.status = 201
    return { artifact: { id: artifact.id, mediaType: artifact.mediaType, sizeBytes: artifact.sizeBytes,
      manifestDigest: identity.manifestDigest, metadata: publicMetadata(artifact.metadata), createdAt: artifact.createdAt } }
  })
}

/** @openapi-response HealthActionResponse */
export async function analyzeArtifact(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    const artifactId = pathArtifactId(ctx)
    const body = exactBody(ctx, new Set(['mode', 'manifestDigest', 'processorId', 'consentToken', 'manifest', 'idempotencyKey', 'requestedAt']))
    const mode = requiredEnum(body.mode, ['local', 'remote'] as const)
    const manifestDigest = requiredDigest(body.manifestDigest)
    const requestedAt = optionalTimestamp(body.requestedAt)
    const actor = actorUserId(ctx)
    const requestedIdempotencyKey = optionalId(body.idempotencyKey)
    const identity = await createDurableHealthAnalysisServices().artifactResolver.resolve(artifactId)
    if (!identity || identity.manifestDigest !== manifestDigest) throw coded('HEALTH_ARTIFACT_NOT_FOUND')
    let capabilityId: 'health.artifact.analyze.local' | 'health.artifact.analyze.remote'
    let input: Record<string, unknown>
    let target: Record<string, unknown>
    if (mode === 'local') {
      if (body.processorId !== undefined || body.consentToken !== undefined || body.manifest !== undefined) throw new HealthLoopRequestError('Invalid local analysis request')
      capabilityId = 'health.artifact.analyze.local'
      input = { schemaVersion: 1, artifactId, manifestDigest, requestedAt: requestedAt ?? new Date().toISOString() }
      target = { kind: 'health_artifact', artifactId, manifestDigest }
    } else {
      const processorId = requiredId(body.processorId)
      const consentToken = requiredToken(body.consentToken)
      const idempotencyKey = requiredId(requestedIdempotencyKey)
      const manifest = processingManifest(body.manifest)
      const settings = getHealthAutomationSettings()
      if (!settings.configuredProcessors.includes(processorId) || manifest.processor !== processorId
        || manifest.artifactIds.length !== 1 || manifest.artifactIds[0] !== artifactId) throw coded('HEALTH_PROCESSOR_NOT_CONFIGURED')
      const broker = createHealthConsentBroker({ allowedProcessors: settings.configuredProcessors })
      const reservation = await broker.reserveIdempotent(consentToken, manifest,
        { artifactId, artifactManifestDigest: manifestDigest, processorId },
        { actorUserId: actor, idempotencyKey })
      capabilityId = 'health.artifact.analyze.remote'
      input = { schemaVersion: 1, artifactId, manifestDigest, processorId, consentId: reservation.reservationId,
        requestedAt: requestedAt ?? reservation.reservedAt }
      target = { kind: 'health_remote_artifact', artifactId, manifestDigest, processorId }
    }
    refreshHealthRuntimeAuthorization([`health:artifact:${artifactId}:${manifestDigest}`,
      ...(mode === 'remote' ? [`health:processor:${String(input.processorId)}`] : [])])
    const result = createFabricIntent({ capabilityId, requestedByRoleId: 'health-manager', requestedByUserId: actor,
      idempotencyKey: requestedIdempotencyKey ?? `health-analysis-${randomUUID()}`,
      goal: 'Analyze one exact health artifact', target, input, constraints: {},
      rationale: 'Explicit authenticated artifact analysis request',
      environments: [capabilityId === 'health.artifact.analyze.local' ? 'internal' : 'production'] })
    ctx.status = 202
    return publicAction(result)
  })
}

/** @openapi-response HealthConsentGrantResponse */
export async function createConsent(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    const body = exactBody(ctx, new Set(['manifest', 'ttlMs']))
    const settings = getHealthAutomationSettings()
    const manifest = processingManifest(body.manifest)
    if (!settings.configuredProcessors.includes(manifest.processor)) throw coded('HEALTH_PROCESSOR_NOT_CONFIGURED')
    const ttlMs = optionalInteger(body.ttlMs, 1, 15 * 60 * 1000)
    const grant = await createHealthConsentBroker({ allowedProcessors: settings.configuredProcessors }).issue(manifest,
      ttlMs === undefined ? undefined : { ttlMs })
    ctx.status = 201
    return { consent: { consentId: grant.consentId, manifestDigest: grant.manifestDigest, manifest: grant.manifest,
      issuedAt: grant.issuedAt, expiresAt: grant.expiresAt, token: grant.token } }
  })
}

/** @openapi-response HealthConsentRevocationResponse */
export async function revokeConsent(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    emptyBody(ctx)
    const consentId = pathId(ctx)
    const settings = getHealthAutomationSettings()
    const revoked = await createHealthConsentBroker({ allowedProcessors: settings.configuredProcessors }).revoke(consentId)
    return { consent: revoked }
  })
}

/** @openapi-response HealthInterventionListResponse */
export async function interventions(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    queryKeys(ctx, new Set(['status', 'limit']))
    const status = queryEnum(ctx, 'status', ['active', 'completed', 'superseded'] as const)
    const limit = queryInteger(ctx, 'limit', 1, 200) ?? 100
    const rows = withPersonalTwinDb(db => db.prepare(`SELECT action_id,intervention_id,workflow_id,capability_id,category,
      priority,risk,authority,status,effective_date,created_at,superseded_at FROM twin_health_actions
      ${status ? 'WHERE status=?' : ''} ORDER BY created_at DESC,action_id LIMIT ?`).all(...(status ? [status, limit] : [limit])) as Array<Record<string, unknown>>)
    return { interventions: rows.map(row => ({ actionId: row.action_id, interventionId: row.intervention_id,
      workflowId: row.workflow_id, capabilityId: row.capability_id, category: row.category, priority: row.priority,
      risk: row.risk, authority: row.authority, status: row.status, effectiveDate: row.effective_date,
      createdAt: row.created_at, supersededAt: row.superseded_at })) }
  })
}

/** @openapi-response HealthFeedbackResponse */
export async function interventionFeedback(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    const interventionId = pathId(ctx)
    const body = exactBody(ctx, new Set(['feedbackId', 'outcome', 'occurredAt']))
    const row = withPersonalTwinDb(db => db.prepare(`SELECT action_id,intervention_id,workflow_id,user_id
      FROM twin_health_actions WHERE intervention_id=? ORDER BY created_at DESC LIMIT 1`).get(interventionId) as
      {action_id:string;intervention_id:string;workflow_id:string;user_id:string}|undefined)
    if (!row) throw coded('HEALTH_INTERVENTION_NOT_FOUND')
    const feedback = recordHealthOutcome({ feedbackId: requiredId(body.feedbackId),
      outcome: requiredEnum(body.outcome, HEALTH_OUTCOMES), actionId: row.action_id, interventionId: row.intervention_id,
      workflowId: row.workflow_id, userId: row.user_id, occurredAt: requiredTimestamp(body.occurredAt) })
    return { feedback: { feedbackId: feedback.feedbackId, outcome: feedback.outcome, actionId: feedback.actionId,
      interventionId: feedback.interventionId, occurredAt: feedback.occurredAt,
      reviewRequired: feedback.reviewRequired, supersededActionIds: feedback.supersededActionIds } }
  })
}

/** @openapi-response HealthSettingsResponse */
export async function settings(ctx: Context): Promise<void> {
  await respond(ctx, async () => { noQuery(ctx); return { settings: publicSettings(getHealthAutomationSettings()) } })
}

/** @openapi-response HealthSettingsResponse */
export async function updateSettings(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    const body = exactBody(ctx, new Set(['expectedVersion', 'liveDeliveryEnabled', 'recipient',
      'configuredConnectors', 'configuredProcessors']))
    if (typeof body.liveDeliveryEnabled !== 'boolean') throw new HealthLoopRequestError('Invalid liveDeliveryEnabled')
    if (body.liveDeliveryEnabled && ctx.state.user?.role !== 'super_admin') throw forbidden()
    const current = getHealthAutomationSettings()
    const authenticatedProfile = ctx.state.profile?.name
    const profile = authenticatedProfile === undefined ? current.profile : requiredProfile(authenticatedProfile)
    const updated = updateHealthAutomationSettings({ expectedVersion: requiredInteger(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER),
      liveDeliveryEnabled: body.liveDeliveryEnabled, actorUserId: actorUserId(ctx), profile,
      recipient: requiredEnum(body.recipient, ['configured-self'] as const),
      ...(body.configuredConnectors === undefined ? {} : { configuredConnectors: idArray(body.configuredConnectors, 32) }),
      ...(body.configuredProcessors === undefined ? {} : { configuredProcessors: idArray(body.configuredProcessors, 32) }) })
    refreshHealthRuntimeAuthorization()
    return { settings: publicSettings(updated) }
  })
}

function connectorRegistry(profile:string) { return createHealthConnectorRegistry([
  createHealthStateConnector({ profile }), createS400HealthConnector({ profile }),
]) }
async function connectorStatuses(profile:string) {
  const statuses = await Promise.all(connectorRegistry(profile).list().map(async connector => ({ id: connector.id,
    ...(await connector.status()) })))
  return statuses.map(item => ({ id:item.id, configured:item.configured, configurationState:item.configurationState,
    authorizationState:item.authorizationState, health:item.health, lastAttemptAt:item.lastAttemptAt,
    lastSuccessAt:item.lastSuccessAt, domains:item.domains, freshnessByDomain:item.freshnessByDomain,
    capabilities:item.capabilities, ...(item.errorCode ? { errorCode:item.errorCode } : {}) }))
}

function publicSettings(value:ReturnType<typeof getHealthAutomationSettings>):Record<string,unknown> {
  return { subjectId:value.subjectId,liveDeliveryEnabled:value.liveDeliveryEnabled,profile:value.profile,
    recipient:value.recipient,configuredConnectors:[...value.configuredConnectors],configuredProcessors:[...value.configuredProcessors],
    version:value.version,updatedAt:value.updatedAt }
}
function publicAction(result:any):Record<string,unknown> { return { intent:{id:String(result.intent.id),capabilityId:String(result.intent.capabilityId)},
  policyDecision:{id:String(result.policyDecision.id),outcome:String(result.policyDecision.outcome),reasonCodes:[...(result.policyDecision.reasonCodes??[])]},
  workflow:{id:String(result.workflow.id),state:String(result.workflow.state),version:Number(result.workflow.version),
    availableActions:{...(result.workflow.availableActions??{})}} } }
function publicMetadata(value:unknown):Record<string,unknown> {
  assertSafeGraph(value)
  const sanitized=sanitizeMetadata(value,0)
  if(!isPlain(sanitized))throw new HealthLoopRequestError('Invalid metadata')
  const output:Record<string,unknown>={}
  if(Object.prototype.hasOwnProperty.call(sanitized,'healthAnalysis')) {
    if(!isPlain(sanitized.healthAnalysis))throw new HealthLoopRequestError('Invalid metadata')
    const analysis:Record<string,unknown>={}
    if(Object.prototype.hasOwnProperty.call(sanitized.healthAnalysis,'purpose'))analysis.purpose=metadataEnum(sanitized.healthAnalysis.purpose,['measurement','posture','skin','diet','internal_health'])
    if(Object.prototype.hasOwnProperty.call(sanitized.healthAnalysis,'format'))analysis.format=metadataEnum(sanitized.healthAnalysis.format,['json','csv','report_text'])
    if(Object.prototype.hasOwnProperty.call(sanitized.healthAnalysis,'selectedRegions'))analysis.selectedRegions=metadataStrings(sanitized.healthAnalysis.selectedRegions,64,160,/^[\p{L}\p{N}._:/-]+$/u)
    if(Object.prototype.hasOwnProperty.call(sanitized.healthAnalysis,'requestedFields'))analysis.requestedFields=metadataStrings(sanitized.healthAnalysis.requestedFields,128,100,/^[a-z][A-Za-z0-9._:-]*$/)
    output.healthAnalysis=analysis
  }
  if(Object.prototype.hasOwnProperty.call(sanitized,'notes')) {
    if(!Array.isArray(sanitized.notes)||sanitized.notes.length>64||sanitized.notes.some(item=>typeof item!=='string'||Buffer.byteLength(item,'utf8')>1_024))throw new HealthLoopRequestError('Invalid metadata')
    output.notes=[...sanitized.notes]
  }
  return output
}
function metadataEnum<T extends string>(value:unknown,allowed:readonly T[]):T {if(typeof value!=='string'||!allowed.includes(value as T))throw new HealthLoopRequestError('Invalid metadata');return value as T}
function metadataStrings(value:unknown,maxItems:number,maxLength:number,pattern:RegExp):string[]{if(!Array.isArray(value)||value.length>maxItems||new Set(value).size!==value.length||value.some(item=>typeof item!=='string'||item.length<1||item.length>maxLength||item==='[redacted]'||!pattern.test(item)))throw new HealthLoopRequestError('Invalid metadata');return [...value] as string[]}
function sanitizeMetadata(value:unknown,depth:number):unknown {
  if(depth>5)throw new HealthLoopRequestError('Invalid metadata')
  if(value===null||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return value
  if(typeof value==='string')return Buffer.byteLength(value,'utf8')>1_024||/[\u0000-\u001f\u007f-\u009f]/u.test(value)||SENSITIVE_VALUE.test(value)?'[redacted]':value
  if(Array.isArray(value)){if(value.length>64)throw new HealthLoopRequestError('Invalid metadata');return value.map(item=>sanitizeMetadata(item,depth+1))}
  if(!isPlain(value))throw new HealthLoopRequestError('Invalid metadata')
  if(Object.keys(value).length>64)throw new HealthLoopRequestError('Invalid metadata')
  const out:Record<string,unknown>={}
  for(const [key,item] of Object.entries(value)){if(!SENSITIVE_KEY.test(key))out[key]=sanitizeMetadata(item,depth+1)}return out
}

async function multipartArtifact(ctx:Context):Promise<{content:Buffer;mediaType:string;filename:string;sourceId:string;metadata?:Record<string,unknown>}> {
  const contentType=ctx.get('content-type')||'';if(!contentType.toLowerCase().startsWith('multipart/form-data'))throw new HealthLoopRequestError('Expected multipart/form-data')
  const length=Number(ctx.get('content-length')||0);if(Number.isFinite(length)&&length>MAX_UPLOAD_BYTES)throw tooLarge()
  const boundary=parseMultipartBoundary(contentType);if(!boundary)throw new HealthLoopRequestError('Invalid multipart boundary')
  const chunks:Buffer[]=[];let total=0
  for await(const raw of ctx.req){const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);total+=chunk.length;if(total>MAX_UPLOAD_BYTES)throw tooLarge();chunks.push(chunk)}
  const parts=splitMultipart(Buffer.concat(chunks),boundary);let file:Buffer|undefined;let mediaType='';let filename='';let sourceId='';let metadata:Record<string,unknown>|undefined
  for(const part of parts){const end=part.indexOf(Buffer.from('\r\n\r\n'));if(end<0)continue;const header=part.subarray(0,end).toString('utf8');
    const name=header.match(/Content-Disposition:\s*form-data;[^\r\n]*\bname="([^"]+)"/i)?.[1];if(!name)continue
    const data=part.subarray(end+4,Math.max(end+4,part.length-2));let partFilename:string|null
    try{partFilename=parseMultipartFilename(header)}catch(error){if(error instanceof MultipartParseError)throw new HealthLoopRequestError('Invalid multipart filename');throw error}
    if(partFilename!==null){if(name!=='file'||file)throw new HealthLoopRequestError('Expected one file field');file=data;filename=safeFilename(partFilename);mediaType=header.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase()??'';continue}
    if(name==='sourceId'){sourceId=requiredId(data.toString('utf8').trim())}
    else if(name==='metadata'){if(data.length>MAX_JSON_BYTES)throw new HealthLoopRequestError('Metadata too large');let parsed:unknown;try{parsed=JSON.parse(data.toString('utf8'))}catch{throw new HealthLoopRequestError('Invalid metadata')};assertSafeGraph(parsed);metadata=publicMetadata(parsed)}
    else throw new HealthLoopRequestError('Unexpected multipart field')
  }
  if(!file||!mediaType||!sourceId)throw new HealthLoopRequestError('file, content type, and sourceId are required')
  return {content:file,mediaType,filename,sourceId,...(metadata?{metadata}:{})}
}

function processingManifest(value:unknown):HealthProcessingManifest {assertSafeGraph(value);if(!isPlain(value)||Object.keys(value).sort().join(',')!=='artifactIds,processor,purpose,requestedFields,retention,selectedRegions')throw new HealthLoopRequestError('Invalid manifest')
  const artifactIds=idArray(value.artifactIds,16);if(!artifactIds.every(id=>/^artifact-[a-f0-9]{64}$/.test(id)))throw new HealthLoopRequestError('Invalid manifest')
  const processor=requiredId(value.processor);const purpose=requiredEnum(value.purpose,['measurement','posture','skin','diet','internal_health'] as const)
  const selectedRegions=textArray(value.selectedRegions,64,160,true);const requestedFields=textArray(value.requestedFields,128,100,false)
  const retention=requiredEnum(value.retention,HEALTH_PROCESSING_RETENTIONS);return {artifactIds,processor,purpose,selectedRegions,requestedFields,retention} }
function assertSafeGraph(value:unknown):void {const seen=new Set<object>();let nodes=0;const visit=(v:unknown,d:number):void=>{if(++nodes>512||d>6)throw new HealthLoopRequestError('Invalid request graph');if(v===null||['string','boolean','number'].includes(typeof v))return;if(!v||typeof v!=='object'||isProxy(v)||seen.has(v))throw new HealthLoopRequestError('Invalid request graph');seen.add(v);const proto=Object.getPrototypeOf(v);if(proto!==Object.prototype&&proto!==Array.prototype&&proto!==null)throw new HealthLoopRequestError('Invalid request graph');for(const key of Reflect.ownKeys(v)){if(typeof key!=='string'||POISON_KEYS.has(key))throw new HealthLoopRequestError('Invalid request graph');const descriptor=Object.getOwnPropertyDescriptor(v,key);if(!descriptor||!('value'in descriptor))throw new HealthLoopRequestError('Invalid request graph');if(key!=='length')visit(descriptor.value,d+1)}};visit(value,0)}
function exactBody(ctx:Context,allowed:Set<string>):Record<string,unknown>{const value=ctx.request.body;assertSafeGraph(value);if(!isPlain(value))throw new HealthLoopRequestError('JSON object required');if(Buffer.byteLength(JSON.stringify(value))>MAX_JSON_BYTES)throw new HealthLoopRequestError('Request body too large');for(const key of Object.keys(value))if(!allowed.has(key))throw new HealthLoopRequestError('Unexpected request field');return value}
function emptyBody(ctx:Context):void{if(ctx.request.body===undefined||ctx.request.body===null)return;const body=exactBody(ctx,new Set());if(Object.keys(body).length)throw new HealthLoopRequestError('Empty body required')}
function isPlain(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&!isProxy(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null)}
function requiredId(v:unknown):string{if(typeof v!=='string'||!ID.test(v)||SENSITIVE_VALUE.test(v))throw new HealthLoopRequestError('Invalid identifier');return v}
function optionalId(v:unknown):string|undefined{return v===undefined?undefined:requiredId(v)}
function requiredToken(v:unknown):string{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw new HealthLoopRequestError('Invalid consent token');return v}
function requiredDigest(v:unknown):string{if(typeof v!=='string'||!DIGEST.test(v))throw new HealthLoopRequestError('Invalid digest');return v}
function requiredEnum<T extends string>(v:unknown,values:readonly T[]):T{if(typeof v!=='string'||!values.includes(v as T))throw new HealthLoopRequestError('Invalid enum value');return v as T}
function optionalText(v:unknown,max:number):string|undefined{if(v===undefined)return undefined;if(typeof v!=='string'||v.length<1||v.length>max||SENSITIVE_VALUE.test(v))throw new HealthLoopRequestError('Invalid text');return v}
function requiredTimestamp(v:unknown):string{if(typeof v!=='string'||v.length>64||!Number.isFinite(Date.parse(v)))throw new HealthLoopRequestError('Invalid timestamp');return new Date(Date.parse(v)).toISOString()}
function optionalTimestamp(v:unknown):string|undefined{return v===undefined?undefined:requiredTimestamp(v)}
function requiredInteger(v:unknown,min:number,max:number):number{if(!Number.isSafeInteger(v)||(v as number)<min||(v as number)>max)throw new HealthLoopRequestError('Invalid integer');return v as number}
function optionalInteger(v:unknown,min:number,max:number):number|undefined{return v===undefined?undefined:requiredInteger(v,min,max)}
function requiredProfile(v:unknown):string{if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v))throw new HealthLoopRequestError('Invalid profile');return v}
function idArray(v:unknown,max:number):string[]{if(!Array.isArray(v)||v.length>max||new Set(v).size!==v.length)throw new HealthLoopRequestError('Invalid identifier array');return v.map(requiredId)}
function textArray(v:unknown,max:number,itemMax:number,empty:boolean):string[]{if(!Array.isArray(v)||v.length>max||(!empty&&v.length===0)||new Set(v).size!==v.length)throw new HealthLoopRequestError('Invalid string array');return v.map(item=>{if(typeof item!=='string'||item.length<1||item.length>itemMax||SENSITIVE_VALUE.test(item))throw new HealthLoopRequestError('Invalid string array');return item})}
function safeFilename(v:string):string{if(!v||v.length>255||v.includes('/')||v.includes('\\')||v.includes(':')||/[\x00-\x1f]/.test(v))throw new HealthLoopRequestError('Invalid filename');return v}
function actorUserId(ctx:Context):string{const id=ctx.state.user?.id;if((typeof id!=='number'||!Number.isSafeInteger(id)||id<1)&&typeof id!=='string')throw coded('HEALTH_ACTOR_UNAVAILABLE');return requiredId(String(id))}
function pathId(ctx:Context):string{let raw=String(ctx.params.id??'');try{raw=decodeURIComponent(raw)}catch{throw new HealthLoopRequestError('Invalid path identifier')}return requiredId(raw)}
function pathArtifactId(ctx:Context):string{const id=pathId(ctx);if(!/^artifact-[a-f0-9]{64}$/.test(id))throw new HealthLoopRequestError('Invalid artifact identifier');return id}
function noQuery(ctx:Context):void{queryKeys(ctx,new Set())}
function queryKeys(ctx:Context,allowed:Set<string>):void{if(!isPlain(ctx.query))throw new HealthLoopRequestError('Invalid query');for(const key of Object.keys(ctx.query))if(!allowed.has(key))throw new HealthLoopRequestError('Unexpected query parameter')}
function queryEnum<T extends string>(ctx:Context,key:string,values:readonly T[]):T|undefined{const v=ctx.query[key];return v===undefined?undefined:requiredEnum(v,values)}
function queryInteger(ctx:Context,key:string,min:number,max:number):number|undefined{const v=ctx.query[key];if(v===undefined)return undefined;if(typeof v!=='string'||!/^(0|[1-9]\d*)$/.test(v))throw new HealthLoopRequestError('Invalid query integer');return requiredInteger(Number(v),min,max)}

function coded(code:string):Error{return Object.assign(new Error(code),{code})}
function forbidden():Error{return Object.assign(new Error('HEALTH_LIVE_ENABLEMENT_FORBIDDEN'),{status:403,code:'HEALTH_LIVE_ENABLEMENT_FORBIDDEN'})}
function tooLarge():Error{return Object.assign(new Error('HEALTH_ARTIFACT_TOO_LARGE'),{status:413,code:'HEALTH_ARTIFACT_TOO_LARGE'})}
async function respond(ctx:Context,work:()=>unknown|Promise<unknown>):Promise<void>{try{ctx.body=await work()}catch(error){const status=(error as any)?.status;const code=(error as any)?.code??(error instanceof Error?error.message:'');if(status===403){ctx.status=403;ctx.body={error:'Forbidden',code:'HEALTH_LIVE_ENABLEMENT_FORBIDDEN'};return}if(status===413){ctx.status=413;ctx.body={error:'Upload too large',code:'HEALTH_ARTIFACT_TOO_LARGE'};return}if(error instanceof HealthLoopRequestError){ctx.status=400;ctx.body={error:'Invalid health loop request',code:'HEALTH_REQUEST_INVALID'};return}const safe=typeof code==='string'&&/^HEALTH_[A-Z0-9_]{2,100}$/.test(code)?code:'HEALTH_LOOP_OPERATION_FAILED';ctx.status=safe.endsWith('_NOT_FOUND')?404:safe.endsWith('_CONFLICT')?409:503;ctx.body={error:'Health loop operation failed',code:safe}}}
