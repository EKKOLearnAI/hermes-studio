export const HOME_SPACE_KINDS = [
  'home', 'floor', 'room', 'zone', 'furniture', 'compartment', 'surface',
] as const
export type HomeSpaceKind = typeof HOME_SPACE_KINDS[number]

export const HOME_DEVICE_AVAILABILITY = ['available', 'unavailable', 'unknown'] as const
export type HomeDeviceAvailability = typeof HOME_DEVICE_AVAILABILITY[number]

export const HOME_PROVIDER_EVENT_STATUSES = ['received', 'applied', 'ignored', 'rejected'] as const
export type HomeProviderEventStatus = typeof HOME_PROVIDER_EVENT_STATUSES[number]

export const HOME_PROVIDER_CONNECTION_STATUSES = ['disconnected', 'connecting', 'connected', 'degraded'] as const
export type HomeProviderConnectionStatus = typeof HOME_PROVIDER_CONNECTION_STATUSES[number]

export const HOME_COMMAND_RECEIPT_STATUSES = ['prepared', 'sent', 'verified', 'unknown', 'failed'] as const
export type HomeCommandReceiptStatus = typeof HOME_COMMAND_RECEIPT_STATUSES[number]

export interface HomeVersionedRecord {
  version: number
  createdAt: string
  updatedAt: string
}

export interface HomeSpace extends HomeVersionedRecord {
  id: string
  kind: HomeSpaceKind
  name: string
  parentSpaceId: string | null
  attributes: Record<string, unknown>
}

export interface HomeObject extends HomeVersionedRecord {
  id: string
  kind: string
  name: string
  spaceId: string | null
  attributes: Record<string, unknown>
}

export interface HomeInventoryItem extends HomeVersionedRecord {
  id: string
  name: string
  unit: string
  quantity: number
  lowStockThreshold: number | null
  attributes: Record<string, unknown>
}

export interface HomeInventoryLedgerEntry {
  id: string
  itemId: string
  delta: number
  resultingQuantity: number
  reason: string
  source: string
  sourceId: string
  createdAt: string
}

export interface HomeDevice extends HomeVersionedRecord {
  id: string
  name: string
  deviceClass: string
  spaceId: string | null
  availability: HomeDeviceAvailability
  attributes: Record<string, unknown>
}

export interface HomeDeviceBinding extends HomeVersionedRecord {
  id: string
  deviceId: string
  provider: string
  externalId: string
  capabilities: string[]
  metadata: Record<string, unknown>
}

export interface HomeDeviceState {
  deviceId: string
  key: string
  value: unknown
  sourceEventId: string
  observedAt: string
  receivedAt: string
  version: number
}

export interface HomeProviderEvent {
  id: string
  provider: string
  eventId: string
  eventType: string
  occurredAt: string
  receivedAt: string
  payload: Record<string, unknown>
  status: HomeProviderEventStatus
  errorCode: string | null
}

export interface HomeProviderCursor {
  provider: string
  cursor: Record<string, unknown>
  connectionStatus: HomeProviderConnectionStatus
  lastEventAt: string | null
  version: number
  updatedAt: string
}

export interface HomeCommandReceipt {
  executionToken: string
  materialDigest: string
  provider: string
  externalId: string
  operation: string
  request: Record<string, unknown>
  expectedState: Record<string, unknown>
  providerRequestId: string | null
  status: HomeCommandReceiptStatus
  observedEventId: string | null
  result: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  verifiedAt: string | null
}

export interface HomeSpaceInput {
  id: string
  kind: HomeSpaceKind
  name: string
  parentSpaceId?: string | null
  attributes?: Record<string, unknown>
  expectedVersion: number
}

export interface HomeObjectInput {
  id: string
  kind: string
  name: string
  spaceId?: string | null
  attributes?: Record<string, unknown>
  expectedVersion: number
}

export interface HomeDeviceInput {
  id: string
  name: string
  deviceClass: string
  spaceId?: string | null
  availability: HomeDeviceAvailability
  attributes?: Record<string, unknown>
  expectedVersion: number
}

export interface HomeDeviceBindingInput {
  id: string
  deviceId: string
  provider: string
  externalId: string
  capabilities?: string[]
  metadata?: Record<string, unknown>
  expectedVersion: number
}

export interface HomeInventoryItemInput {
  id: string
  name: string
  unit: string
  initialQuantity?: number
  lowStockThreshold?: number | null
  attributes?: Record<string, unknown>
  expectedVersion: number
}

export interface HomeInventoryAdjustmentInput {
  id: string
  itemId: string
  delta: number
  reason: string
  source: string
  sourceId: string
  occurredAt: string
}

export interface HomeInventoryAdjustmentResult {
  disposition: 'applied' | 'duplicate'
  item: HomeInventoryItem
  entry: HomeInventoryLedgerEntry
}

export interface HomeSpaceListOptions { parentSpaceId?: string | null; kind?: HomeSpaceKind; limit?: number }
export interface HomeObjectListOptions { spaceId?: string | null; kind?: string; limit?: number }
export interface HomeDeviceListOptions { spaceId?: string | null; deviceClass?: string; limit?: number }
export interface HomeDeviceBindingListOptions { deviceId?: string; provider?: string; limit?: number }
export interface HomeDeviceStateListOptions { deviceId?: string; key?: string; limit?: number }
export interface HomeInventoryItemListOptions { lowStockOnly?: boolean; limit?: number }

export interface HomeDeviceStateEventInput {
  event: {
    id: string
    provider: string
    eventId: string
    eventType: string
    occurredAt: string
    receivedAt: string
    payload: Record<string, unknown>
  }
  states: Array<{
    deviceId: string
    key: string
    value: unknown
    observedAt: string
  }>
}

export interface HomeDeviceStateEventResult {
  disposition: 'applied' | 'duplicate' | 'ignored'
  event: HomeProviderEvent
  states: HomeDeviceState[]
}

export interface HomeProviderCursorInput {
  provider: string
  cursor?: Record<string, unknown>
  connectionStatus: HomeProviderConnectionStatus
  lastEventAt?: string | null
  expectedVersion: number
}

export interface HomeCommandReceiptPrepareInput {
  executionToken: string
  materialDigest: string
  provider: string
  externalId: string
  operation: string
  request: Record<string, unknown>
  expectedState: Record<string, unknown>
}

export interface HomeCommandReceiptUpdateInput {
  executionToken: string
  materialDigest: string
  status: Exclude<HomeCommandReceiptStatus, 'prepared'>
  providerRequestId?: string | null
  observedEventId?: string | null
  result?: Record<string, unknown> | null
}

export class HomeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HomeValidationError'
  }
}

export class HomeRecordNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HomeRecordNotFoundError'
  }
}

export class HomeIdentityConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HomeIdentityConflictError'
  }
}

export class HomeVersionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HomeVersionConflictError'
  }
}
