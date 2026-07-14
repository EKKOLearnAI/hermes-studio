import { createHash } from 'node:crypto'
import type {
  FabricExecutionContext,
  FabricExecuteResult,
  FabricExecutorAdapter,
  FabricPrepareResult,
  FabricVerifyResult,
} from '../action-fabric/executors'
import type { FabricJsonObject } from '../action-fabric/types'
import { assertHomeCapabilityBindingAllowed, homeTargetAtoms, isHomeCapability } from './fabric-contracts'
import { normalizeHomeAssistantBootstrapState } from './home-assistant-normalizer'
import { HomeTwinStore } from './store'
import type { HomeCommandReceipt, HomeDeviceState } from './types'

export interface HomeAssistantCommandTransport {
  callService(domain: string, service: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown[]>
  fetchState(entityId: string, signal?: AbortSignal): Promise<unknown>
}

export interface HomeAssistantMappedCommand {
  domain: string
  service: string
  data: Record<string, unknown>
  expectedState: { key: string; value: unknown; tolerance?: number; expectedVersion: number }
}

export interface HomeAssistantCommandExecutorOptions {
  store: HomeTwinStore
  transport: HomeAssistantCommandTransport
  now?: () => string
}

export function createHomeAssistantCommandExecutorAdapter(
  options: HomeAssistantCommandExecutorOptions,
): FabricExecutorAdapter {
  const now = options.now ?? (() => new Date().toISOString())
  return {
    id: 'home-assistant',
    type: 'connector',
    async prepare(context): Promise<FabricPrepareResult> {
      try {
        const prepared = prepareMaterial(options.store, context)
        options.store.prepareCommandReceipt({
          executionToken: context.executionToken,
          materialDigest: prepared.materialDigest,
          provider: 'home-assistant',
          externalId: prepared.externalId,
          operation: context.capabilityId,
          request: prepared.request,
          expectedState: prepared.expectedState,
        })
        return success('prepared', context, {
          materialDigest: prepared.materialDigest,
          receiptId: receiptId(context.executionToken),
        })
      } catch (error) {
        return failure('failed', stablePrepareError(error))
      }
    },
    async execute(context): Promise<FabricExecuteResult> {
      const digest = materialDigest(context)
      if (context.preparedOutput?.materialDigest !== digest) {
        return failure('permanent_failure', 'HOME_COMMAND_PREPARATION_INVALID')
      }
      const receipt = options.store.getCommandReceipt(context.executionToken)
      if (!receipt || receipt.materialDigest !== digest) {
        return failure('permanent_failure', 'HOME_COMMAND_RECEIPT_INVALID')
      }
      if (receipt.status === 'verified') return success('succeeded', context, commandOutput(receipt, context))
      if (receipt.status === 'failed') return failure('permanent_failure', 'HOME_COMMAND_PREVIOUSLY_FAILED')
      if (receipt.status === 'unknown') return failure('unknown', 'HOME_COMMAND_OUTCOME_UNCERTAIN')
      if (receipt.status === 'sent') return success('succeeded', context, commandOutput(receipt, context))
      if (context.capabilityId === 'home.device.refresh') {
        return executeRefresh(options, context, receipt, now())
      }
      let mapped: HomeAssistantMappedCommand
      try {
        const binding = requireBinding(options.store, context)
        mapped = mapHomeAssistantCommand(context.capabilityId, context.input, binding.metadata)
      } catch (error) {
        options.store.updateCommandReceipt({
          executionToken: receipt.executionToken, materialDigest: digest, status: 'failed',
          result: { errorCode: stablePrepareError(error) },
        })
        return failure('permanent_failure', stablePrepareError(error))
      }
      try {
        await options.transport.callService(mapped.domain, mapped.service, mapped.data)
        const sent = options.store.updateCommandReceipt({
          executionToken: receipt.executionToken, materialDigest: digest, status: 'sent', providerRequestId: null,
          result: { accepted: true },
        })
        return success('succeeded', context, commandOutput(sent, context))
      } catch {
        options.store.updateCommandReceipt({
          executionToken: receipt.executionToken, materialDigest: digest, status: 'unknown',
          result: { accepted: false, errorCode: 'HOME_COMMAND_TRANSPORT_UNCERTAIN' },
        })
        return failure('unknown', 'HOME_COMMAND_TRANSPORT_UNCERTAIN')
      }
    },
    async verify(context): Promise<FabricVerifyResult> {
      const digest = materialDigest(context)
      let receipt = options.store.getCommandReceipt(context.executionToken)
      if (!receipt || receipt.materialDigest !== digest) return failure('failed', 'HOME_COMMAND_RECEIPT_INVALID')
      if (receipt.status === 'verified') return success('verified', context, commandOutput(receipt, context))
      if (receipt.status === 'failed') return failure('mismatch', 'HOME_COMMAND_STATE_MISMATCH')
      if (context.capabilityId === 'home.scene.activate.safe') {
        return failure('unknown', 'HOME_SCENE_VERIFICATION_UNAVAILABLE')
      }
      let state = matchingState(options.store, context, receipt)
      if (!state) {
        try {
          const raw = await options.transport.fetchState(receipt.externalId)
          ingestReadback(options.store, raw, now(), context)
          state = matchingState(options.store, context, receipt)
        } catch {
          return failure('unknown', 'HOME_COMMAND_VERIFICATION_UNAVAILABLE')
        }
      }
      if (!state) {
        const newest = expectedStateRow(options.store, context, receipt)
        if (newest && newest.version > expectedVersion(receipt)
          && Date.parse(newest.observedAt) >= Date.parse(receipt.createdAt)) {
          options.store.updateCommandReceipt({
            executionToken: receipt.executionToken, materialDigest: digest, status: 'failed',
            result: { errorCode: 'HOME_COMMAND_STATE_MISMATCH', observedAt: newest.observedAt },
          })
          return failure('mismatch', 'HOME_COMMAND_STATE_MISMATCH')
        }
        return failure('unknown', 'HOME_COMMAND_VERIFICATION_UNAVAILABLE')
      }
      const event = options.store.getProviderEventById(state.sourceEventId)
      if (!event || event.provider !== receipt.provider) return failure('unknown', 'HOME_COMMAND_VERIFICATION_UNAVAILABLE')
      receipt = options.store.updateCommandReceipt({
        executionToken: receipt.executionToken, materialDigest: digest, status: 'verified',
        providerRequestId: receipt.providerRequestId, observedEventId: event.id,
        result: { key: state.key, value: state.value, observedAt: state.observedAt, version: state.version },
      })
      return success('verified', context, commandOutput(receipt, context))
    },
    async interrupt() { return failure('unsupported', 'HOME_COMMAND_INTERRUPT_UNSUPPORTED') },
    async compensate() { return failure('unsupported', 'HOME_COMMAND_COMPENSATION_UNSUPPORTED') },
  }
}

export function mapHomeAssistantCommand(
  capabilityId: string,
  input: FabricJsonObject,
  metadata: Record<string, unknown>,
): HomeAssistantMappedCommand {
  const externalId = String(input.externalId ?? '')
  assertHomeCapabilityBindingAllowed(capabilityId, externalId, metadata)
  const domain = externalId.slice(0, externalId.indexOf('.'))
  const expectedVersion = integer(input.expectedStateVersion)
  if (capabilityId === 'home.device.set_power' && typeof input.desiredPower === 'boolean') {
    return {
      domain, service: input.desiredPower ? 'turn_on' : 'turn_off', data: { entity_id: externalId },
      expectedState: { key: 'power', value: input.desiredPower, expectedVersion },
    }
  }
  if (capabilityId === 'home.device.set_level' && finiteRange(input.desiredLevel, 0, 100)) {
    const desiredLevel = Number(input.desiredLevel)
    const mapping = domain === 'light' ? { service: 'turn_on', field: 'brightness_pct' }
      : domain === 'fan' ? { service: 'set_percentage', field: 'percentage' }
        : { service: 'set_humidity', field: 'humidity' }
    return {
      domain, service: mapping.service, data: { entity_id: externalId, [mapping.field]: desiredLevel },
      expectedState: { key: 'level', value: desiredLevel, tolerance: 0.5, expectedVersion },
    }
  }
  if (capabilityId === 'home.device.set_temperature' && finiteRange(input.desiredTemperatureC, 5, 35)) {
    const desiredTemperatureC = Number(input.desiredTemperatureC)
    return {
      domain, service: 'set_temperature', data: { entity_id: externalId, temperature: desiredTemperatureC },
      expectedState: { key: 'temperature', value: desiredTemperatureC, tolerance: 0.5, expectedVersion },
    }
  }
  if (capabilityId === 'home.scene.activate.safe' && input.safeScene === true) {
    return {
      domain, service: 'turn_on', data: { entity_id: externalId },
      expectedState: { key: 'state', value: 'activated', expectedVersion: 0 },
    }
  }
  throw new Error('HOME_COMMAND_INPUT_INVALID')
}

async function executeRefresh(
  options: HomeAssistantCommandExecutorOptions,
  context: FabricExecutionContext,
  receipt: HomeCommandReceipt,
  receivedAt: string,
): Promise<FabricExecuteResult> {
  try {
    const raw = await options.transport.fetchState(receipt.externalId)
    const event = ingestReadback(options.store, raw, receivedAt, context)
    options.store.updateCommandReceipt({
      executionToken: receipt.executionToken, materialDigest: receipt.materialDigest, status: 'sent',
      result: { refreshed: true },
    })
    options.store.updateCommandReceipt({
      executionToken: receipt.executionToken, materialDigest: receipt.materialDigest, status: 'verified',
      observedEventId: event.id, result: { refreshed: true, observedEventId: event.id },
    })
    return success('succeeded', context, {
      schemaVersion: 1, deviceId: context.input.deviceId, bindingId: context.input.bindingId,
      status: 'succeeded', observedEventIds: [event.id],
    })
  } catch {
    options.store.updateCommandReceipt({
      executionToken: receipt.executionToken, materialDigest: receipt.materialDigest, status: 'unknown',
      result: { refreshed: false, errorCode: 'HOME_REFRESH_UNCERTAIN' },
    })
    return failure('unknown', 'HOME_REFRESH_UNCERTAIN')
  }
}

function prepareMaterial(store: HomeTwinStore, context: FabricExecutionContext): {
  materialDigest: string
  externalId: string
  request: Record<string, unknown>
  expectedState: Record<string, unknown>
} {
  if (!isHomeCapability(context.capabilityId) || homeTargetAtoms(context.capabilityId, context.target, context.input) === null) {
    throw new Error('HOME_COMMAND_TARGET_DENIED')
  }
  const binding = requireBinding(store, context)
  const device = store.getDevice(String(context.input.deviceId ?? context.input.sceneId ?? ''))
  if (!device && context.capabilityId !== 'home.scene.activate.safe') throw new Error('HOME_COMMAND_DEVICE_NOT_FOUND')
  const mapped = context.capabilityId === 'home.device.refresh' ? null
    : mapHomeAssistantCommand(context.capabilityId, context.input, binding.metadata)
  if (mapped && context.capabilityId !== 'home.scene.activate.safe') {
    const current = store.listDeviceStates({ deviceId: String(context.input.deviceId), key: mapped.expectedState.key })[0]
    if ((current?.version ?? 0) !== mapped.expectedState.expectedVersion) throw new Error('HOME_COMMAND_STATE_VERSION_CONFLICT')
    const requiredCapability = mapped.expectedState.key === 'temperature' ? 'temperature'
      : mapped.expectedState.key === 'level' ? 'level' : mapped.expectedState.key === 'power' ? 'power' : null
    if (requiredCapability && !binding.capabilities.includes(requiredCapability)) throw new Error('HOME_COMMAND_CAPABILITY_DENIED')
  }
  return {
    materialDigest: materialDigest(context),
    externalId: binding.externalId,
    request: {
      capabilityId: context.capabilityId,
      deviceId: context.input.deviceId ?? null,
      sceneId: context.input.sceneId ?? null,
      bindingId: binding.id,
      externalId: binding.externalId,
    },
    expectedState: mapped?.expectedState ?? {},
  }
}

function requireBinding(store: HomeTwinStore, context: FabricExecutionContext) {
  const binding = store.getBinding(String(context.input.bindingId ?? ''))
  if (!binding || binding.provider !== 'home-assistant' || binding.externalId !== context.input.externalId
    || (context.input.deviceId !== undefined && binding.deviceId !== context.input.deviceId)) {
    throw new Error('HOME_COMMAND_BINDING_MISMATCH')
  }
  assertHomeCapabilityBindingAllowed(context.capabilityId, binding.externalId, binding.metadata)
  return binding
}

function ingestReadback(
  store: HomeTwinStore,
  raw: unknown,
  receivedAt: string,
  context: FabricExecutionContext,
) {
  const normalized = normalizeHomeAssistantBootstrapState(raw, receivedAt)
  if (normalized.entity.externalId !== context.input.externalId || normalized.entity.deviceId !== context.input.deviceId) {
    throw new Error('HOME_COMMAND_READBACK_IDENTITY_MISMATCH')
  }
  const result = store.applyDeviceStateEvent({
    event: normalized.event,
    states: normalized.entity.states.map(state => ({ deviceId: normalized.entity.deviceId, ...state })),
  })
  return result.event
}

function matchingState(store: HomeTwinStore, context: FabricExecutionContext, receipt: HomeCommandReceipt): HomeDeviceState | null {
  const row = expectedStateRow(store, context, receipt)
  if (!row || row.version <= expectedVersion(receipt) || Date.parse(row.observedAt) < Date.parse(receipt.createdAt)) return null
  const expected = receipt.expectedState.value
  const tolerance = typeof receipt.expectedState.tolerance === 'number' ? receipt.expectedState.tolerance : 0
  if (typeof expected === 'number' && typeof row.value === 'number') {
    return Math.abs(expected - row.value) <= tolerance ? row : null
  }
  return row.value === expected ? row : null
}

function expectedStateRow(store: HomeTwinStore, context: FabricExecutionContext, receipt: HomeCommandReceipt): HomeDeviceState | null {
  const key = typeof receipt.expectedState.key === 'string' ? receipt.expectedState.key : ''
  if (!key || typeof context.input.deviceId !== 'string') return null
  return store.listDeviceStates({ deviceId: context.input.deviceId, key })[0] ?? null
}

function expectedVersion(receipt: HomeCommandReceipt): number {
  return integer(receipt.expectedState.expectedVersion)
}

function commandOutput(receipt: HomeCommandReceipt, context: FabricExecutionContext): FabricJsonObject {
  const common = {
    schemaVersion: 1,
    receiptId: receiptId(receipt.executionToken),
    bindingId: context.input.bindingId,
    status: receipt.status === 'verified' ? 'verified' : receipt.status === 'failed' ? 'failed' : 'unknown',
    providerRequestId: receipt.providerRequestId,
    observedEventId: receipt.observedEventId,
    finalState: receipt.result ?? {},
  }
  return context.capabilityId === 'home.scene.activate.safe'
    ? { ...common, sceneId: context.input.sceneId }
    : { ...common, deviceId: context.input.deviceId }
}

function materialDigest(context: FabricExecutionContext): string {
  return createHash('sha256').update(stableJson({
    capabilityId: context.capabilityId,
    capabilityVersion: context.capabilityVersion,
    contractDigest: context.contractDigest,
    input: context.input,
    target: context.target,
  })).digest('hex')
}

function receiptId(executionToken: string): string {
  return `receipt:home:${createHash('sha256').update(executionToken).digest('hex').slice(0, 24)}`
}

function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return {
    outcome, output,
    evidence: [{ kind: 'home_command', summary: outcome, data: {
      capabilityId: context.capabilityId,
      deviceId: context.input.deviceId ?? null,
      bindingId: context.input.bindingId,
    }, capturedAt: context.now ?? new Date().toISOString() }],
    errorCode: null, safeToRetry: false,
  }
}

function failure<T extends string>(outcome: T, errorCode: string) {
  return { outcome, output: {}, evidence: [], errorCode, safeToRetry: false }
}

function stablePrepareError(error: unknown): string {
  if (!(error instanceof Error) || !/^HOME_[A-Z0-9_]+$/.test(error.message)) return 'HOME_COMMAND_PREPARATION_INVALID'
  return error.message
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('HOME_COMMAND_INPUT_INVALID')
  return Number(value)
}

function finiteRange(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('HOME_COMMAND_INPUT_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') throw new Error('HOME_COMMAND_INPUT_INVALID')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}
