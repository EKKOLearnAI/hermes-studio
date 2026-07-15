import { isProxy } from 'node:util/types'
import {
  bindFabricExecutorCapability,
  createFabricExecutor,
  ensureBuiltInFabricRegistry,
  getFabricCapability,
  listFabricExecutors,
  updateFabricExecutor,
  updateFabricExecutorHealth,
  type FabricExecutorInput,
} from '../action-fabric/registry'
import { getFabricControlState } from '../action-fabric/control'
import { withActionFabricDb } from '../action-fabric/database'
import type { FabricCapability, FabricExecutor, FabricExecutorHealth, FabricJsonObject } from '../action-fabric/types'
import {
  ANDROID_APP_LAUNCH_CAPABILITY,
  ANDROID_APP_LAUNCH_PERMISSIONS,
  ANDROID_APP_LAUNCH_VERIFICATION,
  ANDROID_COMPANION_PACKAGE,
  ANDROID_SCREEN_CAPTURE_CAPABILITY,
  ANDROID_SCREEN_CAPTURE_PERMISSIONS,
  ANDROID_SCREEN_CAPTURE_VERIFICATION,
} from './fabric-contracts'
import type { AndroidCompanionStore } from './store'
import {
  AndroidCompanionValidationError,
  type AndroidCapabilityReportItem,
  type AndroidCompanionCapability,
  type AndroidCompanionDevice,
  type AndroidCompanionMessageType,
} from './types'

const REPORT_FRESHNESS_MS = 5 * 60_000
const DRIVER_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]{1,40})?$/

type CapabilityPolicy = {
  capabilityId: string
  capabilityVersion: number
  packageBinding: string
  permissions: readonly string[]
  verificationStrategy: string
  executorSuffix: string
}

const POLICIES: readonly CapabilityPolicy[] = [
  {
    capabilityId: ANDROID_APP_LAUNCH_CAPABILITY,
    capabilityVersion: 1,
    packageBinding: ANDROID_COMPANION_PACKAGE,
    permissions: ANDROID_APP_LAUNCH_PERMISSIONS,
    verificationStrategy: ANDROID_APP_LAUNCH_VERIFICATION,
    executorSuffix: 'app-launch',
  },
  {
    capabilityId: ANDROID_SCREEN_CAPTURE_CAPABILITY,
    capabilityVersion: 1,
    packageBinding: ANDROID_COMPANION_PACKAGE,
    permissions: ANDROID_SCREEN_CAPTURE_PERMISSIONS,
    verificationStrategy: ANDROID_SCREEN_CAPTURE_VERIFICATION,
    executorSuffix: 'screen-capture',
  },
]

export interface AndroidCapabilityReportPayload {
  revision: number
  reportedAt: string
  capabilities: AndroidCapabilityReportItem[]
}

export interface AndroidCapabilityReconciliation {
  disposition: 'updated' | 'replayed'
  device: AndroidCompanionDevice
  capabilities: AndroidCompanionCapability[]
  executors: Array<{
    executorId: string
    capabilityId: string
    enabled: boolean
    health: FabricExecutorHealth
  }>
}

interface FabricRegistryFacade {
  ensure(): void
  listExecutors(): FabricExecutor[]
  getCapability(id: string): FabricCapability | null
  createExecutor(input: FabricExecutorInput): FabricExecutor
  updateExecutor(id: string, updates: Partial<Omit<FabricExecutorInput, 'id'>>): FabricExecutor
  updateHealth(id: string, health: FabricExecutorHealth, details: FabricJsonObject): FabricExecutor
  bind(executorId: string, capabilityId: string, version: number, digest: string): void
  hasBinding(executorId: string, capabilityId: string, version: number, digest: string): boolean
  emergencyLevel(): number
}

export class AndroidCompanionCapabilityService {
  readonly #store: AndroidCompanionStore
  readonly #registry: FabricRegistryFacade
  readonly #now: () => Date

  constructor(input: {
    store: AndroidCompanionStore
    registry?: FabricRegistryFacade
    now?: () => Date
  }) {
    this.#store = input.store
    this.#registry = input.registry ?? defaultRegistry()
    this.#now = input.now ?? (() => new Date())
  }

