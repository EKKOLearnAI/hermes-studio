import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ARTIFACT=`artifact-${'a'.repeat(64)}`
const DIGEST='b'.repeat(64)
const TOKEN='c'.repeat(64)
const settingsValue={subjectId:'person:self',liveDeliveryEnabled:false,profile:'default',recipient:'configured-self',
  configuredConnectors:['health-state'],configuredProcessors:['vision'],version:1,actorUserId:'system',updatedAt:'2026-07-14T00:00:00.000Z'}
const fabric=vi.hoisted(()=>({createFabricIntent:vi.fn()}))
const vault=vi.hoisted(()=>({store:vi.fn(),read:vi.fn()}))
const broker=vi.hoisted(()=>({issue:vi.fn(),revoke:vi.fn(),reserve:vi.fn()}))
const settings=vi.hoisted(()=>({getHealthAutomationSettings:vi.fn(),updateHealthAutomationSettings:vi.fn()}))
const outcomes=vi.hoisted(()=>({recordHealthOutcome:vi.fn(),HEALTH_OUTCOMES:['completed','partial','skipped','deferred','adverse_feedback','unsuitable','data_incorrect','expired']}))
const database=vi.hoisted(()=>({withPersonalTwinDb:vi.fn()}))
const status=vi.hoisted(()=>vi.fn())

vi.mock('../../packages/server/src/services/hermes/action-fabric',()=>fabric)
vi.mock('../../packages/server/src/services/hermes/health-loop/artifacts',()=>({createHealthArtifactVault:()=>vault}))
vi.mock('../../packages/server/src/services/hermes/health-loop/consent',()=>({createHealthConsentBroker:()=>broker,HEALTH_PROCESSING_RETENTIONS:['no_retention','session','24_hours']}))
vi.mock('../../packages/server/src/services/hermes/health-loop/settings',()=>settings)
vi.mock('../../packages/server/src/services/hermes/health-loop/outcomes',()=>outcomes)
vi.mock('../../packages/server/src/services/hermes/health-loop/runtime-dependencies',()=>({createDurableHealthAnalysisServices:()=>({artifactResolver:{resolve:vi.fn(async()=>({artifactId:ARTIFACT,manifestDigest:DIGEST}))}})}))
vi.mock('../../packages/server/src/services/hermes/health-loop/connectors/health-state',()=>({createHealthStateConnector:()=>({id:'health-state',domains:['diet'],status})}))
vi.mock('../../packages/server/src/services/hermes/health-loop/connectors/s400',()=>({createS400HealthConnector:()=>({id:'s400',domains:['body_composition'],status})}))
vi.mock('../../packages/server/src/services/hermes/health-loop/connectors',()=>({createHealthConnectorRegistry:(items:any[])=>({list:()=>items,get:(id:string)=>items.find(item=>item.id===id)})}))
vi.mock('../../packages/server/src/services/hermes/personal-twin/database',()=>database)

function ctx(body?:unknown,options:{id?:string;role?:string;query?:Record<string,string>}={}):any{return {params:{id:options.id??'health-state'},query:options.query??{},
  request:{body},state:{user:{id:42,username:'root',role:options.role??'super_admin'}},body:null,status:200,
  get:vi.fn(()=>''),req:Readable.from([])}}
function multipart():{contentType:string;body:Buffer}{const boundary='health-boundary';const body=Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="sourceId"\r\n\r\nupload-1\r\n`+
  `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"healthAnalysis":{"purpose":"diet"}}\r\n`+
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="meal.json"\r\nContent-Type: application/json\r\n\r\n{}\r\n`+
  `--${boundary}--\r\n`);return {contentType:`multipart/form-data; boundary=${boundary}`,body}}

