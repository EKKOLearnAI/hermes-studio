import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindFabricExecutorCapability,
  createFabricExecutor,
  ensureBuiltInFabricRegistry,
  evaluateFabricPolicy,
  getFabricCapability,
  listFabricCapabilities,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
  LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
  LIFE_CAPABILITY_IDS,
  LIFE_PLAN_VERIFY_CAPABILITY,
  LIFE_SOURCE_SYNC_CAPABILITY,
  LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
  lifeTargetAtoms,
  validateLifeFabricOutput,
  validateLifeFabricSemantics,
} from '../../packages/server/src/services/hermes/life-orchestration'
import {
  ensureBuiltInAssistantRoles,
  updateAssistantRole,
} from '../../packages/server/src/services/hermes/personal-twin'

describe('life orchestration Action Fabric contracts', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-fabric-'))
    process.env.HERMES_HOME = home
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    ensureBuiltInAssistantRoles()
    ensureBuiltInFabricRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('registers only the five closed life capabilities with exact risk and recovery contracts', () => {
    const capabilities = listFabricCapabilities().filter(item => item.id.startsWith('life.'))
    expect(capabilities.map(item => item.id)).toEqual([...LIFE_CAPABILITY_IDS].sort())
    expect(getFabricCapability(LIFE_SOURCE_SYNC_CAPABILITY)).toMatchObject({
      risk: 'low', sideEffect: true, idempotency: 'required', reversible: false,
      verificationStrategy: 'normalized_record_and_twin_fact_replay',
    })
    expect(getFabricCapability(LIFE_CALENDAR_HOLD_CREATE_CAPABILITY)).toMatchObject({
      risk: 'medium', sideEffect: true, reversible: true,
      compensationCapabilityId: LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
    })
    expect(getFabricCapability(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY)).toMatchObject({
      risk: 'high', sideEffect: true, reversible: false,
      authentication: expect.arrayContaining(['life_subscription:fresh_exact_approval']),
    })
  })

  it('accepts exact semantic inputs and rejects provider, browser, Android, payment, and extra primitives', () => {
    expect(validateLifeFabricSemantics(LIFE_SOURCE_SYNC_CAPABILITY, sourceInput())).toBe(true)
    expect(validateLifeFabricSemantics(LIFE_PLAN_VERIFY_CAPABILITY, planInput())).toBe(true)
    expect(validateLifeFabricSemantics(LIFE_CALENDAR_HOLD_CREATE_CAPABILITY, calendarInput())).toBe(true)
    expect(validateLifeFabricSemantics(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY, subscriptionInput())).toBe(true)
    for (const extra of [
      { url: 'https://calendar.invalid' }, { selector: '#confirm' }, { click: { x: 1, y: 2 } },
      { paymentToken: 'forbidden' }, { providerPayload: { raw: true } },
    ]) {
      expect(validateLifeFabricSemantics(LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
        { ...calendarInput(), ...extra })).toBe(false)
    }
    expect(validateLifeFabricSemantics(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
      { ...subscriptionInput(), reasonCode: 'free form' })).toBe(false)
  })

  it('derives exact account/source/plan/calendar/subscription/currency atoms and rejects substitution', () => {
    expect(lifeTargetAtoms(LIFE_SOURCE_SYNC_CAPABILITY, sourceTarget(), sourceInput())).toEqual([
      'life:account:calendar-main', 'life:source:calendar',
    ])
    expect(lifeTargetAtoms(LIFE_PLAN_VERIFY_CAPABILITY, planTarget(), planInput())).toEqual([
      `life:plan:${D1}`, 'life:currency:CNY',
    ])
    expect(lifeTargetAtoms(LIFE_CALENDAR_HOLD_CREATE_CAPABILITY, calendarTarget(), calendarInput())).toEqual([
      'life:account:calendar-main', 'life:calendar:calendar-main', `life:plan:${D1}`, 'life:currency:CNY',
    ])
    expect(lifeTargetAtoms(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY, subscriptionTarget(), subscriptionInput())).toEqual([
      'life:account:subscriptions-main', 'life:subscription:subscription-001', 'life:currency:CNY',
    ])
    expect(lifeTargetAtoms(LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
      { ...calendarTarget(), calendarId: 'other-calendar' }, calendarInput())).toBeNull()
    expect(lifeTargetAtoms(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
      { ...subscriptionTarget(), subscriptionId: 'substituted' }, subscriptionInput())).toBeNull()
  })

  it('rejects plan, hold, provider, and subscription output identity substitution', () => {
    const planOutput = { schemaVersion: 1, operation: 'plan_verify', planRevisionId: 'plan-001', planDigest: D1,
      constraintSnapshotId: 'constraint-001', constraintDigest: D2, currency: 'CNY', valid: true,
      reasonCodes: [], checkedAt: NOW }
    expect(validateLifeFabricOutput(LIFE_PLAN_VERIFY_CAPABILITY, planInput(), planOutput)).toBe(true)
    expect(validateLifeFabricOutput(LIFE_PLAN_VERIFY_CAPABILITY, planInput(),
      { ...planOutput, planDigest: D3 })).toBe(false)
    expect(validateLifeFabricOutput(LIFE_PLAN_VERIFY_CAPABILITY, planInput(),
      { ...planOutput, valid: true, reasonCodes: ['OPTION_EXPIRED'] })).toBe(false)

    const cancelOutput = { schemaVersion: 1, operation: 'calendar_hold_cancel', accountId: 'calendar-main',
      planRevisionId: 'plan-001', planDigest: D1, providerRequestId: 'request-calendar-cancel-001',
      holdId: 'hold-001', optionId: 'option-001', providerHoldId: 'provider-hold-001', receiptDigest: D3,
      currency: 'CNY', state: 'cancelled' }
    expect(validateLifeFabricOutput(LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY, calendarCancelInput(), cancelOutput)).toBe(true)
    expect(validateLifeFabricOutput(LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY, calendarCancelInput(),
      { ...cancelOutput, providerHoldId: 'provider-hold-substituted' })).toBe(false)
  })

  it('routes policy through life atoms and requires per-action approval for both external write families', () => {
    createFabricExecutor({ id: 'life-contract-test', type: 'connector', name: 'Life contract test',
      environment: 'sandbox', configuration: { externalWrite: false, shadow: true, interruptible: true }, enabled: true })
    for (const capabilityId of LIFE_CAPABILITY_IDS) {
      const capability = getFabricCapability(capabilityId)!
      bindFabricExecutorCapability('life-contract-test', capability.id, capability.version, capability.contractDigest)
    }
    updateAssistantRole('entertainment-assistant', {
      capabilityScope: { allow: [...LIFE_CAPABILITY_IDS], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'high', requireApprovalAbove: 'low', allowedTargets: [
        'life:account:calendar-main', 'life:source:calendar', `life:plan:${D1}`, 'life:currency:CNY',
        'life:calendar:calendar-main', 'life:account:subscriptions-main',
        'life:subscription:subscription-001',
      ] },
    })
    expect(evaluateFabricPolicy(intent(LIFE_SOURCE_SYNC_CAPABILITY, sourceInput(), sourceTarget(), 'source')))
      .toMatchObject({ outcome: 'allow', reasonCodes: [] })
    expect(evaluateFabricPolicy(intent(LIFE_PLAN_VERIFY_CAPABILITY, planInput(), planTarget(), 'plan')))
      .toMatchObject({ outcome: 'allow', reasonCodes: [] })
    expect(evaluateFabricPolicy(intent(LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
      calendarInput(), calendarTarget(), 'calendar'))).toMatchObject({
      outcome: 'waiting_user', reasonCodes: expect.arrayContaining(['risk_requires_approval']),
    })
    expect(evaluateFabricPolicy(intent(LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
      subscriptionInput(), subscriptionTarget(), 'subscription'))).toMatchObject({
      outcome: 'waiting_user', reasonCodes: expect.arrayContaining(['risk_requires_approval']),
    })
    expect(evaluateFabricPolicy(intent(LIFE_CALENDAR_HOLD_CREATE_CAPABILITY, calendarInput(),
      { ...calendarTarget(), planDigest: D3 }, 'substitution'))).toMatchObject({
      outcome: 'deny', reasonCodes: ['target_not_allowed'],
    })
  })
})

