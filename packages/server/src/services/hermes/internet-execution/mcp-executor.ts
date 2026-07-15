import { createHash } from 'node:crypto'
import type {
  FabricCompensateResult,
  FabricExecutionContext,
  FabricExecuteResult,
  FabricExecutorAdapter,
  FabricInterruptResult,
  FabricPrepareResult,
  FabricVerifyResult,
} from '../action-fabric/executors'
import type { FabricJsonObject } from '../action-fabric/types'
import { callProfileMcpTool } from '../mcp'
import type { McpToolCallResponse } from '../mcp-types'
import {
  BILIBILI_INSPECT_CAPABILITY,
  BILIBILI_PROVIDER,
  BILIBILI_SEARCH_CAPABILITY,
  internetTargetAtoms,
  normalizeBilibiliInspectPayload,
  normalizeBilibiliSearchPayload,
  validateInternetOutputSemantics,
  validateInternetSemantics,
} from './fabric-contracts'
import {
  discoverBilibiliMcpBinding,
  resolveBilibiliMcpBinding,
  type BilibiliMcpBinding,
  type BilibiliMcpDiscovery,
} from './mcp-discovery'
import { withInternetExecutionDb } from './database'
import { InternetExecutionStore } from './store'
import type { InternetExecutionEnvironment, InternetExecutionReceipt } from './types'

const EXECUTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/

type StoreAccess = <T>(operation: (store: InternetExecutionStore) => T) => T
type BindingResolver = (profile: string) => BilibiliMcpBinding
type BindingDiscovery = (profile: string) => Promise<BilibiliMcpDiscovery>
type McpCaller = (input: {
  profile: string
  server: string
  tool: string
  arguments: Record<string, unknown>
  timeoutMs?: number
}) => Promise<McpToolCallResponse>

export interface InternetMcpExecutorOptions {
  id: string
  environment: InternetExecutionEnvironment
  timeoutMs?: number
  now?: () => string
  accessStore?: StoreAccess
  resolveBinding?: BindingResolver
  discoverBinding?: BindingDiscovery
  callTool?: McpCaller
}