describe('health loop controller',()=>{
  beforeEach(()=>{vi.clearAllMocks();settings.getHealthAutomationSettings.mockReturnValue({...settingsValue});settings.updateHealthAutomationSettings.mockReturnValue({...settingsValue,version:2,actorUserId:'42'});
    status.mockResolvedValue({configured:true,configurationState:'configured',authorizationState:'authorized',health:'healthy',domains:['diet'],freshnessByDomain:{},capabilities:{read:['diet'],write:[]}})
    fabric.createFabricIntent.mockReturnValue({intent:{id:'intent-1',capabilityId:'health.source.sync'},policyDecision:{id:'decision-1',outcome:'waiting_user',reasonCodes:['approval'],policySnapshot:{token:'no'}},workflow:{id:'wf-1',state:'waiting_user',version:1,availableActions:{approve:true}}})
    vault.store.mockResolvedValue({id:ARTIFACT,mediaType:'application/json',sizeBytes:2,relativePath:'private/path',contentHash:'a'.repeat(64),metadata:{healthAnalysis:{purpose:'diet'},token:'hidden'},source:'health-loop-api',sourceId:'upload-1',sensitivity:'health',createdAt:'2026-07-14T00:00:00.000Z'})
    broker.issue.mockResolvedValue({consentId:'consent-1',manifestDigest:DIGEST,token:TOKEN,manifest:{artifactIds:[ARTIFACT],processor:'vision',purpose:'diet',selectedRegions:[],requestedFields:['caloriesKcal'],retention:'session'},issuedAt:'2026-07-14T00:00:00.000Z',expiresAt:'2026-07-14T00:05:00.000Z'})
    broker.reserve.mockResolvedValue({reservationId:'reservation-1',consentId:'consent-1',expiresAt:'2026-07-14T00:05:00.000Z'})
    broker.revoke.mockResolvedValue({consentId:'consent-1',revokedAt:'2026-07-14T00:01:00.000Z'})
    outcomes.recordHealthOutcome.mockReturnValue({feedbackId:'feedback-1',outcome:'completed',actionId:'action-1',interventionId:'intervention-1',workflowId:'wf-1',userId:'user-self',occurredAt:'2026-07-14T00:02:00.000Z',reviewRequired:false,supersededActionIds:[]})
    database.withPersonalTwinDb.mockImplementation((fn:any)=>fn({prepare:(sql:string)=>({get:()=>sql.includes('WHERE intervention_id')?{action_id:'action-1',intervention_id:'intervention-1',workflow_id:'wf-1',user_id:'user-self'}:{count:1},all:()=>[{action_id:'action-1',intervention_id:'intervention-1',workflow_id:'wf-1',capability_id:'health.plan.adjust',category:'training',priority:1,risk:'low',authority:'approval',status:'active',effective_date:'2026-07-14',created_at:'2026-07-14T00:00:00.000Z',superseded_at:null}]})}))})

  it('serves all reads without leaking service-private state',async()=>{const ctrl=await import('../../packages/server/src/controllers/hermes/health-loop');
    for(const handler of [ctrl.overview,ctrl.connectors,ctrl.interventions,ctrl.settings]){const c=ctx();await handler(c);expect(c.status).toBe(200);expect(JSON.stringify(c.body)).not.toMatch(/actorUserId|relativePath|policySnapshot|credential|token/i)}})

  it('routes sync and local analysis through Fabric with authenticated actor and no body identity fields',async()=>{const ctrl=await import('../../packages/server/src/controllers/hermes/health-loop');
    const sync=ctx({idempotencyKey:'sync-1',requestedByUserId:'forged'});await ctrl.syncConnector(sync);expect(sync.status).toBe(400);expect(fabric.createFabricIntent).not.toHaveBeenCalled()
    const good=ctx({idempotencyKey:'sync-1'});await ctrl.syncConnector(good);expect(fabric.createFabricIntent).toHaveBeenCalledWith(expect.objectContaining({requestedByUserId:'42',capabilityId:'health.source.sync'}));expect(good.status).toBe(202)
    const analyze=ctx({mode:'local',manifestDigest:DIGEST,idempotencyKey:'analysis-1'},{id:ARTIFACT});await ctrl.analyzeArtifact(analyze);expect(fabric.createFabricIntent).toHaveBeenLastCalledWith(expect.objectContaining({requestedByUserId:'42',capabilityId:'health.artifact.analyze.local'}));expect(JSON.stringify(analyze.body)).not.toMatch(/policySnapshot|token/i)})

  it('stores a bounded multipart artifact and returns only sanitized metadata',async()=>{const ctrl=await import('../../packages/server/src/controllers/hermes/health-loop');const input=multipart();const c=ctx();c.get=vi.fn((name:string)=>name==='content-type'?input.contentType:String(input.body.length));c.req=Readable.from([input.body]);await ctrl.createArtifact(c);expect(c.status).toBe(201);expect(c.body.artifact).toMatchObject({id:ARTIFACT,manifestDigest:DIGEST});expect(JSON.stringify(c.body)).not.toMatch(/private\/path|hidden|token/i)})

  it('issues a one-time token only on consent creation, reserves it for remote analysis, and never echoes it afterward',async()=>{const ctrl=await import('../../packages/server/src/controllers/hermes/health-loop');const manifest={artifactIds:[ARTIFACT],processor:'vision',purpose:'diet',selectedRegions:[],requestedFields:['caloriesKcal'],retention:'session'};const create=ctx({manifest});await ctrl.createConsent(create);expect(create.body.consent.token).toBe(TOKEN)
    const analyze=ctx({mode:'remote',manifestDigest:DIGEST,processorId:'vision',consentToken:TOKEN,manifest},{id:ARTIFACT});await ctrl.analyzeArtifact(analyze);expect(broker.reserve).toHaveBeenCalledWith(TOKEN,manifest,expect.objectContaining({artifactId:ARTIFACT}));expect(JSON.stringify(analyze.body)).not.toContain(TOKEN)
    const revoke=ctx(undefined,{id:'consent-1'});await ctrl.revokeConsent(revoke);expect(JSON.stringify(revoke.body)).not.toMatch(/token/i)})

  it('binds feedback and settings actors to authenticated/server state and gates live enablement',async()=>{const ctrl=await import('../../packages/server/src/controllers/hermes/health-loop');const feedback=ctx({feedbackId:'feedback-1',outcome:'completed',occurredAt:'2026-07-14T00:02:00Z'},{id:'intervention-1'});await ctrl.interventionFeedback(feedback);expect(outcomes.recordHealthOutcome).toHaveBeenCalledWith(expect.objectContaining({userId:'user-self',workflowId:'wf-1'}))
    const update={expectedVersion:1,liveDeliveryEnabled:false,profile:'default',recipient:'configured-self'};const safe=ctx(update,{role:'member'});await ctrl.updateSettings(safe);expect(settings.updateHealthAutomationSettings).toHaveBeenCalledWith(expect.objectContaining({actorUserId:'42'}))
    const live=ctx({...update,liveDeliveryEnabled:true},{role:'member'});await ctrl.updateSettings(live);expect(live.status).toBe(403)})

  it('rejects oversize upload preflight and sanitizes raw provider/path errors',async()=>{const ctrl=await import('../../packages/server/src/controllers/hermes/health-loop');const large=ctx();large.get=vi.fn((name:string)=>name==='content-type'?'multipart/form-data; boundary=x':String(300*1024*1024));await ctrl.createArtifact(large);expect(large.status).toBe(413)
    fabric.createFabricIntent.mockImplementationOnce(()=>{throw new Error('sqlite C:\\Users\\alice\\health.db token=secret')});const failed=ctx({idempotencyKey:'sync-2'});await ctrl.syncConnector(failed);expect(failed.status).toBe(503);expect(JSON.stringify(failed.body)).not.toMatch(/sqlite|alice|secret|health\.db/i)})
})
