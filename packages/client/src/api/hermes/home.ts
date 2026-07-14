import { request } from '@/api/client'

export type HomeSpaceKind = 'home' | 'floor' | 'room' | 'zone' | 'furniture' | 'compartment' | 'surface'
export type HomeDeviceAvailability = 'available' | 'unavailable' | 'unknown'
export type HomeProviderConnectionStatus = 'stopped' | 'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'degraded'
export type HomeWorkflowState = 'draft' | 'policy_check' | 'preparing' | 'executing' | 'verifying'
  | 'waiting_user' | 'retrying' | 'compensating' | 'succeeded' | 'denied' | 'cancelled'
  | 'failed' | 'dead_letter' | 'compensated'

export interface HomeProviderDto {
  provider: 'home-assistant'; profile: string; active: boolean; configured: boolean
  connectionStatus: HomeProviderConnectionStatus; executorEnabled: boolean
  authorizedTargetCount: number; lastErrorCode: string | null
}
export interface HomeOverviewSummaryDto {
  spaceCount: number; deviceCount: number; unavailableDeviceCount: number
  inventoryItemCount: number; lowStockItemCount: number; activeWorkflowCount: number
}
export interface HomeOverviewDto { provider: HomeProviderDto; summary: HomeOverviewSummaryDto }
export interface HomeSpaceDto {
  id: string; kind: HomeSpaceKind; name: string; parentSpaceId: string | null
  attributes: Record<string, unknown>; version: number; createdAt: string; updatedAt: string
}
export interface HomeInventoryItemDto {
  id: string; name: string; unit: string; quantity: number; lowStockThreshold: number | null
  attributes: Record<string, unknown>; version: number; createdAt: string; updatedAt: string
}
export interface HomeInventoryLedgerDto {
  id: string; itemId: string; delta: number; resultingQuantity: number; reason: string
  source: 'home-api'; sourceId: string; createdAt: string
}
export interface HomeBindingDto {
  id: string; deviceId: string; provider: 'home-assistant'; externalId: string
  capabilities: string[]; version: number; createdAt: string; updatedAt: string
}
export interface HomeDeviceStateDto {
  deviceId: string; key: string; value: unknown; sourceEventId: string
  observedAt: string; receivedAt: string; version: number
}
export interface HomeDeviceDto {
  id: string; name: string; deviceClass: string; spaceId: string | null
  availability: HomeDeviceAvailability; attributes: Record<string, unknown>; version: number
  createdAt: string; updatedAt: string; bindings: HomeBindingDto[]; states: HomeDeviceStateDto[]
}
export interface HomeWorkflowAvailableActionsDto {
  approve: boolean; reject: boolean; cancel: boolean; retry: boolean; compensate: boolean
}
export interface HomeWorkflowSummaryDto {
  id: string; state: HomeWorkflowState; version: number; attempt: number; lastErrorCode: string | null
  availableActions: HomeWorkflowAvailableActionsDto; createdAt: string; updatedAt: string; completedAt: string | null
}
export interface HomePolicyDecisionDto { id: string; outcome: 'allow' | 'deny' | 'waiting_user'; reasonCodes: string[] }
export interface HomeWorkflowStepDto {
  kind: string; state: string; attempt: number; lastErrorCode: string | null
  output: Record<string, unknown> | null; updatedAt: string
}
export interface HomeWorkflowDetailDto extends HomeWorkflowSummaryDto {
  capabilityId: string; policyDecision: HomePolicyDecisionDto | null; steps: HomeWorkflowStepDto[]
}
export interface HomeActionResponseDto {
  intent: { id: string; capabilityId: string }; policyDecision: HomePolicyDecisionDto
  workflow: HomeWorkflowSummaryDto
}

export interface HomeSpaceQuery { parentSpaceId?: string; kind?: HomeSpaceKind; limit?: number }
export interface HomeDeviceQuery { spaceId?: string; deviceClass?: string; limit?: number }
export interface HomeBindingQuery { deviceId?: string; provider?: 'home-assistant'; limit?: number }
export interface HomeInventoryQuery { lowStockOnly?: boolean; limit?: number }
export interface UpsertHomeSpaceInput {
  id: string; kind: HomeSpaceKind; name: string; parentSpaceId?: string | null
  attributes?: Record<string, unknown>; expectedVersion: number
}
export interface UpsertHomeInventoryInput {
  name: string; unit: string; initialQuantity?: number; lowStockThreshold?: number | null
  attributes?: Record<string, unknown>; expectedVersion: number
}
export interface AdjustHomeInventoryInput { delta: number; reason: string; occurredAt: string; idempotencyKey: string }
export interface RefreshHomeDeviceInput { bindingId: string; externalId: string; requestedAt: string; idempotencyKey: string }
interface HomeCommandBaseInput {
  bindingId: string; externalId: string; expectedStateVersion: number
  verificationTimeoutMs: number; idempotencyKey: string
}
export type CommandHomeDeviceInput =
  | (HomeCommandBaseInput & { command: 'set_power'; desiredPower: boolean })
  | (HomeCommandBaseInput & { command: 'set_level'; desiredLevel: number })
  | (HomeCommandBaseInput & { command: 'set_temperature'; desiredTemperatureC: number })
