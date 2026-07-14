import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const outcomes = ['completed', 'partial', 'skipped', 'deferred', 'adverse_feedback',
  'unsuitable', 'data_incorrect', 'expired'] as const

describe('health-loop outcomes', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'hwui-health-outcome-'))
    process.env.HERMES_HOME = home
    const { withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    withPersonalTwinDb(db => {
      const insert = db.prepare(`INSERT INTO twin_outbox
        (id,topic,aggregate_id,payload_json,status,attempts,available_at,created_at)
        VALUES(?,'twin.observation.recorded',?,'{}','pending',0,?,?)`)
      insert.run('outbox-1','observation-1','2026-07-14T00:00:00.000Z','2026-07-14T00:00:00.000Z')
      insert.run('outbox-2','observation-2','2026-07-14T00:00:00.000Z','2026-07-14T00:00:00.000Z')
      insert.run('outbox-3','observation-3','2026-07-14T00:00:00.000Z','2026-07-14T00:00:00.000Z')
    })
    const { registerHealthRuntimeAction } = await import('../../packages/server/src/services/hermes/health-loop/outcomes')
    registerHealthRuntimeAction({ actionId: 'action-1', interventionId: 'health.training.reduce_after_low_sleep',
      workflowId: 'workflow-1', userId: 'user-1', capabilityId: 'health.plan.adjust', category:'training',priority: 80,
      supersedable:true,supersedes:[],risk: 'low', authority: 'auto', sourceOutboxId: 'outbox-1', effectiveDate: '2026-07-14' })
    registerHealthRuntimeAction({ actionId: 'action-normal', interventionId: 'health.nutrition.close_protein_gap',
      workflowId: 'workflow-normal', userId: 'user-1', capabilityId: 'health.plan.adjust', category:'nutrition',priority: 20,
      supersedable:true,supersedes:[],risk: 'low', authority: 'auto', sourceOutboxId: 'outbox-2', effectiveDate: '2026-07-14' })
    registerHealthRuntimeAction({actionId:'action-fixed',interventionId:'health.posture.reduce_chain_overload',
      workflowId:'workflow-fixed',userId:'user-1',capabilityId:'health.followup.schedule',category:'posture',priority:10,
      supersedable:false,supersedes:[],risk:'low',authority:'auto',sourceOutboxId:'outbox-3',effectiveDate:'2026-07-14'})
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it.each(outcomes)('records immutable, idempotent %s feedback with exact binding', async outcome => {
    const { recordHealthOutcome } = await import('../../packages/server/src/services/hermes/health-loop/outcomes')
    const { listTwinEvents } = await import('../../packages/server/src/services/hermes/personal-twin')
    const input = { feedbackId: `feedback-${outcome}`, outcome, actionId: 'action-1',
      interventionId: 'health.training.reduce_after_low_sleep', workflowId: 'workflow-1', userId: 'user-1',
      occurredAt: '2026-07-14T12:00:00.000Z' }
    expect(recordHealthOutcome(input)).toMatchObject({ outcome, actionId: 'action-1' })
    expect(recordHealthOutcome(input)).toMatchObject({ outcome, actionId: 'action-1' })
    expect(listTwinEvents({ eventType: `health.outcome.${outcome}` })).toHaveLength(1)
    expect(listTwinEvents({ eventType: 'health.strategy.recomputed' })).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ outcome, safetyPolicy:'unchanged', riskPolicy:'unchanged' }) }),
    ])
    expect(() => recordHealthOutcome({ ...input, workflowId: 'workflow-other' })).toThrow('HEALTH_OUTCOME_BINDING_MISMATCH')
  })

  it('supersedes normal follow-up for adverse feedback and creates review only, never a medical action', async () => {
    const { recordHealthOutcome } = await import('../../packages/server/src/services/hermes/health-loop/outcomes')
    const { listTwinEvents, withPersonalTwinDb } = await import('../../packages/server/src/services/hermes/personal-twin')
    const result = recordHealthOutcome({ feedbackId: 'feedback-pain', outcome: 'adverse_feedback', actionId: 'action-1',
      interventionId: 'health.training.reduce_after_low_sleep', workflowId: 'workflow-1', userId: 'user-1',
      occurredAt: '2026-07-14T12:00:00.000Z' })
    expect(result).toMatchObject({ reviewRequired: true, supersededActionIds: ['action-normal'] })
    const events = listTwinEvents({ eventTypePrefixes: ['health.outcome.', 'health.review.'] })
    expect(events.map(event => event.eventType)).toContain('health.review.requested')
    expect(JSON.stringify(events)).not.toMatch(/diagnos|treatment|emergency.disposition|medication|medical.action/i)
    expect(withPersonalTwinDb(db => db.prepare("SELECT status FROM twin_health_actions WHERE action_id='action-normal'").get()))
      .toEqual({ status: 'superseded' })
    expect(withPersonalTwinDb(db => db.prepare("SELECT status FROM twin_health_actions WHERE action_id='action-fixed'").get()))
      .toEqual({ status: 'active' })
  })

  it('records correction review without rewriting source observations', async () => {
    const { recordHealthOutcome } = await import('../../packages/server/src/services/hermes/health-loop/outcomes')
    const { withPersonalTwinDb, listTwinEvents } = await import('../../packages/server/src/services/hermes/personal-twin')
    const before = withPersonalTwinDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM twin_observations').get() as { n: number }).n))
    recordHealthOutcome({ feedbackId: 'feedback-wrong-data', outcome: 'data_incorrect', actionId: 'action-1',
      interventionId: 'health.training.reduce_after_low_sleep', workflowId: 'workflow-1', userId: 'user-1',
      occurredAt: '2026-07-14T12:00:00.000Z' })
    expect(withPersonalTwinDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM twin_observations').get() as { n: number }).n))).toBe(before)
    expect(listTwinEvents({ eventType: 'health.correction.requested' })).toHaveLength(1)
  })
})
