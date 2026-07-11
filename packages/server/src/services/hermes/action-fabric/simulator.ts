import { createHash } from 'crypto'
import type {
  FabricCompensateResult,
  FabricExecutionContext,
  FabricExecuteResult,
  FabricExecutorAdapter,
  FabricExecutorPhase,
  FabricInterruptResult,
  FabricPrepareResult,
  FabricVerifyResult,
} from './executors'
import type { FabricEvidence, FabricJsonObject } from './types'

export type SimulatorFault = 'temporary_failure' | 'permanent_failure' | 'unknown'
  | 'verification_mismatch' | 'compensation_failure'

export interface SimulatorExecutorOptions {
  faultFor?: (context: FabricExecutionContext, phase: FabricExecutorPhase) => SimulatorFault | null
  maxExecutionTokens?: number
}

export function createSimulatorExecutorAdapter(options: SimulatorExecutorOptions = {}): FabricExecutorAdapter {
  const maxExecutionTokens = options.maxExecutionTokens ?? 4_096
  if (!Number.isSafeInteger(maxExecutionTokens) || maxExecutionTokens < 1 || maxExecutionTokens > 100_000) {
    throw new Error('SIMULATOR_EXECUTION_CACHE_LIMIT_INVALID')
  }
  const counters = new Map<string, number>()
  const executions = new Map<string, { materialDigest: string; promise: Promise<FabricExecuteResult> }>()

  return {
    id: 'simulator-main',
    type: 'simulator',
    async prepare(context): Promise<FabricPrepareResult> {
      return success('prepared', context, { capabilityId: context.capabilityId })
    },
    execute(context): Promise<FabricExecuteResult> {
      const materialDigest = executionMaterialDigest(context)
      const existing = executions.get(context.executionToken)
      if (existing) {
        return existing.materialDigest === materialDigest
          ? existing.promise
          : Promise.resolve(failure('permanent_failure', 'SIMULATOR_EXECUTION_TOKEN_CONFLICT'))
      }
      if (executions.size >= maxExecutionTokens) {
        return Promise.resolve(failure('permanent_failure', 'SIMULATOR_EXECUTION_CACHE_FULL'))
      }
      // No rejected execution promise escapes the adapter: its side-effect status is unknown,
      // so the normalized outcome remains cached and is never retried blindly.
      const pending = executeOnce(context, options, counters)
        .catch(() => failure('unknown', 'SIMULATOR_EXECUTION_EXCEPTION'))
      const entry = { materialDigest, promise: pending }
      executions.set(context.executionToken, entry)
      void pending.then(result => {
        if (result.outcome === 'temporary_failure' && result.safeToRetry
          && executions.get(context.executionToken) === entry) {
          executions.delete(context.executionToken)
        }
      })
      return pending
    },
    async verify(context): Promise<FabricVerifyResult> {
      if (options.faultFor?.(context, 'verify') === 'verification_mismatch') {
        return failure('mismatch', 'SIMULATOR_VERIFICATION_MISMATCH')
      }
      if (context.capabilityId === 'simulator.echo' && context.executionOutput
        && canonical(context.executionOutput) !== canonical(context.input)) {
        return failure('mismatch', 'SIMULATOR_VERIFICATION_MISMATCH')
      }
      return success('verified', context, context.executionOutput ?? {})
    },
    async interrupt(context): Promise<FabricInterruptResult> {
      return success('interrupted', context, {})
    },
    async compensate(context): Promise<FabricCompensateResult> {
      if (options.faultFor?.(context, 'compensate') === 'compensation_failure') {
        return failure('failed', 'SIMULATOR_COMPENSATION_FAILURE')
      }
      return { ...success('unsupported', context, {}), errorCode: 'SIMULATOR_COMPENSATION_UNSUPPORTED' }
    },
  }
}

function executionMaterialDigest(context: FabricExecutionContext): string {
  return createHash('sha256').update(canonical({
    capabilityId: context.capabilityId,
    capabilityVersion: context.capabilityVersion,
    input: context.input,
    target: context.target,
  }), 'utf8').digest('hex')
}

async function executeOnce(
  context: FabricExecutionContext,
  options: SimulatorExecutorOptions,
  counters: Map<string, number>,
): Promise<FabricExecuteResult> {
  const fault = options.faultFor?.(context, 'execute')
  if (fault === 'temporary_failure') return failure(fault, 'SIMULATOR_TEMPORARY_FAILURE', true)
  if (fault === 'permanent_failure') return failure(fault, 'SIMULATOR_PERMANENT_FAILURE')
  if (fault === 'unknown') return failure(fault, 'SIMULATOR_UNKNOWN')
  if (context.capabilityId === 'simulator.echo') return success('succeeded', context, context.input)
  if (context.capabilityId === 'simulator.counter.increment') {
    const counter = typeof context.input.counter === 'string' && context.input.counter ? context.input.counter : 'default'
    const amount = typeof context.input.amount === 'number' && Number.isSafeInteger(context.input.amount)
      ? context.input.amount : 1
    const value = (counters.get(counter) ?? 0) + amount
    counters.set(counter, value)
    return success('succeeded', context, { counter, value })
  }
  return failure('permanent_failure', 'SIMULATOR_CAPABILITY_UNSUPPORTED')
}

function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return {
    outcome, output, evidence: [evidence(context, `${outcome}`)], errorCode: null, safeToRetry: false,
  }
}

function failure<T extends string>(outcome: T, errorCode: string, safeToRetry = false) {
  return { outcome, output: {}, evidence: [], errorCode, safeToRetry }
}

function evidence(context: FabricExecutionContext, summary: string): FabricEvidence {
  return {
    kind: 'simulator', summary, data: { capabilityId: context.capabilityId, executionToken: context.executionToken },
    capturedAt: context.now ?? new Date().toISOString(),
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