export function createInternetMcpExecutorAdapter(options: InternetMcpExecutorOptions): FabricExecutorAdapter {
  if (!EXECUTOR_ID.test(options.id) || !['sandbox', 'production'].includes(options.environment)) {
    throw new Error('INTERNET_MCP_EXECUTOR_CONFIGURATION_INVALID')
  }
  const timeoutMs = boundedTimeout(options.timeoutMs)
  const now = options.now ?? (() => new Date().toISOString())
  const accessStore = options.accessStore ?? defaultStoreAccess
  const resolveBinding = options.resolveBinding ?? resolveBilibiliMcpBinding
  const discoverBinding = options.discoverBinding ?? (profile => discoverBilibiliMcpBinding(profile))
  const callTool = options.callTool ?? callProfileMcpTool

  return {
    id: options.id,
    type: 'mcp',
    async prepare(context): Promise<FabricPrepareResult> {
      try {
        const prepared = await prepareMaterial(context, options, resolveBinding, discoverBinding)
        accessStore(store => store.prepareReceipt({
          workflowId: context.workflowId,
          intentId: context.intentId,
          materialDigest: prepared.materialDigest,
          capabilityId: context.capabilityId,
          provider: BILIBILI_PROVIDER,
          profile: prepared.binding.profile,
          executorId: options.id,
          executorType: 'mcp',
          environment: options.environment,
          operation: operationFor(context.capabilityId),
          request: context.input,
          safeToReplay: true,
        }))
        return success('prepared', context, preparedOutput(prepared))
      } catch (error) {
        return failure('failed', prepareError(error))
      }
    },
    async execute(context): Promise<FabricExecuteResult> {
      let prepared: PreparedMaterial
      try {
        prepared = await prepareMaterial(context, options, resolveBinding, discoverBinding)
        if (!matchesPreparedOutput(context.preparedOutput, prepared)) {
          return failure('permanent_failure', 'INTERNET_MCP_PREPARATION_INVALID')
        }
      } catch {
        return failure('permanent_failure', 'INTERNET_MCP_BINDING_INVALID')
      }

      let receipt: InternetExecutionReceipt
      try {
        receipt = requiredReceipt(accessStore, context.workflowId, prepared.materialDigest)
        if (receipt.result && ['executed', 'verifying', 'verified', 'unknown'].includes(receipt.status)) {
          return success('succeeded', context, receipt.result)
        }
        if (['failed', 'mismatch', 'waiting_user'].includes(receipt.status)) {
          return failure('permanent_failure', receipt.errorCode ?? 'INTERNET_MCP_PREVIOUSLY_FAILED')
        }
        if (receipt.status === 'prepared' || receipt.status === 'unknown') {
          receipt = accessStore(store => store.transitionReceipt({
            workflowId: receipt.workflowId,
            materialDigest: receipt.materialDigest,
            expectedVersion: receipt.version,
            status: 'executing',
          }))
        }
        if (receipt.status !== 'executing') return failure('permanent_failure', 'INTERNET_MCP_RECEIPT_INVALID')
      } catch {
        return failure('permanent_failure', 'INTERNET_MCP_RECEIPT_INVALID')
      }

      let called: McpToolCallResponse
      try {
        called = await callTool(callInput(prepared.binding, context, timeoutMs))
      } catch {
        markUnknown(accessStore, receipt, 'INTERNET_MCP_TRANSPORT_UNCERTAIN')
        return failure('temporary_failure', 'INTERNET_MCP_TRANSPORT_UNCERTAIN', true)
      }
      if (!successfulCall(called, prepared.binding, context.capabilityId)) {
        markUnknown(accessStore, receipt, 'INTERNET_MCP_CALL_UNAVAILABLE')
        return failure('temporary_failure', 'INTERNET_MCP_CALL_UNAVAILABLE', true)
      }

      let output: FabricJsonObject
      try {
        output = normalizeCallResult(context, called.result)
      } catch {
        markFailed(accessStore, receipt, 'INTERNET_MCP_RESPONSE_INVALID')
        return failure('permanent_failure', 'INTERNET_MCP_RESPONSE_INVALID')
      }
      try {
        recordCallCheckpoint(accessStore, receipt, prepared.binding, context.capabilityId, output, 'mcp_call', now())
        accessStore(store => store.transitionReceipt({
          workflowId: receipt.workflowId,
          materialDigest: receipt.materialDigest,
          expectedVersion: currentReceipt(accessStore, receipt.workflowId).version,
          status: 'executed',
          result: output,
        }))
        return success('succeeded', context, output)
      } catch {
        markUnknown(accessStore, currentReceiptOr(accessStore, receipt), 'INTERNET_MCP_RECEIPT_PERSIST_UNCERTAIN')
        return failure('temporary_failure', 'INTERNET_MCP_RECEIPT_PERSIST_UNCERTAIN', true)
      }
    },
    async verify(context): Promise<FabricVerifyResult> {
      let prepared: PreparedMaterial
      let receipt: InternetExecutionReceipt
      try {
        prepared = await prepareMaterial(context, options, resolveBinding, discoverBinding)
        if (!matchesPreparedOutput(context.preparedOutput, prepared)) throw new Error('invalid')
        receipt = requiredReceipt(accessStore, context.workflowId, prepared.materialDigest)
        if (receipt.status === 'verified' && receipt.result) return success('verified', context, receipt.result)
        if (receipt.status === 'mismatch') return failure('mismatch', receipt.errorCode ?? 'INTERNET_MCP_VERIFICATION_MISMATCH')
        if (receipt.status === 'failed' || receipt.status === 'waiting_user') {
          return failure('failed', receipt.errorCode ?? 'INTERNET_MCP_VERIFICATION_FAILED')
        }
        if (!receipt.result || !context.executionOutput
          || stableJson(receipt.result) !== stableJson(context.executionOutput)
          || !validateInternetOutputSemantics(context.capabilityId, context.input, receipt.result)) {
          return failure('failed', 'INTERNET_MCP_EXECUTION_RESULT_INVALID')
        }
        if (receipt.status === 'executed' || receipt.status === 'unknown') {
          receipt = accessStore(store => store.transitionReceipt({
            workflowId: receipt.workflowId,
            materialDigest: receipt.materialDigest,
            expectedVersion: receipt.version,
            status: 'verifying',
          }))
        }
        if (receipt.status !== 'verifying') return failure('failed', 'INTERNET_MCP_RECEIPT_INVALID')
      } catch {
        return failure('failed', 'INTERNET_MCP_VERIFICATION_PREPARATION_INVALID')
      }

      let called: McpToolCallResponse
      try {
        called = await callTool(callInput(prepared.binding, context, timeoutMs))
      } catch {
        markUnknown(accessStore, receipt, 'INTERNET_MCP_VERIFICATION_UNAVAILABLE')
        return failure('unknown', 'INTERNET_MCP_VERIFICATION_UNAVAILABLE')
      }
      if (!successfulCall(called, prepared.binding, context.capabilityId)) {
        markUnknown(accessStore, receipt, 'INTERNET_MCP_VERIFICATION_UNAVAILABLE')
        return failure('unknown', 'INTERNET_MCP_VERIFICATION_UNAVAILABLE')
      }

      let verification: FabricJsonObject
      try {
        verification = normalizeCallResult(context, called.result)
      } catch {
        markFailed(accessStore, receipt, 'INTERNET_MCP_VERIFICATION_RESPONSE_INVALID')
        return failure('failed', 'INTERNET_MCP_VERIFICATION_RESPONSE_INVALID')
      }
      try {
        recordCallCheckpoint(accessStore, receipt, prepared.binding, context.capabilityId, verification,
          'verification_read', now())
      } catch {
        markUnknown(accessStore, currentReceiptOr(accessStore, receipt), 'INTERNET_MCP_VERIFICATION_PERSIST_UNCERTAIN')
        return failure('unknown', 'INTERNET_MCP_VERIFICATION_PERSIST_UNCERTAIN')
      }

      const original = receipt.result!
      const matches = verificationMatches(context.capabilityId, original, verification)
      try {
        const current = currentReceipt(accessStore, receipt.workflowId)
        accessStore(store => store.transitionReceipt({
          workflowId: current.workflowId,
          materialDigest: current.materialDigest,
          expectedVersion: current.version,
          status: matches ? 'verified' : 'mismatch',
          result: original,
          ...(matches ? {} : { errorCode: 'INTERNET_MCP_VERIFICATION_MISMATCH' }),
        }))
      } catch {
        markUnknown(accessStore, currentReceiptOr(accessStore, receipt), 'INTERNET_MCP_VERIFICATION_PERSIST_UNCERTAIN')
        return failure('unknown', 'INTERNET_MCP_VERIFICATION_PERSIST_UNCERTAIN')
      }
      return matches
        ? success('verified', context, original)
        : failure('mismatch', 'INTERNET_MCP_VERIFICATION_MISMATCH')
    },
    async interrupt(): Promise<FabricInterruptResult> {
      return failure('unsupported', 'INTERNET_MCP_INTERRUPT_UNSUPPORTED')
    },
    async compensate(): Promise<FabricCompensateResult> {
      return failure('unsupported', 'INTERNET_MCP_COMPENSATION_UNSUPPORTED')
    },
  }
}

