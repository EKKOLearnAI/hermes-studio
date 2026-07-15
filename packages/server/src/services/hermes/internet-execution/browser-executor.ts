import { createHash } from 'node:crypto'
import type { AgentBridgeBrowserResponse } from '../agent-bridge'
import { isFabricSensitiveString } from '../action-fabric/audit'
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
import {
  BILIBILI_INSPECT_CAPABILITY,
  BILIBILI_PROVIDER,
  BILIBILI_SEARCH_CAPABILITY,
  bilibiliSearchUrl,
  bilibiliVideoUrl,
  internetTargetAtoms,
  isAllowedBilibiliPublicUrl,
  normalizeBilibiliInspectPayload,
  normalizeBilibiliSearchPayload,
  validateInternetOutputSemantics,
  validateInternetSemantics,
} from './fabric-contracts'
import { navigateProfileBrowser, snapshotProfileBrowser } from './browser-bridge'
import { withInternetExecutionDb } from './database'
import { InternetExecutionStore } from './store'
import type { InternetExecutionEnvironment, InternetExecutionReceipt } from './types'

const EXECUTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const BVID = /BV[0-9A-Za-z]{10}/g
const MAX_SNAPSHOT_BYTES = 65_536
const MAX_SNAPSHOT_LINES = 2_000
const MAX_LINE_LENGTH = 2_048
const BRIDGE_CONTRACT = 'bilibili-accessibility-v1'
const CHALLENGE = /captcha|are you (?:a )?robot|human verification|verification required|please verify|cloudflare|checking your browser|\u4eba\u673a\u9a8c\u8bc1|\u5b89\u5168\u9a8c\u8bc1|\u8bf7\u5b8c\u6210\u9a8c\u8bc1|\u6ed1\u5757\u9a8c\u8bc1/i
const LOGIN = /login required|sign in to continue|please log in to continue|\u8bf7\u5148\u767b\u5f55|\u767b\u5f55\u540e(?:\u624d\u53ef|\u53ef\u4ee5|\u67e5\u770b|\u7ee7\u7eed)|\u626b\u7801\u767b\u5f55/i
const CONSENT = /consent required|accept cookies to continue|privacy choices required|\u8bf7\u540c\u610f(?:\u9690\u79c1|\u7528\u6237)\u534f\u8bae|\u540c\u610f\u540e\u7ee7\u7eed/i

type StoreAccess = <T>(operation: (store: InternetExecutionStore) => T) => T
type BrowserNavigate = (input: {
  workflowId: string; profile: string; url: string; timeoutMs?: number
}) => Promise<AgentBridgeBrowserResponse>
type BrowserSnapshot = (input: {
  workflowId: string; profile: string; timeoutMs?: number
}) => Promise<AgentBridgeBrowserResponse>

export interface InternetBrowserExecutorOptions {
  id: string
  environment: InternetExecutionEnvironment
  timeoutMs?: number
  now?: () => string
  accessStore?: StoreAccess
  navigate?: BrowserNavigate
  snapshot?: BrowserSnapshot
}

interface PreparedMaterial {
  profile: string
  publicUrl: string
  operation: 'search' | 'inspect'
  materialDigest: string
}

type CaptureResult =
  | { kind: 'success'; output: FabricJsonObject }
  | { kind: 'waiting'; errorCode: string }
  | { kind: 'temporary'; errorCode: string }
  | { kind: 'permanent'; errorCode: string }