  applyReport(
    deviceId: string,
    messageType: Extract<AndroidCompanionMessageType, 'capabilities.report' | 'permissions.report'>,
    payload: AndroidCapabilityReportPayload,
  ): AndroidCapabilityReconciliation {
    const report = validateReport(payload, this.#now())
    const device = this.#store.getDevice(deviceId)
    if (!device || device.state !== 'paired') throw invalid('Android companion is unavailable')
    const stored = this.#store.replaceCapabilityReport({
      deviceId,
      expectedDeviceVersion: device.version,
      revision: report.revision,
      capabilities: report.capabilities,
      reportedAt: report.reportedAt,
    })
    const executors = this.reconcile(stored.device, stored.capabilities, messageType)
    return { ...stored, executors }
  }

  disableDevice(deviceId: string, source = 'device_revoked'): string[] {
    this.#registry.ensure()
    const disabled: string[] = []
    for (let executor of this.#registry.listExecutors()) {
      if (executor.type !== 'android' || executor.configuration.deviceId !== deviceId) continue
      if (executor.enabled) executor = this.#registry.updateExecutor(executor.id, { enabled: false })
      executor = this.#registry.updateHealth(executor.id, 'unhealthy', {
        lifecycle: source,
        deviceId,
      })
      disabled.push(executor.id)
    }
    return disabled.sort()
  }

  private reconcile(
    device: AndroidCompanionDevice,
    capabilities: AndroidCompanionCapability[],
    source: 'capabilities.report' | 'permissions.report',
  ): AndroidCapabilityReconciliation['executors'] {
    this.#registry.ensure()
    const existing = new Map(this.#registry.listExecutors().map(executor => [executor.id, executor]))
    const emergencyStopped = this.#registry.emergencyLevel() >= 3
    const byId = new Map(capabilities.map(capability => [capability.capabilityId, capability]))
    return POLICIES.map(policy => {
      const report = byId.get(policy.capabilityId) ?? null
      const executorId = androidExecutorId(device.signingFingerprint, policy)
      const capability = this.#registry.getCapability(policy.capabilityId)
      if (!capability || capability.version !== policy.capabilityVersion) {
        throw invalid(`Android Fabric contract is unavailable: ${policy.capabilityId}`)
      }
      const usable = !!report && report.enabled && report.health !== 'unavailable' && !emergencyStopped
      const health: FabricExecutorHealth = emergencyStopped ? 'degraded'
        : !report || report.health === 'unavailable' ? 'unhealthy'
          : report.health === 'healthy' ? 'healthy' : 'degraded'
      const configuration: FabricJsonObject = {
        externalWrite: true,
        interruptible: true,
        managedAvailability: true,
        deviceId: device.id,
        capabilityId: policy.capabilityId,
        packageBinding: report?.packageBinding ?? policy.packageBinding,
        packageFingerprint: report?.packageFingerprint ?? null,
        driverVersion: report?.driverVersion ?? null,
        permissions: report?.permissions ?? [],
        verificationStrategy: policy.verificationStrategy,
        reportRevision: device.capabilitiesRevision,
      }
      const input: FabricExecutorInput = {
        id: executorId,
        type: 'android',
        name: `Android · ${device.label} · ${policy.capabilityId}`,
        environment: 'production',
        configuration,
        enabled: usable && health === 'healthy',
      }
      let executor = existing.get(executorId)
      if (!executor) executor = this.#registry.createExecutor(input)
      else if (!sameExecutorInput(executor, input)) executor = this.#registry.updateExecutor(executorId, input)
      const details: FabricJsonObject = {
        lifecycle: emergencyStopped ? 'emergency_stopped'
          : !report ? 'capability_missing'
            : report.enabled ? report.health : 'capability_disabled',
        deviceId: device.id,
        capabilityId: policy.capabilityId,
        reportRevision: device.capabilitiesRevision,
        source,
      }
      if (executor.health !== health || JSON.stringify(executor.healthDetails) !== JSON.stringify(details)) {
        executor = this.#registry.updateHealth(executorId, health, details)
      }
      if (!this.#registry.hasBinding(executorId, capability.id, capability.version, capability.contractDigest)) {
        this.#registry.bind(executorId, capability.id, capability.version, capability.contractDigest)
      }
      return { executorId, capabilityId: policy.capabilityId, enabled: executor.enabled, health: executor.health }
    })
  }
}