interface PreparedMaterial {
  binding: BilibiliMcpBinding
  materialDigest: string
  tool: string
}

async function prepareMaterial(
  context: FabricExecutionContext,
  options: Pick<InternetMcpExecutorOptions, 'id' | 'environment'>,
  resolveBinding: BindingResolver,
  discoverBinding: BindingDiscovery,
): Promise<PreparedMaterial> {
  if (context.executorId !== options.id || context.executorType !== 'mcp'
    || !validateInternetSemantics(context.capabilityId, context.input)
    || internetTargetAtoms(context.capabilityId, context.target, context.input) === null) {
    throw new Error('INTERNET_MCP_CONTEXT_INVALID')
  }
  const profile = String(context.input.profile)
  const binding = resolveBinding(profile)
  const discovery = await discoverBinding(profile)
  const capability = discovery.capabilities[context.capabilityId as keyof typeof discovery.capabilities]
  if (discovery.profile !== binding.profile || discovery.provider !== binding.provider
    || discovery.server !== binding.server || !capability?.available
    || capability.tool !== binding.tools[context.capabilityId as keyof typeof binding.tools]) {
    throw new Error('INTERNET_MCP_BINDING_UNAVAILABLE')
  }
  return {
    binding,
    materialDigest: materialDigest(context, binding, options.environment),
    tool: binding.tools[context.capabilityId as keyof typeof binding.tools],
  }
}