export function createInternetBrowserExecutorAdapter(options: InternetBrowserExecutorOptions): FabricExecutorAdapter {
  if (!EXECUTOR_ID.test(options.id) || !['sandbox', 'production'].includes(options.environment)) {
    throw new Error('INTERNET_BROWSER_EXECUTOR_CONFIGURATION_INVALID')
  }
  const timeoutMs = boundedTimeout(options.timeoutMs)
  const now = options.now ?? (() => new Date().toISOString())
  const accessStore = options.accessStore ?? defaultStoreAccess
  const navigate = options.navigate ?? navigateProfileBrowser
  const snapshot = options.snapshot ?? snapshotProfileBrowser

  return {
    id: options.id,
    type: 'browser',
    async prepare(context): Promise<FabricPrepareResult> {
      try {
        const prepared = prepareMaterial(context, options)
        accessStore(store => store.prepareReceipt({
          workflowId: context.workflowId,
          intentId: context.intentId,
          materialDigest: prepared.materialDigest,
          capabilityId: context.capabilityId,
          provider: BILIBILI_PROVIDER,
          profile: prepared.profile,
          executorId: options.id,
          executorType: 'browser',
          environment: options.environment,
          operation: prepared.operation,
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
      let receipt: InternetExecutionReceipt
      try {
        prepared = prepareMaterial(context, options)
        if (!matchesPreparedOutput(context.preparedOutput, prepared)) {
          return failure('permanent_failure', 'INTERNET_BROWSER_PREPARATION_INVALID')
        }
        receipt = requiredReceipt(accessStore, context.workflowId, prepared.materialDigest)
        if (receipt.result && ['executed', 'verifying', 'verified', 'unknown'].includes(receipt.status)) {
          return success('succeeded', context, receipt.result)
        }
        if (receipt.status === 'failed' || receipt.status === 'mismatch') {
          return failure('permanent_failure', receipt.errorCode ?? 'INTERNET_BROWSER_PREVIOUSLY_FAILED')
        }
        if (['prepared', 'unknown', 'waiting_user'].includes(receipt.status)) {
          receipt = transition(accessStore, receipt, 'executing')
        }
        if (receipt.status !== 'executing') return failure('permanent_failure', 'INTERNET_BROWSER_RECEIPT_INVALID')
      } catch {
        return failure('permanent_failure', 'INTERNET_BROWSER_RECEIPT_INVALID')
      }

      const priorNavigation = hasNavigationCheckpoint(accessStore, receipt.workflowId, prepared.publicUrl)
      const captured = await captureBrowserOutput(
        context, prepared, timeoutMs, priorNavigation, navigate, snapshot,
        () => recordNavigationCheckpoint(accessStore, receipt, context.capabilityId, prepared.publicUrl, now(), 'execute'),
      )
      if (captured.kind !== 'success') return captureFailure(accessStore, receipt, captured, 'execute')

      try {
        recordSnapshotCheckpoint(accessStore, receipt, context.capabilityId, prepared.publicUrl,
          captured.output, 'browser_snapshot', now(), 'execute')
        const current = currentReceipt(accessStore, receipt.workflowId)
        accessStore(store => store.transitionReceipt({
          workflowId: current.workflowId,
          materialDigest: current.materialDigest,
          expectedVersion: current.version,
          status: 'executed',
          result: captured.output,
        }))
        return success('succeeded', context, captured.output)
      } catch {
        markUnknown(accessStore, currentReceiptOr(accessStore, receipt), 'INTERNET_BROWSER_RECEIPT_PERSIST_UNCERTAIN')
        return failure('temporary_failure', 'INTERNET_BROWSER_RECEIPT_PERSIST_UNCERTAIN', true)
      }
    },
    async verify(context): Promise<FabricVerifyResult> {
      let prepared: PreparedMaterial
      let receipt: InternetExecutionReceipt
      let original: FabricJsonObject
      try {
        prepared = prepareMaterial(context, options)
        if (!matchesPreparedOutput(context.preparedOutput, prepared)) throw new Error('invalid')
        receipt = requiredReceipt(accessStore, context.workflowId, prepared.materialDigest)
        if (receipt.status === 'verified' && receipt.result) return success('verified', context, receipt.result)
        if (receipt.status === 'mismatch') {
          return failure('mismatch', receipt.errorCode ?? 'INTERNET_BROWSER_VERIFICATION_MISMATCH')
        }
        if (receipt.status === 'failed') {
          return failure('failed', receipt.errorCode ?? 'INTERNET_BROWSER_VERIFICATION_FAILED')
        }
        if (!receipt.result || !context.executionOutput
          || stableJson(receipt.result) !== stableJson(context.executionOutput)
          || !validateInternetOutputSemantics(context.capabilityId, context.input, receipt.result)) {
          return failure('failed', 'INTERNET_BROWSER_EXECUTION_RESULT_INVALID')
        }
        original = receipt.result
        if (['executed', 'unknown', 'waiting_user'].includes(receipt.status)) {
          receipt = transition(accessStore, receipt, 'verifying')
        }
        if (receipt.status !== 'verifying') return failure('failed', 'INTERNET_BROWSER_RECEIPT_INVALID')
      } catch {
        return failure('failed', 'INTERNET_BROWSER_VERIFICATION_PREPARATION_INVALID')
      }

      const priorNavigation = hasNavigationCheckpoint(accessStore, receipt.workflowId, prepared.publicUrl)
      const captured = await captureBrowserOutput(
        context, prepared, timeoutMs, priorNavigation, navigate, snapshot,
        () => recordNavigationCheckpoint(accessStore, receipt, context.capabilityId, prepared.publicUrl, now(), 'verify'),
      )
      if (captured.kind !== 'success') return captureFailure(accessStore, receipt, captured, 'verify')

      try {
        recordSnapshotCheckpoint(accessStore, receipt, context.capabilityId, prepared.publicUrl,
          captured.output, 'verification_read', now(), 'verify')
      } catch {
        markUnknown(accessStore, currentReceiptOr(accessStore, receipt), 'INTERNET_BROWSER_VERIFICATION_PERSIST_UNCERTAIN')
        return failure('unknown', 'INTERNET_BROWSER_VERIFICATION_PERSIST_UNCERTAIN')
      }

      const matches = verificationMatches(context.capabilityId, original, captured.output)
      try {
        const current = currentReceipt(accessStore, receipt.workflowId)
        accessStore(store => store.transitionReceipt({
          workflowId: current.workflowId,
          materialDigest: current.materialDigest,
          expectedVersion: current.version,
          status: matches ? 'verified' : 'mismatch',
          result: original,
          ...(matches ? {} : { errorCode: 'INTERNET_BROWSER_VERIFICATION_MISMATCH' }),
        }))
      } catch {
        markUnknown(accessStore, currentReceiptOr(accessStore, receipt), 'INTERNET_BROWSER_VERIFICATION_PERSIST_UNCERTAIN')
        return failure('unknown', 'INTERNET_BROWSER_VERIFICATION_PERSIST_UNCERTAIN')
      }
      return matches
        ? success('verified', context, original)
        : failure('mismatch', 'INTERNET_BROWSER_VERIFICATION_MISMATCH')
    },
    async interrupt(): Promise<FabricInterruptResult> {
      return failure('unsupported', 'INTERNET_BROWSER_INTERRUPT_UNSUPPORTED')
    },
    async compensate(): Promise<FabricCompensateResult> {
      return failure('unsupported', 'INTERNET_BROWSER_COMPENSATION_UNSUPPORTED')
    },
  }
}

function prepareMaterial(
  context: FabricExecutionContext,
  options: Pick<InternetBrowserExecutorOptions, 'id' | 'environment'>,
): PreparedMaterial {
  if (context.executorId !== options.id || context.executorType !== 'browser'
    || !validateInternetSemantics(context.capabilityId, context.input)
    || internetTargetAtoms(context.capabilityId, context.target, context.input) === null) {
    throw new Error('INTERNET_BROWSER_CONTEXT_INVALID')
  }
  const profile = String(context.input.profile)
  const operation = operationFor(context.capabilityId)
  const publicUrl = operation === 'search'
    ? bilibiliSearchUrl({ query: context.input.query, order: context.input.order, page: context.input.page })
    : bilibiliVideoUrl(String(context.input.bvid))
  if (!isAllowedBilibiliPublicUrl(publicUrl)) throw new Error('INTERNET_BROWSER_URL_INVALID')
  return {
    profile,
    publicUrl,
    operation,
    materialDigest: createHash('sha256').update(stableJson({
      executorId: context.executorId,
      environment: options.environment,
      capabilityId: context.capabilityId,
      capabilityVersion: context.capabilityVersion,
      contractDigest: context.contractDigest,
      input: context.input,
      target: context.target,
      binding: { provider: BILIBILI_PROVIDER, profile, publicUrl, bridgeContract: BRIDGE_CONTRACT },
    })).digest('hex'),
  }
}

function preparedOutput(prepared: PreparedMaterial): FabricJsonObject {
  return {
    materialDigest: prepared.materialDigest,
    provider: BILIBILI_PROVIDER,
    profile: prepared.profile,
    operation: prepared.operation,
    bridgeContract: BRIDGE_CONTRACT,
    targetDigest: createHash('sha256').update(prepared.publicUrl).digest('hex'),
  }
}

function matchesPreparedOutput(value: FabricJsonObject | undefined, prepared: PreparedMaterial): boolean {
  if (!value) return false
  return stableJson(value) === stableJson(preparedOutput(prepared))
}

async function captureBrowserOutput(
  context: FabricExecutionContext,
  prepared: PreparedMaterial,
  timeoutMs: number,
  hasPriorNavigation: boolean,
  navigate: BrowserNavigate,
  snapshot: BrowserSnapshot,
  recordNavigation: () => void,
): Promise<CaptureResult> {
  let navigated = false
  if (!hasPriorNavigation) {
    const result = await navigateOnce(context, prepared, timeoutMs, navigate)
    if (result.kind !== 'success') return result
    try { recordNavigation() } catch { return { kind: 'temporary', errorCode: 'INTERNET_BROWSER_NAVIGATION_PERSIST_UNCERTAIN' } }
    navigated = true
  }

  let captured = await snapshotOnce(context, prepared, timeoutMs, snapshot)
  if (captured.kind === 'reopen' && !navigated) {
    const result = await navigateOnce(context, prepared, timeoutMs, navigate)
    if (result.kind !== 'success') return result
    try { recordNavigation() } catch { return { kind: 'temporary', errorCode: 'INTERNET_BROWSER_NAVIGATION_PERSIST_UNCERTAIN' } }
    captured = await snapshotOnce(context, prepared, timeoutMs, snapshot)
  }
  if (captured.kind === 'reopen') {
    return { kind: 'temporary', errorCode: 'INTERNET_BROWSER_SESSION_UNAVAILABLE' }
  }
  if (captured.kind !== 'snapshot') return captured
  try {
    return { kind: 'success', output: normalizeBilibiliBrowserSnapshot(
      context.capabilityId, context.input, prepared.publicUrl, captured.value,
    ) }
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.message)
      ? error.message : 'INTERNET_BROWSER_SNAPSHOT_INVALID'
    if (code === 'INTERNET_BROWSER_HUMAN_VERIFICATION_REQUIRED'
      || code === 'INTERNET_BROWSER_LOGIN_REQUIRED' || code === 'INTERNET_BROWSER_CONSENT_REQUIRED') {
      return { kind: 'waiting', errorCode: code }
    }
    return { kind: 'permanent', errorCode: code }
  }
}

async function navigateOnce(
  context: FabricExecutionContext,
  prepared: PreparedMaterial,
  timeoutMs: number,
  navigate: BrowserNavigate,
): Promise<CaptureResult> {
  let response: AgentBridgeBrowserResponse
  try {
    response = await navigate({
      workflowId: context.workflowId, profile: prepared.profile, url: prepared.publicUrl, timeoutMs,
    })
  } catch {
    return { kind: 'temporary', errorCode: 'INTERNET_BROWSER_NAVIGATION_UNAVAILABLE' }
  }
  if (!validBaseResponse(response, context.workflowId, 'navigate')) {
    return { kind: 'permanent', errorCode: 'INTERNET_BROWSER_NAVIGATION_INVALID' }
  }
  if (response.status === 'waiting_user') return waitingFromBridge(response.error_code)
  if (response.status === 'error') {
    return { kind: 'temporary', errorCode: 'INTERNET_BROWSER_NAVIGATION_UNAVAILABLE' }
  }
  if (response.error_code !== null || response.url !== prepared.publicUrl
    || typeof response.title !== 'string' || response.title.length > 512) {
    return { kind: 'permanent', errorCode: 'INTERNET_BROWSER_NAVIGATION_INVALID' }
  }
  return { kind: 'success', output: {} }
}

async function snapshotOnce(
  context: FabricExecutionContext,
  prepared: PreparedMaterial,
  timeoutMs: number,
  snapshot: BrowserSnapshot,
): Promise<CaptureResult | { kind: 'reopen' } | { kind: 'snapshot'; value: string }> {
  let response: AgentBridgeBrowserResponse
  try {
    response = await snapshot({ workflowId: context.workflowId, profile: prepared.profile, timeoutMs })
  } catch {
    return { kind: 'temporary', errorCode: 'INTERNET_BROWSER_SNAPSHOT_UNAVAILABLE' }
  }
  if (!validBaseResponse(response, context.workflowId, 'snapshot')) {
    return { kind: 'permanent', errorCode: 'INTERNET_BROWSER_SNAPSHOT_INVALID' }
  }
  if (response.status === 'waiting_user') return waitingFromBridge(response.error_code)
  if (response.status === 'error') {
    return response.error_code === 'BROWSER_SESSION_REOPEN_REQUIRED'
      ? { kind: 'reopen' }
      : { kind: 'temporary', errorCode: 'INTERNET_BROWSER_SNAPSHOT_UNAVAILABLE' }
  }
  if (response.error_code !== null || response.url !== prepared.publicUrl
    || typeof response.snapshot !== 'string' || !Number.isSafeInteger(response.element_count)
    || Number(response.element_count) < 0 || Number(response.element_count) > 100_000) {
    return { kind: 'permanent', errorCode: 'INTERNET_BROWSER_SNAPSHOT_INVALID' }
  }
  return { kind: 'snapshot', value: response.snapshot }
}

function validBaseResponse(value: unknown, workflowId: string, action: 'navigate' | 'snapshot'):
  value is AgentBridgeBrowserResponse {
  return plainObject(value) && value.ok === true && value.action === action && value.workflow_id === workflowId
    && typeof value.session_id === 'string' && /^browser-session-[a-f0-9]{24}$/.test(value.session_id)
    && ['succeeded', 'error', 'waiting_user'].includes(String(value.status))
    && (value.error_code === null || (typeof value.error_code === 'string'
      && /^[A-Z][A-Z0-9_]{1,127}$/.test(value.error_code)))
    && (value.status === 'succeeded' ? value.error_code === null : typeof value.error_code === 'string')
}

function waitingFromBridge(errorCode: string | null): CaptureResult {
  if (errorCode === 'BROWSER_HUMAN_VERIFICATION_REQUIRED') {
    return { kind: 'waiting', errorCode: 'INTERNET_BROWSER_HUMAN_VERIFICATION_REQUIRED' }
  }
  if (errorCode === 'BROWSER_LOGIN_REQUIRED') {
    return { kind: 'waiting', errorCode: 'INTERNET_BROWSER_LOGIN_REQUIRED' }
  }
  if (errorCode === 'BROWSER_CONSENT_REQUIRED') {
    return { kind: 'waiting', errorCode: 'INTERNET_BROWSER_CONSENT_REQUIRED' }
  }
  return { kind: 'permanent', errorCode: 'INTERNET_BROWSER_SNAPSHOT_INVALID' }
}

export function normalizeBilibiliBrowserSnapshot(
  capabilityId: string,
  input: FabricJsonObject,
  publicUrl: string,
  snapshot: string,
): FabricJsonObject {
  if (!validateInternetSemantics(capabilityId, input) || !isAllowedBilibiliPublicUrl(publicUrl)
    || typeof snapshot !== 'string' || Buffer.byteLength(snapshot, 'utf8') > MAX_SNAPSHOT_BYTES
    || isFabricSensitiveString(snapshot)) {
    throw new Error('INTERNET_BROWSER_SNAPSHOT_INVALID')
  }
  if (CHALLENGE.test(snapshot)) throw new Error('INTERNET_BROWSER_HUMAN_VERIFICATION_REQUIRED')
  if (LOGIN.test(snapshot)) throw new Error('INTERNET_BROWSER_LOGIN_REQUIRED')
  if (CONSENT.test(snapshot)) throw new Error('INTERNET_BROWSER_CONSENT_REQUIRED')
  const lines = snapshot.split(/\r?\n/)
  if (lines.length > MAX_SNAPSHOT_LINES || lines.some(line => line.length > MAX_LINE_LENGTH)) {
    throw new Error('INTERNET_BROWSER_SNAPSHOT_INVALID')
  }

  let output: FabricJsonObject
  if (capabilityId === BILIBILI_SEARCH_CAPABILITY) {
    const items = searchItems(lines)
    const normalized = normalizeBilibiliSearchPayload({ items }, Number(input.limit))
    output = {
      schemaVersion: 1,
      provider: BILIBILI_PROVIDER,
      profile: input.profile,
      operation: 'search',
      query: input.query,
      status: normalized.omittedCount > 0 ? 'partial' : 'succeeded',
      ...normalized,
    }
  } else if (capabilityId === BILIBILI_INSPECT_CAPABILITY) {
    const expectedBvid = String(input.bvid)
    const observedBvids = new Set(snapshot.match(BVID) ?? [])
    if (publicUrl !== bilibiliVideoUrl(expectedBvid) || !observedBvids.has(expectedBvid)) {
      throw new Error('INTERNET_BROWSER_SNAPSHOT_INVALID')
    }
    const title = inspectTitle(lines)
    const author = ownerName(lines, 0, lines.length)
    if (!title || !author) throw new Error('INTERNET_BROWSER_SNAPSHOT_INVALID')
    const normalized = normalizeBilibiliInspectPayload({
      bvid: expectedBvid,
      title,
      author,
      description: labelledValue(lines, /^(?:description|desc|\u7b80\u4ecb)\s*[:\uff1a]\s*(.+)$/i) ?? '',
      tags: [],
    })
    output = {
      schemaVersion: 1,
      provider: BILIBILI_PROVIDER,
      profile: input.profile,
      operation: 'inspect',
      status: 'succeeded',
      ...normalized,
    }
  } else throw new Error('INTERNET_BROWSER_SNAPSHOT_INVALID')
  if (!validateInternetOutputSemantics(capabilityId, input, output)) {
    throw new Error('INTERNET_BROWSER_SNAPSHOT_INVALID')
  }
  return output
}

function searchItems(lines: string[]): Array<Record<string, unknown>> {
  const occurrences = new Map<string, number[]>()
  for (let index = 0; index < lines.length; index += 1) {
    const matches = lines[index]!.match(BVID) ?? []
    for (const bvid of matches) {
      const indexes = occurrences.get(bvid) ?? []
      indexes.push(index)
      occurrences.set(bvid, indexes)
    }
  }
  const ordered = [...occurrences.entries()].sort((left, right) => left[1][0]! - right[1][0]!)
  const items: Array<Record<string, unknown>> = []
  for (let index = 0; index < ordered.length; index += 1) {
    const [bvid, indexes] = ordered[index]!
    const start = Math.max(0, indexes[0]! - 8)
    const nextStart = ordered[index + 1]?.[1][0] ?? lines.length
    const end = Math.min(lines.length, indexes[indexes.length - 1]! + 24, nextStart)
    const title = cardTitle(lines, start, indexes[0]!)
    const author = ownerName(lines, start, end)
    if (title && author) items.push({ bvid, title, author })
    if (items.length >= 100) break
  }
  if (occurrences.size > 0 && items.length === 0) throw new Error('INTERNET_BROWSER_SNAPSHOT_INVALID')
  return items
}

function cardTitle(lines: string[], start: number, bvidLine: number): string | null {
  for (let index = bvidLine; index >= start; index -= 1) {
    const candidate = accessibleName(lines[index]!)
    if (candidate && usableTitle(candidate)) return candidate
  }
  return null
}

function inspectTitle(lines: string[]): string | null {
  for (const line of lines) {
    if (!/\bheading\b|\u6807\u9898\s*[:\uff1a]/i.test(line)) continue
    const candidate = accessibleName(line) ?? line.match(/\u6807\u9898\s*[:\uff1a]\s*(.+)$/)?.[1]?.trim() ?? null
    if (candidate && usableTitle(candidate)) return candidate
  }
  return null
}

function ownerName(lines: string[], start: number, end: number): string | null {
  const boundedEnd = Math.min(lines.length, end)
  for (let index = start; index < boundedEnd; index += 1) {
    const labelled = lines[index]!.match(/(?:UP\u4e3b|\u4f5c\u8005|author|uploader)\s*[:\uff1a]\s*["\u201c]?([^"\u201d\[\n]{1,160})/i)?.[1]?.trim()
    if (labelled && usableName(labelled)) return labelled
  }
  for (let index = start; index < boundedEnd; index += 1) {
    if (!/space\.bilibili\.com/i.test(lines[index]!)) continue
    for (let prior = index - 1; prior >= Math.max(start, index - 3); prior -= 1) {
      const candidate = accessibleName(lines[prior]!)
      if (candidate && usableName(candidate)) return candidate
    }
  }
  return null
}

function labelledValue(lines: string[], pattern: RegExp): string | null {
  for (const line of lines) {
    const value = line.trim().replace(/^[-*]\s*/, '').match(pattern)?.[1]?.trim()
    if (value) return value
  }
  return null
}

function accessibleName(line: string): string | null {
  const quoted = line.match(/(?:link|heading|text|button)\s+["\u201c]([^"\u201d]{1,240})["\u201d]/i)?.[1]?.trim()
  if (quoted) return quoted
  return line.match(/(?:name|title)\s*[:=]\s*["\u201c]?([^"\u201d\[\n]{1,240})/i)?.[1]?.trim() ?? null
}

function usableTitle(value: string): boolean {
  return usableName(value) && !/^bilibili$|^\u54d4\u54e9\u54d4\u54e9$|^\u9996\u9875$|^\u7a0d\u540e\u518d\u770b$/i.test(value)
    && !/^https?:|\/video\/BV/i.test(value)
}

function usableName(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
    && !isFabricSensitiveString(value)
}

function captureFailure(
  access: StoreAccess,
  receipt: InternetExecutionReceipt,
  result: Exclude<CaptureResult, { kind: 'success' }>,
  phase: 'execute',
): FabricExecuteResult
function captureFailure(
  access: StoreAccess,
  receipt: InternetExecutionReceipt,
  result: Exclude<CaptureResult, { kind: 'success' }>,
  phase: 'verify',
): FabricVerifyResult
function captureFailure(
  access: StoreAccess,
  receipt: InternetExecutionReceipt,
  result: Exclude<CaptureResult, { kind: 'success' }>,
  phase: 'execute' | 'verify',
): FabricExecuteResult | FabricVerifyResult {
  if (result.kind === 'waiting') {
    markWaitingUser(access, receipt, result.errorCode)
    return failure('unknown', result.errorCode)
  }
  if (result.kind === 'temporary') {
    markUnknown(access, receipt, result.errorCode)
    return phase === 'execute'
      ? failure('temporary_failure', result.errorCode, true)
      : failure('unknown', result.errorCode)
  }
  markFailed(access, receipt, result.errorCode)
  return phase === 'execute'
    ? failure('permanent_failure', result.errorCode)
    : failure('failed', result.errorCode)
}

function transition(
  access: StoreAccess,
  receipt: InternetExecutionReceipt,
  status: 'executing' | 'verifying',
): InternetExecutionReceipt {
  return access(store => store.transitionReceipt({
    workflowId: receipt.workflowId,
    materialDigest: receipt.materialDigest,
    expectedVersion: receipt.version,
    status,
  }))
}

function recordNavigationCheckpoint(
  access: StoreAccess,
  receipt: InternetExecutionReceipt,
  capabilityId: string,
  publicUrl: string,
  observedAt: string,
  phase: 'execute' | 'verify',
): void {
  const ordinal = access(store => store.listCheckpoints(receipt.workflowId).length)
  access(store => store.recordCheckpoint({
    workflowId: receipt.workflowId,
    materialDigest: receipt.materialDigest,
    ordinal,
    kind: 'browser_navigate',
    publicUrl,
    evidenceDigest: createHash('sha256').update(publicUrl).digest('hex'),
    details: { provider: BILIBILI_PROVIDER, profile: receipt.profile, capabilityId, phase },
    observedAt,
  }))
}

function recordSnapshotCheckpoint(
  access: StoreAccess,
  receipt: InternetExecutionReceipt,
  capabilityId: string,
  publicUrl: string,
  output: FabricJsonObject,
  kind: 'browser_snapshot' | 'verification_read',
  observedAt: string,
  phase: 'execute' | 'verify',
): void {
  const ordinal = access(store => store.listCheckpoints(receipt.workflowId).length)
  access(store => store.recordCheckpoint({
    workflowId: receipt.workflowId,
    materialDigest: receipt.materialDigest,
    ordinal,
    kind,
    publicUrl,
    evidenceDigest: createHash('sha256').update(stableJson(output)).digest('hex'),
    details: { provider: BILIBILI_PROVIDER, profile: receipt.profile, capabilityId, phase, bridgeContract: BRIDGE_CONTRACT },
    observedAt,
  }))
}

function hasNavigationCheckpoint(access: StoreAccess, workflowId: string, publicUrl: string): boolean {
  return access(store => store.listCheckpoints(workflowId))
    .some(checkpoint => checkpoint.kind === 'browser_navigate' && checkpoint.publicUrl === publicUrl)
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

function requiredReceipt(access: StoreAccess, workflowId: string, digest: string): InternetExecutionReceipt {
  const receipt = access(store => store.getReceipt(workflowId))
  if (!receipt || receipt.materialDigest !== digest || receipt.executorType !== 'browser') throw new Error('invalid')
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
    if (!['executing', 'verifying'].includes(current.status)) return
    access(store => store.transitionReceipt({
      workflowId: current.workflowId, materialDigest: current.materialDigest,
      expectedVersion: current.version, status: 'unknown', errorCode,
    }))
  } catch {}
}

function markFailed(access: StoreAccess, receipt: InternetExecutionReceipt, errorCode: string): void {
  try {
    const current = currentReceipt(access, receipt.workflowId)
    if (!['prepared', 'executing', 'executed', 'verifying', 'unknown', 'waiting_user'].includes(current.status)) return
    access(store => store.transitionReceipt({
      workflowId: current.workflowId, materialDigest: current.materialDigest,
      expectedVersion: current.version, status: 'failed', errorCode,
    }))
  } catch {}
}

function markWaitingUser(access: StoreAccess, receipt: InternetExecutionReceipt, errorCode: string): void {
  try {
    const current = currentReceipt(access, receipt.workflowId)
    if (!['prepared', 'executing', 'executed', 'verifying', 'unknown'].includes(current.status)) return
    access(store => store.transitionReceipt({
      workflowId: current.workflowId, materialDigest: current.materialDigest,
      expectedVersion: current.version, status: 'waiting_user', errorCode,
    }))
  } catch {}
}

function operationFor(capabilityId: string): 'search' | 'inspect' {
  if (capabilityId === BILIBILI_SEARCH_CAPABILITY) return 'search'
  if (capabilityId === BILIBILI_INSPECT_CAPABILITY) return 'inspect'
  throw new Error('INTERNET_BROWSER_CONTEXT_INVALID')
}

function prepareError(error: unknown): string {
  if (error instanceof Error && [
    'INTERNET_BROWSER_CONTEXT_INVALID', 'INTERNET_BROWSER_URL_INVALID',
  ].includes(error.message)) return error.message
  return 'INTERNET_BROWSER_PREPARATION_FAILED'
}

function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return {
    outcome,
    output,
    evidence: [{
      kind: 'internet_browser',
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
  if (!Number.isFinite(value)) throw new Error('INTERNET_BROWSER_EXECUTOR_CONFIGURATION_INVALID')
  return Math.max(5_000, Math.min(60_000, Math.floor(value)))
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