export interface ActivateHomeSceneInput {
  bindingId: string; externalId: string; verificationTimeoutMs: number; idempotencyKey: string
}
export type ReviewHomeWorkflowInput = { action: 'approve' } | { action: 'reject'; reason: string }

const BASE = '/api/hermes/home'
const id = (value: string) => encodeURIComponent(value)
const json = (method: 'POST' | 'PUT', body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })
function withQuery(path: string, entries: Array<[string, unknown]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined) params.set(key, String(value))
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

export function fetchHomeOverview(): Promise<HomeOverviewDto> { return request(`${BASE}/overview`) }
export async function fetchHomeSpaces(query: HomeSpaceQuery = {}): Promise<HomeSpaceDto[]> {
  const response = await request<{ spaces: HomeSpaceDto[] }>(withQuery(`${BASE}/spaces`, [
    ['parentSpaceId', query.parentSpaceId], ['kind', query.kind], ['limit', query.limit],
  ]))
  return response.spaces
}
export async function upsertHomeSpace(input: UpsertHomeSpaceInput): Promise<HomeSpaceDto> {
  return (await request<{ space: HomeSpaceDto }>(`${BASE}/spaces`, json('POST', input))).space
}
export async function fetchHomeInventory(query: HomeInventoryQuery = {}): Promise<HomeInventoryItemDto[]> {
  return (await request<{ items: HomeInventoryItemDto[] }>(withQuery(`${BASE}/inventory`, [
    ['lowStockOnly', query.lowStockOnly], ['limit', query.limit],
  ]))).items
}
export async function upsertHomeInventoryItem(idValue: string, input: UpsertHomeInventoryInput): Promise<HomeInventoryItemDto> {
  return (await request<{ item: HomeInventoryItemDto }>(`${BASE}/inventory/${id(idValue)}`, json('PUT', input))).item
}
export async function adjustHomeInventory(idValue: string, input: AdjustHomeInventoryInput): Promise<{
  disposition: 'applied' | 'duplicate'; item: HomeInventoryItemDto; entry: HomeInventoryLedgerDto
}> {
  return request(`${BASE}/inventory/${id(idValue)}/adjust`, json('POST', input))
}
export async function fetchHomeDevices(query: HomeDeviceQuery = {}): Promise<HomeDeviceDto[]> {
  return (await request<{ devices: HomeDeviceDto[] }>(withQuery(`${BASE}/devices`, [
    ['spaceId', query.spaceId], ['deviceClass', query.deviceClass], ['limit', query.limit],
  ]))).devices
}
export async function fetchHomeBindings(query: HomeBindingQuery = {}): Promise<HomeBindingDto[]> {
  return (await request<{ bindings: HomeBindingDto[] }>(withQuery(`${BASE}/bindings`, [
    ['deviceId', query.deviceId], ['provider', query.provider], ['limit', query.limit],
  ]))).bindings
}
export async function fetchHomeProvider(): Promise<HomeProviderDto> {
  return (await request<{ provider: HomeProviderDto }>(`${BASE}/provider`)).provider
}
export function refreshHomeDevice(deviceId: string, input: RefreshHomeDeviceInput): Promise<HomeActionResponseDto> {
  return request(`${BASE}/devices/${id(deviceId)}/refresh`, json('POST', input))
}
export function commandHomeDevice(deviceId: string, input: CommandHomeDeviceInput): Promise<HomeActionResponseDto> {
  return request(`${BASE}/devices/${id(deviceId)}/commands`, json('POST', input))
}
export function activateHomeScene(sceneId: string, input: ActivateHomeSceneInput): Promise<HomeActionResponseDto> {
  return request(`${BASE}/scenes/${id(sceneId)}/activate`, json('POST', input))
}
export async function fetchHomeWorkflow(workflowId: string): Promise<HomeWorkflowDetailDto> {
  return (await request<{ workflow: HomeWorkflowDetailDto }>(`${BASE}/workflows/${id(workflowId)}`)).workflow
}
export async function reviewHomeWorkflow(workflowId: string, input: ReviewHomeWorkflowInput): Promise<HomeWorkflowDetailDto> {
  return (await request<{ workflow: HomeWorkflowDetailDto }>(
    `${BASE}/workflows/${id(workflowId)}/review`, json('POST', input),
  )).workflow
}