function preparedOutput(prepared: PreparedMaterial): FabricJsonObject {
  return {
    materialDigest: prepared.materialDigest,
    provider: prepared.binding.provider,
    profile: prepared.binding.profile,
    server: prepared.binding.server,
    tool: prepared.tool,
  }
}

function matchesPreparedOutput(value: FabricJsonObject | undefined, prepared: PreparedMaterial): boolean {
  if (!value) return false
  return value.materialDigest === prepared.materialDigest
    && value.provider === prepared.binding.provider
    && value.profile === prepared.binding.profile
    && value.server === prepared.binding.server
    && value.tool === prepared.tool
}

function callInput(binding: BilibiliMcpBinding, context: FabricExecutionContext, timeoutMs: number) {
  const tool = binding.tools[context.capabilityId as keyof typeof binding.tools]
  return {
    profile: binding.profile,
    server: binding.server,
    tool,
    arguments: context.capabilityId === BILIBILI_SEARCH_CAPABILITY
      ? { query: context.input.query, limit: context.input.limit, page: context.input.page, order: context.input.order }
      : { bvid: context.input.bvid },
    timeoutMs,
  }
}

function successfulCall(
  value: unknown,
  binding: BilibiliMcpBinding,
  capabilityId: string,
): value is McpToolCallResponse {
  if (!plainObject(value)) return false
  return value.ok === true && value.status === 'succeeded' && value.error_code === null
    && value.server === binding.server && value.tool === binding.tools[capabilityId as keyof typeof binding.tools]
}

function normalizeCallResult(context: FabricExecutionContext, payload: unknown): FabricJsonObject {
  let output: FabricJsonObject
  if (context.capabilityId === BILIBILI_SEARCH_CAPABILITY) {
    const normalized = normalizeBilibiliSearchPayload(payload, Number(context.input.limit))
    output = {
      schemaVersion: 1,
      provider: BILIBILI_PROVIDER,
      profile: context.input.profile,
      operation: 'search',
      query: context.input.query,
      status: normalized.omittedCount > 0 ? 'partial' : 'succeeded',
      ...normalized,
    }
  } else if (context.capabilityId === BILIBILI_INSPECT_CAPABILITY) {
    const normalized = normalizeBilibiliInspectPayload(payload)
    output = {
      schemaVersion: 1,
      provider: BILIBILI_PROVIDER,
      profile: context.input.profile,
      operation: 'inspect',
      status: 'succeeded',
      ...normalized,
    }
  } else throw new Error('invalid')
  if (!validateInternetOutputSemantics(context.capabilityId, context.input, output)) throw new Error('invalid')
  return output
}

function verificationMatches(capabilityId: string, original: FabricJsonObject, verification: FabricJsonObject): boolean {
  if (capabilityId === BILIBILI_INSPECT_CAPABILITY) {
    return plainObject(original.video) && plainObject(verification.video)
      && original.video.bvid === verification.video.bvid
      && original.video.canonicalUrl === verification.video.canonicalUrl
  }
  if (capabilityId !== BILIBILI_SEARCH_CAPABILITY
    || !Array.isArray(original.videos) || !Array.isArray(verification.videos)) return false
  const originalIds = new Set(original.videos.flatMap(video => plainObject(video) && typeof video.bvid === 'string' ? [video.bvid] : []))
  const verificationIds = verification.videos.flatMap(video => plainObject(video) && typeof video.bvid === 'string' ? [video.bvid] : [])
  return originalIds.size === 0 ? verificationIds.length === 0 : verificationIds.some(id => originalIds.has(id))
}

function materialDigest(
  context: FabricExecutionContext,
  binding: BilibiliMcpBinding,
  environment: InternetExecutionEnvironment,
): string {
  return createHash('sha256').update(stableJson({
    executorId: context.executorId,
    environment,
    capabilityId: context.capabilityId,
    capabilityVersion: context.capabilityVersion,
    contractDigest: context.contractDigest,
    input: context.input,
    target: context.target,
    binding: {
      provider: binding.provider,
      profile: binding.profile,
      server: binding.server,
      tool: binding.tools[context.capabilityId as keyof typeof binding.tools],
    },
  })).digest('hex')
}

function operationFor(capabilityId: string): string {
  if (capabilityId === BILIBILI_SEARCH_CAPABILITY) return 'search'
  if (capabilityId === BILIBILI_INSPECT_CAPABILITY) return 'inspect'
  throw new Error('INTERNET_MCP_CONTEXT_INVALID')
}