export function androidExecutorId(signingFingerprint: string, policy: Pick<CapabilityPolicy, 'executorSuffix'>): string {
  if (!/^[a-f0-9]{64}$/.test(signingFingerprint)) throw invalid('Android signing fingerprint is invalid')
  return `android-${signingFingerprint.slice(0, 24)}-${policy.executorSuffix}`
}

function validateReport(payload: AndroidCapabilityReportPayload, now: Date): AndroidCapabilityReportPayload {
  if (!plainRecord(payload) || !exactKeys(payload, ['capabilities', 'reportedAt', 'revision'])) {
    throw invalid('Android capability report envelope is invalid')
  }
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 1) {
    throw invalid('Android capability report revision is invalid')
  }
  const reportedAt = canonicalTimestamp(payload.reportedAt)
  if (Math.abs(Date.parse(reportedAt) - now.getTime()) > REPORT_FRESHNESS_MS) {
    throw invalid('Android capability report is stale')
  }
  if (!Array.isArray(payload.capabilities) || payload.capabilities.length !== POLICIES.length) {
    throw invalid('Android capability report must contain the complete semantic allowlist')
  }
  const policies = new Map(POLICIES.map(policy => [policy.capabilityId, policy]))
  const capabilities = payload.capabilities.map(item => {
    if (!plainRecord(item) || !exactKeys(item, [
      'capabilityId', 'capabilityVersion', 'driverVersion', 'enabled', 'health', 'packageBinding',
      'packageFingerprint', 'permissions', 'verificationStrategy',
    ])) throw invalid('Android capability report item is invalid')
    const policy = policies.get(String(item.capabilityId))
    if (!policy) throw invalid('Unknown Android semantic capability is forbidden')
    if (item.capabilityVersion !== policy.capabilityVersion || item.packageBinding !== policy.packageBinding
      || item.verificationStrategy !== policy.verificationStrategy || !DRIVER_VERSION.test(String(item.driverVersion))) {
      throw invalid(`Android capability contract mismatch: ${policy.capabilityId}`)
    }
    if (JSON.stringify(safeStringArray(item.permissions)) !== JSON.stringify([...policy.permissions].sort())) {
      throw invalid(`Android capability permission set mismatch: ${policy.capabilityId}`)
    }
    return item as AndroidCapabilityReportItem
  })
  if (new Set(capabilities.map(item => item.capabilityId)).size !== POLICIES.length) {
    throw invalid('Android capability report contains duplicates')
  }
  return { revision: payload.revision, reportedAt, capabilities }
}

function defaultRegistry(): FabricRegistryFacade {
  return {
    ensure: ensureBuiltInFabricRegistry,
    listExecutors: listFabricExecutors,
    getCapability: getFabricCapability,
    createExecutor: createFabricExecutor,
    updateExecutor: updateFabricExecutor,
    updateHealth: updateFabricExecutorHealth,
    bind(executorId, capabilityId, version, digest) {
      bindFabricExecutorCapability(executorId, capabilityId, version, digest)
    },
    hasBinding(executorId, capabilityId, version, digest) {
      return withActionFabricDb(db => {
        const row = db.prepare(`SELECT capability_version,contract_digest FROM fabric_executor_capabilities
          WHERE executor_id=? AND capability_id=?`).get(executorId, capabilityId) as
          { capability_version: number; contract_digest: string } | undefined
        return row?.capability_version === version && row.contract_digest === digest
      })
    },
    emergencyLevel: () => getFabricControlState().level,
  }
}

function sameExecutorInput(executor: FabricExecutor, input: FabricExecutorInput): boolean {
  return executor.type === input.type && executor.name === input.name && executor.environment === input.environment
    && executor.enabled === input.enabled && JSON.stringify(executor.configuration) === JSON.stringify(input.configuration)
}

function plainRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    descriptor => descriptor.enumerable && !descriptor.get && !descriptor.set && 'value' in descriptor,
  )
}

function exactKeys(value: object, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || isProxy(value) || value.length > 32
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw invalid('Android capability permission set is invalid')
  }
  const output: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      throw invalid('Android capability permission set is invalid')
    }
    output.push(descriptor.value)
  }
  if (Object.keys(value).length !== value.length) throw invalid('Android capability permission set is invalid')
  return output.sort()
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24 || new Date(value).toISOString() !== value) {
    throw invalid('Android capability report time is invalid')
  }
  return value
}

function invalid(message: string): AndroidCompanionValidationError {
  return new AndroidCompanionValidationError(message)
}
