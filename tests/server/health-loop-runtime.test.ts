import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('health-loop runtime', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwui-health-runtime-'))
    process.env.HERMES_HOME = home
  })

  afterEach(async () => {
    const runtime = await import('../../packages/server/src/services/hermes/health-loop/runtime')
    await runtime.stopHealthLoopRuntime()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('serializes concurrent start and stop and stops the consumer before Fabric', async () => {
    const { createHealthLoopLifecycle } = await import('../../packages/server/src/services/hermes/health-loop/runtime')
    const events: string[] = []
    const lifecycle = createHealthLoopLifecycle({
      async prepare() { events.push('prepare') },
      async startFabric() { events.push('fabric:start') },
      async startConsumer() { events.push('consumer:start') },
      async stopConsumer() { events.push('consumer:stop') },
      async stopFabric() { events.push('fabric:stop') },
    })
    await Promise.all([lifecycle.start(), lifecycle.start(), lifecycle.start()])
    await Promise.all([lifecycle.stop(), lifecycle.stop()])
    expect(events).toEqual(['prepare', 'fabric:start', 'consumer:start', 'consumer:stop', 'fabric:stop'])
  })

  it('always stops Fabric and preserves the consumer error when consumer teardown rejects', async () => {
    const {createHealthLoopLifecycle}=await import('../../packages/server/src/services/hermes/health-loop/runtime')
    const events:string[]=[]
    const lifecycle=createHealthLoopLifecycle({async prepare(){},async startFabric(){},async startConsumer(){},
      async stopConsumer(){events.push('consumer');throw new Error('CONSUMER_STOP_FAILED')},
      async stopFabric(){events.push('fabric');throw new Error('FABRIC_STOP_FAILED')}})
    await lifecycle.start()
    await expect(lifecycle.stop()).rejects.toThrow('CONSUMER_STOP_FAILED')
    expect(events).toEqual(['consumer','fabric'])
  })

  it('leases one immutable Twin outbox id to one runtime, reclaims stale leases, and deduplicates receipts', async () => {
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const store = await import('../../packages/server/src/services/hermes/health-loop/runtime-store')
    withPersonalTwinDb(db => db.prepare(`INSERT INTO twin_outbox
      (id,topic,aggregate_id,payload_json,status,attempts,available_at,created_at)
      VALUES('outbox-1','twin.observation.recorded','observation-1','{"recordId":"observation-1"}',
      'pending',0,'2026-07-14T00:00:00.000Z','2026-07-14T00:00:00.000Z')`).run())

    const first = store.claimHealthOutboxDelivery({ consumerId: 'health-loop-v1', workerId: 'worker-a',
      now: '2026-07-14T00:00:01.000Z', leaseMs: 1_000, maxAttempts: 3 })
    expect(first).toMatchObject({ outboxId: 'outbox-1', topic: 'twin.observation.recorded', attempt: 1 })
    expect(store.claimHealthOutboxDelivery({ consumerId: 'health-loop-v1', workerId: 'worker-b',
      now: '2026-07-14T00:00:01.500Z', leaseMs: 1_000, maxAttempts: 3 })).toBeNull()
    const reclaimed = store.claimHealthOutboxDelivery({ consumerId: 'health-loop-v1', workerId: 'worker-b',
      now: '2026-07-14T00:00:02.001Z', leaseMs: 1_000, maxAttempts: 3 })
    expect(reclaimed).toMatchObject({ outboxId: 'outbox-1', attempt: 2 })
    expect(()=>store.completeHealthOutboxDelivery(first!,{intentId:'stale',workflowId:'stale'},
      '2026-07-14T00:00:02.050Z')).toThrow('HEALTH_RUNTIME_LEASE_LOST')
    store.completeHealthOutboxDelivery(reclaimed!, { intentId: 'intent-1', workflowId: 'workflow-1' },
      '2026-07-14T00:00:02.100Z')
    expect(store.claimHealthOutboxDelivery({ consumerId: 'health-loop-v1', workerId: 'worker-a',
      now: '2026-07-14T00:00:03.000Z', leaseMs: 1_000, maxAttempts: 3 })).toBeNull()
    expect(withPersonalTwinDb(db => db.prepare('SELECT status,intent_id,workflow_id FROM twin_health_outbox_deliveries').get()))
      .toEqual({ status: 'completed', intent_id: 'intent-1', workflow_id: 'workflow-1' })
  })

  it('dead-letters poison rows after bounded attempts with only a sanitized code', async () => {
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const store = await import('../../packages/server/src/services/hermes/health-loop/runtime-store')
    withPersonalTwinDb(db => db.prepare(`INSERT INTO twin_outbox
      (id,topic,aggregate_id,payload_json,status,attempts,available_at,created_at)
      VALUES('outbox-poison','twin.observation.recorded','observation-x','not-json','pending',0,?,?)`)
      .run('2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claim = store.claimHealthOutboxDelivery({ consumerId: 'health-loop-v1', workerId: 'worker-a',
        now: `2026-07-14T00:00:0${attempt + 1}.000Z`, leaseMs: 1, maxAttempts: 3 })!
      store.failHealthOutboxDelivery(claim, 'token.sk_live_secret', `2026-07-14T00:00:0${attempt + 1}.001Z`, 3)
    }
    expect(withPersonalTwinDb(db => db.prepare('SELECT status,last_error_code,attempts FROM twin_health_outbox_deliveries').get()))
      .toEqual({ status: 'dead_letter', last_error_code: 'HEALTH_RUNTIME_PROCESSING_FAILED', attempts: 3 })
  })

  it('defaults to shadow and changes live delivery only through audited CAS settings', async () => {
    const { getHealthAutomationSettings, updateHealthAutomationSettings } = await import(
      '../../packages/server/src/services/hermes/health-loop/settings'
    )
    expect(getHealthAutomationSettings()).toMatchObject({ liveDeliveryEnabled: false, version: 1 })
    const live = updateHealthAutomationSettings({ expectedVersion: 1, liveDeliveryEnabled: true,
      actorUserId: 'admin-1', profile: 'default', recipient: 'configured-self' })
    expect(live).toMatchObject({ liveDeliveryEnabled: true, version: 2, actorUserId: 'admin-1' })
    expect(() => updateHealthAutomationSettings({ expectedVersion: 1, liveDeliveryEnabled: false,
      actorUserId: 'admin-1', profile: 'default', recipient: 'configured-self' })).toThrow('HEALTH_SETTINGS_CONFLICT')
  })

  it('loads the exact trusted nine-projection snapshot and replays the same Fabric key after effect-before-ack crash', async () => {
    const health = await import('../../packages/server/src/services/hermes/health-loop')
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    const { createHealthOutboxProcessor } = await import('../../packages/server/src/services/hermes/health-loop/runtime')
    health.ingestHealthEnvelope({ domain: 'sleep', source: 'runtime-fixture', sourceId: 'sleep-low',
      observedAt: '2026-07-14T08:00:00.000Z', evidenceClass: 'measured', confidence: 0.95,
      payload: { startedAt: '2026-07-14T03:00:00.000Z', endedAt: '2026-07-14T08:00:00.000Z',
        durationMinutes: 300, interruptions: 1, freshnessMinutes: 5 } })
    health.projectHealthState(twin.listTwinObservations({ entityId: 'person:self' }), {
      computedAt: '2026-07-14T08:05:00.000Z',
    })
    const calls: Array<{ idempotencyKey:string; environments?:string[] }> = []
    let crash = true
    const make = (workerId:string) => createHealthOutboxProcessor({ consumerId: 'health-loop-v1', workerId,
      now: () => '2026-07-14T08:05:01.000Z', createIntent(input) {
        calls.push({ idempotencyKey: input.idempotencyKey, environments: input.environments })
        return { intentId: 'intent-stable', workflowId: 'workflow-stable' }
      }, afterIntent() { if (crash) { crash = false; throw new Error('HEALTH_RUNTIME_SIMULATED_CRASH') } } })
    await expect(make('worker-a').processOnce()).rejects.toThrow('HEALTH_RUNTIME_SIMULATED_CRASH')
    const originalPrepared=twin.withPersonalTwinDb(db=>(db.prepare('SELECT prepared_json FROM twin_health_outbox_deliveries').get() as
      {prepared_json:string}).prepared_json)
    expect(()=>twin.withPersonalTwinDb(db=>db.prepare(`UPDATE twin_health_outbox_deliveries
      SET prepared_json=NULL,prepared_digest=NULL,prepared_at=NULL`).run())).toThrow('HEALTH_PREPARED_IMMUTABLE')
    const replacePrepared=(value:string)=>twin.withPersonalTwinDb(db=>{db.exec('DROP TRIGGER twin_health_delivery_prepared_immutable')
      db.prepare('UPDATE twin_health_outbox_deliveries SET prepared_json=?').run(value)
      db.exec(`CREATE TRIGGER twin_health_delivery_prepared_immutable BEFORE UPDATE ON twin_health_outbox_deliveries
        WHEN OLD.prepared_json IS NOT NULL AND (NEW.prepared_json IS NOT OLD.prepared_json OR
          NEW.prepared_digest IS NOT OLD.prepared_digest OR NEW.prepared_at IS NOT OLD.prepared_at)
        BEGIN SELECT RAISE(ABORT,'HEALTH_PREPARED_IMMUTABLE'); END;`)})
    replacePrepared(originalPrepared.replace('health-runtime-prepared/v1','health-runtime-prepared/v2'))
    await expect(make('worker-tamper').processOnce({now:'2026-07-14T08:05:32.000Z'})).resolves.toMatchObject({outcome:'failed'})
    expect(calls).toHaveLength(1)
    expect(twin.withPersonalTwinDb(db=>db.prepare('SELECT last_error_code FROM twin_health_outbox_deliveries').get()))
      .toEqual({last_error_code:'HEALTH_RUNTIME_PREPARED_INVALID'})
    replacePrepared(originalPrepared)
    const settings=(await import('../../packages/server/src/services/hermes/health-loop/settings'))
    settings.updateHealthAutomationSettings({expectedVersion:1,liveDeliveryEnabled:true,actorUserId:'admin-1',
      profile:'default',recipient:'configured-self',updatedAt:'2026-07-15T00:00:00.000Z'})
    twin.withPersonalTwinDb(db=>db.prepare(`UPDATE twin_health_plans SET version=2,state_json='{"trainingIntensity":"low"}',
      digest=?,updated_at=? WHERE plan_id='health-plan-default'`).run(
        createHash('sha256').update('{"trainingIntensity":"low"}').digest('hex'),'2026-07-15T00:00:00.000Z'))
    health.ingestHealthEnvelope({domain:'sleep',source:'runtime-fixture',sourceId:'sleep-changed',
      observedAt:'2026-07-15T08:00:00.000Z',evidenceClass:'measured',confidence:0.95,
      payload:{startedAt:'2026-07-15T00:00:00.000Z',endedAt:'2026-07-15T08:00:00.000Z',durationMinutes:480,interruptions:0}})
    health.projectHealthState(twin.listTwinObservations({entityId:'person:self'}),{computedAt:'2026-07-15T08:05:00.000Z'})
    const restarted = make('worker-b')
    await expect(restarted.processOnce({ now: '2026-07-15T08:05:32.000Z' })).resolves.toMatchObject({ processed: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(calls[0].environments).toEqual(['sandbox'])
    expect(calls[0].idempotencyKey).toMatch(/^health-intervention-[a-f0-9]{64}$/)
    expect(twin.withPersonalTwinDb(db => db.prepare('SELECT COUNT(*) AS n FROM twin_health_actions').get()))
      .toEqual({ n: 1 })
    await expect(restarted.processOnce({now:'2026-07-15T08:05:33.000Z'})).resolves.toMatchObject({processed:true})
    expect(calls).toHaveLength(2)
    const {recordHealthOutcome}=await import('../../packages/server/src/services/hermes/health-loop/outcomes')
    recordHealthOutcome({feedbackId:'feedback-runtime',outcome:'completed',actionId:`health-action-${calls[0].idempotencyKey.slice('health-intervention-'.length)}`,
      interventionId:'health.training.reduce_after_low_sleep',workflowId:'workflow-stable',userId:'user-self',
      occurredAt:'2026-07-15T08:05:34.000Z'})
    await expect(restarted.processOnce({now:'2026-07-15T08:05:35.000Z'})).resolves.toMatchObject({processed:true})
    expect(calls).toHaveLength(2)
  })

  it('fails closed when the trusted projection batch is incomplete or corrupt', async () => {
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const { createHealthOutboxProcessor } = await import('../../packages/server/src/services/hermes/health-loop/runtime')
    withPersonalTwinDb(db => {
      db.prepare(`INSERT INTO twin_outbox(id,topic,aggregate_id,payload_json,status,available_at,created_at)
        VALUES('outbox-incomplete','twin.observation.recorded','observation-1',
          '{"recordId":"observation-1","metric":"health.sleep.duration_minutes","source":"fixture","sourceId":"one"}',
          'pending','2026-07-14T00:00:00.000Z','2026-07-14T00:00:00.000Z')`).run()
    })
    const processor = createHealthOutboxProcessor({ consumerId:'health-loop-v1',workerId:'worker-a',
      now:()=> '2026-07-14T00:00:01.000Z', createIntent(){ throw new Error('must not execute') } })
    await expect(processor.processOnce()).resolves.toMatchObject({ processed:true, outcome:'failed' })
    expect(withPersonalTwinDb(db => db.prepare('SELECT last_error_code FROM twin_health_outbox_deliveries').get()))
      .toEqual({ last_error_code:'HEALTH_RUNTIME_PROJECTION_SNAPSHOT_INVALID' })
  })

  it('replays durable plan/followup/source effects across fresh repository instances and rejects material conflicts', async () => {
    const deps = await import('../../packages/server/src/services/hermes/health-loop/runtime-dependencies')
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const initial = { trainingIntensity:'high' }
    const initialDigest = createHash('sha256').update('{"trainingIntensity":"high"}').digest('hex')
    withPersonalTwinDb(db => db.prepare(`INSERT INTO twin_health_plans(plan_id,version,digest,state_json,updated_at)
      VALUES('plan-1',1,?,?,?)`).run(initialDigest,JSON.stringify(initial),'2026-07-14T00:00:00.000Z'))
    const repo = deps.createDurableHealthPlanRepository()
    const adjusted = await repo.adjust({ planId:'plan-1',expectedVersion:1,expectedDigest:initialDigest,
      operation:{operation:'reduce_training_intensity',maximumIntensity:'low'},executionToken:'plan-token-1',
      materialDigest:'a'.repeat(64) })
    expect(adjusted?.current.version).toBe(2)
    expect(await deps.createDurableHealthPlanRepository().adjust({ planId:'plan-1',expectedVersion:1,
      expectedDigest:initialDigest,operation:{operation:'reduce_training_intensity',maximumIntensity:'low'},
      executionToken:'plan-token-1',materialDigest:'a'.repeat(64) })).toEqual(adjusted)
    await expect(repo.adjust({ planId:'plan-1',expectedVersion:1,expectedDigest:initialDigest,operation:{},
      executionToken:'plan-token-1',materialDigest:'b'.repeat(64) })).rejects.toThrow('HEALTH_EXECUTION_TOKEN_MATERIAL_CONFLICT')
    expect(await repo.restore({ planId:'plan-1',expectedCurrentVersion:2,expectedCurrentDigest:adjusted!.current.digest,
      restoreVersion:1,restoreDigest:initialDigest,executionToken:'restore-token-1',materialDigest:'c'.repeat(64) }))
      .toEqual({planId:'plan-1',version:1,digest:initialDigest})
    const followup = await repo.scheduleFollowup!({followupId:'followup-1',ownerUserId:'user-1',category:'measurement',
      operation:'schedule_provider_flag_review',reasonCode:'source_reported_marker_flag',
      dueAt:'2026-07-15T00:00:00.000Z',executionToken:'followup-token',materialDigest:'d'.repeat(64)})
    expect(await deps.createDurableHealthPlanRepository().scheduleFollowup!({followupId:'followup-1',ownerUserId:'user-1',
      category:'measurement',operation:'schedule_provider_flag_review',reasonCode:'source_reported_marker_flag',
      dueAt:'2026-07-15T00:00:00.000Z',executionToken:'followup-token',materialDigest:'d'.repeat(64)})).toEqual(followup)

    const sync = vi.fn(async () => ({connectorId:'fixture',attemptedCount:2,ingestedCount:2}))
    const connector = {id:'fixture',domains:['sleep'] as const,capabilities:{read:['sleep'] as const,write:[]},
      status:async()=>({configured:true,configurationState:'configured' as const,authorizationState:'not_required' as const,
        health:'healthy' as const,domains:['sleep'] as const,freshnessByDomain:{},capabilities:{read:['sleep'] as const,write:[]}}),sync}
    const source = deps.createDurableHealthSourceService('default',[connector])
    const sourceRequest={connectorId:'fixture',requestedAt:'2026-07-14T00:00:00.000Z',cursor:null,
      executionToken:'source-token',materialDigest:'e'.repeat(64)}
    const sourceResult=await source.write(sourceRequest)
    expect(await deps.createDurableHealthSourceService('default',[connector]).lookup('source-token','e'.repeat(64))).toEqual(sourceResult)
    expect(sync).toHaveBeenCalledOnce()
  })

  it('persists analysis observations and verified receipts in a restart-safe result ledger', async () => {
    const { createDurableHealthAnalysisServices } = await import(
      '../../packages/server/src/services/hermes/health-loop/runtime-dependencies'
    )
    const { listTwinObservations } = await import('../../packages/server/src/services/hermes/personal-twin')
    const artifactId=`artifact-${'a'.repeat(64)}`
    const result = { schemaVersion:'health-analysis-result/v1' as const,purpose:'skin' as const,status:'completed' as const,
      modelVersion:'vision-1',parserVersion:'vision-json-v1',overallConfidence:0.9,
      captureQuality:{score:0.9,reasons:[]},fields:[{field:'appearances',value:[],confidence:0.9,
        evidence:{artifactId,region:'face'}}],envelope:{domain:'skin' as const,source:'analysis.remote',sourceId:'analysis-source',
        observedAt:'2026-07-14T01:00:00.000Z',evidenceClass:'inferred' as const,confidence:0.9,
        payload:{appearances:[],captureQuality:0.9},artifactIds:[artifactId],parserVersion:'vision-json-v1'} }
    const writer=createDurableHealthAnalysisServices().resultWriter
    const request={executionToken:'analysis-token',materialDigest:'f'.repeat(64),artifactId,
      manifestDigest:'1'.repeat(64),processorId:'processor-1',reservationId:'reservation-1',
      requestedAt:'2026-07-14T01:00:00.000Z',result,processorReceiptId:'receipt-1'}
    const stored=await writer.write(request)
    expect(stored).toMatchObject({verificationStatus:'verified',processorReceiptId:'receipt-1',
      observationIds:expect.arrayContaining([expect.any(String)])})
    expect(await createDurableHealthAnalysisServices().resultWriter.lookup('analysis-token','f'.repeat(64))).toEqual(stored)
    expect(listTwinObservations({entityId:'person:self'}).length).toBeGreaterThan(0)
  })

  it('grants standing authorization only from current server state and revokes live/expired evidence', async () => {
    const { createHealthRuntimeAuthorizationProvider } = await import(
      '../../packages/server/src/services/hermes/health-loop/runtime-authorization'
    )
    const { getHealthAutomationSettings, updateHealthAutomationSettings } = await import(
      '../../packages/server/src/services/hermes/health-loop/settings'
    )
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-07-14T01:00:00.000Z'))
    const provider=createHealthRuntimeAuthorizationProvider('default',{connectors:['fixture'],remoteProcessors:['processor-1']})
    const reminder={capabilityId:'health.reminder.send',requestedByUserId:'user-1',targetAtoms:['health:recipient:configured-self'],
      executorId:'health-weixin',environment:'production' as const,input:{recipient:'configured-self'},
      requirements:['live_mode:enabled','recipient:configured_self']}
    expect(provider.authorize(reminder)).toBeNull()
    writeFileSync(join(home,'.env'),'WEIXIN_ACCOUNT_ID=account-1\nWEIXIN_TOKEN=secret-value\nWEIXIN_HOME_CHANNEL=home-1\n')
    const current=getHealthAutomationSettings()
    updateHealthAutomationSettings({expectedVersion:current.version,liveDeliveryEnabled:true,actorUserId:'admin-1',
      profile:'default',recipient:'configured-self',configuredConnectors:['fixture'],configuredProcessors:['processor-1'],
      updatedAt:'2026-07-14T01:00:00.000Z'})
    const artifactId=`artifact-${'a'.repeat(64)}`;const contentHash='b'.repeat(64)
    const manifest=createHash('sha256').update(JSON.stringify({artifactId,contentHash,mediaType:'application/json',
      relativePath:'aa/artifact',schemaVersion:1,sizeBytes:10})).digest('hex')
    withPersonalTwinDb(db=>{
      db.prepare(`INSERT INTO twin_artifacts(id,media_type,content_hash,relative_path,size_bytes,source,source_id,created_at,sensitivity,metadata_json)
        VALUES(?,'application/json',?,'aa/artifact',10,'test','artifact-1',?,'health','{}')`).run(artifactId,contentHash,'2026-07-14T00:00:00.000Z')
      db.prepare(`INSERT INTO twin_health_plans(plan_id,version,digest,state_json,updated_at)
        VALUES('plan-auth',1,?,'{}',?)`).run(createHash('sha256').update('{}').digest('hex'),'2026-07-14T00:00:00.000Z')
      const consent=`consent-${'c'.repeat(32)}`;const reservation=`reservation-${'1'.repeat(36)}`
      db.prepare(`INSERT INTO twin_artifact_consents
        (consent_id,manifest_digest,processor,scope_json,issued_at,expires_at,consumed_at,revoked_at)
        VALUES(?,?,?,'{}',?,?,NULL,NULL)`).run(consent,manifest,'processor-1','2026-07-14T00:00:00.000Z','2026-07-14T02:00:00.000Z')
      db.prepare(`INSERT INTO twin_artifact_consent_reservations
        (reservation_id,consent_id,artifact_id,artifact_manifest_digest,processor,reserved_at,expires_at,consumed_at)
        VALUES(?,?,?,?,?,?,?,NULL)`).run(reservation,consent,artifactId,manifest,'processor-1',
        '2026-07-14T00:00:00.000Z','2026-07-14T02:00:00.000Z')
    })
    const requests=[reminder,
      {capabilityId:'health.source.sync',requestedByUserId:'user-1',targetAtoms:['health:connector:fixture'],executorId:'health-source',
        environment:'production' as const,input:{connectorId:'fixture'},requirements:['connector_credential:configured']},
      {capabilityId:'health.artifact.analyze.local',requestedByUserId:'user-1',targetAtoms:[`health:artifact:${artifactId}:${manifest}`],executorId:'health-local-analysis',
        environment:'production' as const,input:{artifactId,manifestDigest:manifest},requirements:['artifact:local_read']},
      {capabilityId:'health.artifact.analyze.remote',requestedByUserId:'user-1',targetAtoms:[`health:artifact:${artifactId}:${manifest}`,'health:processor:processor-1'],executorId:'health-remote-analysis',
        environment:'production' as const,input:{artifactId,manifestDigest:manifest,processorId:'processor-1',consentId:`reservation-${'1'.repeat(36)}`},requirements:['one_time_consent:exact_artifact_manifest','processor:exact_id']},
      {capabilityId:'health.plan.adjust',requestedByUserId:'user-1',targetAtoms:['health:plan:plan-auth'],executorId:'health-plan',
        environment:'production' as const,input:{planId:'plan-auth',expectedVersion:1},requirements:['health_plan:write']},
      {capabilityId:'health.followup.schedule',requestedByUserId:'user-1',targetAtoms:['health:owner:user-1'],executorId:'health-plan',
        environment:'production' as const,input:{ownerUserId:'user-1'},requirements:['health_schedule:write']},]
    const firstGrants=requests.map(request=>provider.authorize(request))
    expect(firstGrants).toEqual(requests.map(()=>expect.objectContaining({authorizationVersion:2,
      expiresAt:'2026-07-14T01:00:30.000Z'})))
    vi.setSystemTime(new Date('2026-07-14T01:00:10.000Z'))
    expect(requests.map(request=>provider.authorize(request))).toEqual(firstGrants)
    const unavailable=createHealthRuntimeAuthorizationProvider('default')
    expect(unavailable.authorize(requests[1])).toBeNull()
    expect(unavailable.authorize(requests[3])).toBeNull()
    updateHealthAutomationSettings({expectedVersion:2,liveDeliveryEnabled:false,actorUserId:'admin-1',profile:'default',
      recipient:'configured-self',configuredConnectors:['fixture'],configuredProcessors:['processor-1'],updatedAt:'2026-07-14T01:00:01.000Z'})
    expect(provider.authorize(reminder)).toBeNull()
    vi.setSystemTime(new Date('2026-07-14T03:00:00.000Z'))
    expect(provider.authorize(requests[3])).toBeNull()
    vi.useRealTimers()
  })
})