function requiredReceipt(access: StoreAccess, workflowId: string, digest: string): InternetExecutionReceipt {
  const receipt = access(store => store.getReceipt(workflowId))
  if (!receipt || receipt.materialDigest !== digest || receipt.executorType !== 'mcp') throw new Error('invalid')
  return receipt
}

function currentReceipt(access: StoreAccess, workflowId: string): InternetExecutionReceipt {
  const receipt = access(store => store.getReceipt(workflowId))
  if (!receipt) throw new Error('invalid')
  return receipt
}

function currentReceiptOr(access: StoreAccess, fallback: InternetExecutionReceipt): InternetExecutionReceipt {
  try { return currentReceipt(access, fallback.workflowId) } catch { return fallback }
}

function markUnknown(access: StoreAccess, receipt: InternetExecutionReceipt, errorCode: string): void {
  try {
    const current = currentReceipt(access, receipt.workflowId)
    if (current.status !== 'executing' && current.status !== 'verifying') return
    access(store => store.transitionReceipt({
      workflowId: current.workflowId,
      materialDigest: current.materialDigest,
      expectedVersion: current.version,
      status: 'unknown',
      errorCode,
    }))
  } catch {}
}

function markFailed(access: StoreAccess, receipt: InternetExecutionReceipt, errorCode: string): void {
  try {
    const current = currentReceipt(access, receipt.workflowId)
    if (!['prepared', 'executing', 'executed', 'verifying', 'unknown'].includes(current.status)) return
    access(store => store.transitionReceipt({
      workflowId: current.workflowId,
      materialDigest: current.materialDigest,
      expectedVersion: current.version,
      status: 'failed',
      errorCode,
    }))
  } catch {}
}

function recordCallCheckpoint(
  access: StoreAccess,
  receipt: InternetExecutionReceipt,
  binding: BilibiliMcpBinding,
  capabilityId: string,
  output: FabricJsonObject,
  kind: 'mcp_call' | 'verification_read',
  observedAt: string,
): void {
  const ordinal = access(store => store.listCheckpoints(receipt.workflowId).length)
  access(store => store.recordCheckpoint({
    workflowId: receipt.workflowId,
    materialDigest: receipt.materialDigest,
    ordinal,
    kind,
    evidenceDigest: createHash('sha256').update(stableJson(output)).digest('hex'),
    details: {
      provider: binding.provider,
      profile: binding.profile,
      server: binding.server,
      tool: binding.tools[capabilityId as keyof typeof binding.tools],
      capabilityId,
      phase: kind === 'mcp_call' ? 'execute' : 'verify',
    },
    observedAt,
  }))
}

function prepareError(error: unknown): string {
  if (error instanceof Error && [
    'INTERNET_MCP_CONTEXT_INVALID', 'INTERNET_MCP_BINDING_UNAVAILABLE',
  ].includes(error.message)) return error.message
  return 'INTERNET_MCP_PREPARATION_FAILED'
}

function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return {
    outcome,
    output,
    evidence: [{
      kind: 'internet_mcp',
      summary: outcome,
      data: { capabilityId: context.capabilityId, provider: BILIBILI_PROVIDER, profile: context.input.profile },
      capturedAt: context.now ?? new Date().toISOString(),
    }],
    errorCode: null,
    safeToRetry: false,
  }
}

function failure<T extends string>(outcome: T, errorCode: string, safeToRetry = false) {
  return { outcome, output: {}, evidence: [], errorCode, safeToRetry }
}

function defaultStoreAccess<T>(operation: (store: InternetExecutionStore) => T): T {
  return withInternetExecutionDb<T>(database => operation(new InternetExecutionStore(database)) as
    T & (T extends PromiseLike<unknown> ? never : unknown))
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return 30_000
  if (!Number.isFinite(value)) throw new Error('INTERNET_MCP_EXECUTOR_CONFIGURATION_INVALID')
  return Math.max(1_000, Math.min(60_000, Math.floor(value)))
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('invalid')
    return `[${value.map(stableJson).join(',')}]`
  }
  if (!plainObject(value)) throw new Error('invalid')
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  if (entries.some(([, item]) => item === undefined)) throw new Error('invalid')
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}