const NOW = '2026-07-15T10:00:00.000Z'
const D1 = '1'.repeat(64)
const D2 = '2'.repeat(64)
const D3 = '3'.repeat(64)

function sourceInput() {
  return { schemaVersion: 1, accountId: 'calendar-main', sourceKind: 'calendar', cursor: null, limit: 20 }
}
function sourceTarget() { return { kind: 'life_source', accountId: 'calendar-main', sourceKind: 'calendar' } }
function planInput() { return { schemaVersion: 1, planRevisionId: 'plan-001', planDigest: D1,
  constraintSnapshotId: 'constraint-001', constraintDigest: D2, currency: 'CNY', activeAt: NOW } }
function planTarget() { return { kind: 'life_plan', planDigest: D1, currency: 'CNY' } }
function calendarInput() { return { schemaVersion: 1, accountId: 'calendar-main', planRevisionId: 'plan-001',
  planDigest: D1, providerRequestId: 'request-calendar-hold-001', currency: 'CNY', optionId: 'option-001',
  startsAt: '2026-07-15T11:00:00.000Z', endsAt: '2026-07-15T12:00:00.000Z' } }
function calendarCancelInput() { return { schemaVersion: 1, accountId: 'calendar-main',
  planRevisionId: 'plan-001', planDigest: D1, providerRequestId: 'request-calendar-cancel-001', currency: 'CNY',
  holdId: 'hold-001', expectedVersion: 3, providerHoldId: 'provider-hold-001', reasonCode: 'USER_REQUEST' } }
function calendarTarget() { return { kind: 'life_calendar', accountId: 'calendar-main',
  calendarId: 'calendar-main', planDigest: D1, currency: 'CNY' } }
function subscriptionInput() { return { schemaVersion: 1, accountId: 'subscriptions-main',
  subscriptionId: 'subscription-001', subscriptionDigest: D2,
  providerRequestId: 'request-subscription-cancel-001', reasonCode: 'USER_REQUEST', currency: 'CNY' } }
function subscriptionTarget() { return { kind: 'life_subscription', accountId: 'subscriptions-main',
  subscriptionId: 'subscription-001', currency: 'CNY' } }
function intent(capabilityId: string, input: Record<string, unknown>, target: Record<string, unknown>, key: string) {
  return { capabilityId, requestedByRoleId: 'entertainment-assistant', requestedByUserId: 'user-1',
    idempotencyKey: `life-${key}`, goal: 'Execute bounded life orchestration action', target, input,
    constraints: {}, rationale: 'Life contract test' }
}
