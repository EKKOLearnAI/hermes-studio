import { isProxy } from 'node:util/types'
import { isDeepStrictEqual } from 'node:util'
import type { AndroidCompanionGatewayMessage, AndroidCompanionGatewayReply } from './gateway'
import type { AndroidCompanionStore } from './store'
import {
  AndroidCompanionAuthenticationError,
  AndroidCompanionValidationError,
  type AndroidCompanionCommand,
  type AndroidCommandStatus,
} from './types'

const DEFAULT_RESULT_TIMEOUT_MS = 30_000
const RESULT_STATUSES = ['succeeded', 'failed', 'unknown', 'waiting_user', 'cancelled'] as const

export type AndroidCommandBridgeOutcome =
  | { outcome: 'succeeded'; command: AndroidCompanionCommand; output: Record<string, unknown> }
  | { outcome: 'temporary_failure'; command: AndroidCompanionCommand; errorCode: string; safeToRetry: true }
  | { outcome: 'permanent_failure'; command: AndroidCompanionCommand; errorCode: string; safeToRetry: false }
  | { outcome: 'unknown'; command: AndroidCompanionCommand; errorCode: string; safeToRetry: false }
  | { outcome: 'waiting_user'; command: AndroidCompanionCommand; errorCode: string; safeToRetry: false }
  | { outcome: 'cancelled'; command: AndroidCompanionCommand; errorCode: string; safeToRetry: false }

export interface AndroidCommandTransport {
  send(deviceId: string, reply: AndroidCompanionGatewayReply): Promise<unknown>
  isConnected(deviceId: string): boolean
}

type Waiter = {
  promise: Promise<AndroidCommandBridgeOutcome>
  resolve(outcome: AndroidCommandBridgeOutcome): void
  timer: ReturnType<typeof setTimeout>
}

export class AndroidCompanionCommandBridge {
  readonly #store: AndroidCompanionStore
  readonly #transport: AndroidCommandTransport
  readonly #waiters = new Map<string, Waiter>()
  readonly #timeoutMs: number
  readonly #now: () => Date
  #closed = false

  constructor(input: {
    store: AndroidCompanionStore
    transport: AndroidCommandTransport
    resultTimeoutMs?: number
    now?: () => Date
  }) {
    this.#store = input.store
    this.#transport = input.transport
    this.#timeoutMs = boundedTimeout(input.resultTimeoutMs)
    this.#now = input.now ?? (() => new Date())
  }

  execute(commandId: string): Promise<AndroidCommandBridgeOutcome> {
    if (this.#closed) return Promise.reject(new AndroidCompanionAuthenticationError('Android command bridge is closed'))
    const command = this.requiredCommand(commandId)
    const settled = settledOutcome(command)
    if (settled) return Promise.resolve(settled)
    const active = this.#waiters.get(command.id)
    if (active) return active.promise
    if (!this.#transport.isConnected(command.deviceId)) {
      return Promise.resolve({
        outcome: 'temporary_failure', command, errorCode: 'ANDROID_COMPANION_OFFLINE', safeToRetry: true,
      })
    }
    if (Date.parse(command.expiresAt) <= this.#now().getTime()) {
      const expired = transitionIfActive(this.#store, command, 'failed', 'ANDROID_COMMAND_EXPIRED')
      return Promise.resolve({
        outcome: 'permanent_failure', command: expired, errorCode: 'ANDROID_COMMAND_EXPIRED', safeToRetry: false,
      })
    }
    const waiter = this.createWaiter(command.id)
    this.#waiters.set(command.id, waiter)
    void this.deliver(command).catch(() => {
      const current = this.requiredCommand(command.id)
      const unknown = transitionIfActive(this.#store, current, 'unknown', 'ANDROID_COMMAND_TRANSPORT_UNCERTAIN')
      this.resolveWaiter(command.id, {
        outcome: 'temporary_failure', command: unknown,
        errorCode: 'ANDROID_COMMAND_TRANSPORT_UNCERTAIN', safeToRetry: true,
      })
    })
    return waiter.promise
  }

  async cancel(commandId: string): Promise<AndroidCommandBridgeOutcome> {
    const command = this.requiredCommand(commandId)
    const settled = settledOutcome(command)
    if (settled) return settled
    if (command.status === 'queued') {
      const cancelled = this.#store.transitionCommand({
        id: command.id, expectedVersion: command.version, status: 'cancelled',
      })
      return settledOutcome(cancelled)!
    }
    if (!this.#transport.isConnected(command.deviceId)) return {
      outcome: 'unknown', command, errorCode: 'ANDROID_CANCEL_UNCONFIRMED', safeToRetry: false,
    }
    if (Date.parse(command.expiresAt) <= this.#now().getTime()) return {
      outcome: 'unknown', command, errorCode: 'ANDROID_CANCEL_UNCONFIRMED', safeToRetry: false,
    }
    let waiter = this.#waiters.get(command.id)
    if (!waiter) {
      waiter = this.createWaiter(command.id)
      this.#waiters.set(command.id, waiter)
    }
    const now = this.#now()
    await this.#transport.send(command.deviceId, {
      messageType: 'command.cancel',
      bindingId: command.workflowId,
      expiresAt: new Date(Math.min(Date.parse(command.expiresAt), now.getTime() + 60_000)).toISOString(),
      payload: {
        commandId: command.id,
        workflowId: command.workflowId,
        executionToken: command.executionToken,
        materialDigest: command.materialDigest,
        deliveryAttempt: command.deliverySequence,
      },
    })
    return waiter.promise
  }

  handleMessage(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply | undefined {
    if (message.messageType === 'ack') return this.handleAcknowledgement(message)
    if (message.messageType === 'command.result') return this.handleResult(message)
    return undefined
  }

  shutdown(): void {
    if (this.#closed) return
    this.#closed = true
    for (const [commandId] of this.#waiters) {
      const command = this.requiredCommand(commandId)
      this.resolveWaiter(commandId, {
        outcome: 'unknown', command, errorCode: 'ANDROID_COMMAND_BRIDGE_STOPPED', safeToRetry: false,
      })
    }
  }

  private async deliver(command: AndroidCompanionCommand): Promise<void> {
    const deliveryAttempt = (command.deliverySequence ?? 0) + 1
    const delivered = this.#store.transitionCommand({
      id: command.id,
      expectedVersion: command.version,
      status: 'delivered',
      deliverySequence: deliveryAttempt,
    })
    const now = this.#now()
    const envelopeExpiry = new Date(Math.min(Date.parse(delivered.expiresAt), now.getTime() + 60_000)).toISOString()
    await this.#transport.send(delivered.deviceId, {
      messageType: 'command.execute',
      bindingId: delivered.workflowId,
      expiresAt: envelopeExpiry,
      payload: {
        commandId: delivered.id,
        workflowId: delivered.workflowId,
        executionToken: delivered.executionToken,
        materialDigest: delivered.materialDigest,
        capabilityId: delivered.capabilityId,
        capabilityVersion: delivered.capabilityVersion,
        kind: delivered.kind,
        payload: delivered.payload,
        deliveryAttempt,
        expiresAt: delivered.expiresAt,
      },
    })
  }

  private handleAcknowledgement(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply | undefined {
    const payload = message.payload
    if (!plainRecord(payload) || !exactKeys(payload, ['commandId', 'deliveryAttempt'])) return undefined
    const commandId = dataString(payload, 'commandId')
    const deliveryAttempt = dataPositiveInteger(payload, 'deliveryAttempt')
    const command = this.#store.getCommand(commandId)
    if (!command || command.deviceId !== message.deviceId || command.deliverySequence !== deliveryAttempt) {
      throw invalid('Android command acknowledgement binding is invalid')
    }
    if (command.status === 'delivered') {
      this.#store.transitionCommand({ id: command.id, expectedVersion: command.version, status: 'acknowledged' })
    } else if (!['acknowledged', 'succeeded', 'failed', 'waiting_user', 'cancelled'].includes(command.status)) {
      throw invalid('Android command acknowledgement state is invalid')
    }
    return acknowledgement(message, command.id)
  }

  private handleResult(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply {
    const payload = message.payload
    if (!plainRecord(payload) || !exactKeys(payload, [
      'commandId', 'deliveryAttempt', 'errorCode', 'executionToken', 'materialDigest', 'result', 'status', 'workflowId',
    ])) throw invalid('Android command result envelope is invalid')
    const commandId = dataString(payload, 'commandId')
    const command = this.requiredCommand(commandId)
    const status = dataString(payload, 'status') as typeof RESULT_STATUSES[number]
    const deliveryAttempt = dataPositiveInteger(payload, 'deliveryAttempt')
    if (!RESULT_STATUSES.includes(status) || command.deviceId !== message.deviceId
      || command.workflowId !== dataString(payload, 'workflowId')
      || command.executionToken !== dataString(payload, 'executionToken')
      || command.materialDigest !== dataString(payload, 'materialDigest')
      || command.deliverySequence !== deliveryAttempt) {
      throw invalid('Android command result binding is invalid')
    }
    const resultValue = data(payload, 'result')
    const result = resultValue === null ? null : requirePlainResult(resultValue)
    const errorValue = data(payload, 'errorCode')
    const errorCode = errorValue === null ? null : dataErrorCode(payload, 'errorCode')
    if (status === 'succeeded' ? result === null || errorCode !== null
      : status === 'cancelled' ? errorCode !== null
        : errorCode === null) {
      throw invalid('Android command result outcome is invalid')
    }
    let completed = command
    if (!['succeeded', 'failed', 'cancelled'].includes(command.status)) {
      completed = this.#store.transitionCommand({
        id: command.id,
        expectedVersion: command.version,
        status,
        response: result,
        errorCode,
      })
    } else if (!sameTerminalResult(command, status, result, errorCode)) {
      throw invalid('Android command terminal result changed')
    }
    const outcome = settledOutcome(completed)
    if (!outcome) throw invalid('Android command result did not settle')
    this.resolveWaiter(command.id, outcome)
    return acknowledgement(message, command.id)
  }

  private createWaiter(commandId: string): Waiter {
    let resolve!: (outcome: AndroidCommandBridgeOutcome) => void
    const promise = new Promise<AndroidCommandBridgeOutcome>(accept => { resolve = accept })
    const timer = setTimeout(() => {
      const current = this.requiredCommand(commandId)
      const unknown = transitionIfActive(this.#store, current, 'unknown', 'ANDROID_COMMAND_RESULT_TIMEOUT')
      this.resolveWaiter(commandId, {
        outcome: 'temporary_failure', command: unknown,
        errorCode: 'ANDROID_COMMAND_RESULT_TIMEOUT', safeToRetry: true,
      })
    }, this.#timeoutMs)
    timer.unref?.()
    return { promise, resolve, timer }
  }

  private resolveWaiter(commandId: string, outcome: AndroidCommandBridgeOutcome): void {
    const waiter = this.#waiters.get(commandId)
    if (!waiter) return
    this.#waiters.delete(commandId)
    clearTimeout(waiter.timer)
    waiter.resolve(outcome)
  }

  private requiredCommand(commandId: string): AndroidCompanionCommand {
    const command = this.#store.getCommand(commandId)
    if (!command) throw invalid(`Android command not found: ${commandId}`)
    return command
  }
}

function settledOutcome(command: AndroidCompanionCommand): AndroidCommandBridgeOutcome | null {
  if (command.status === 'succeeded' && command.response) {
    return { outcome: 'succeeded', command, output: command.response }
  }
  if (command.status === 'failed') return {
    outcome: 'permanent_failure', command, errorCode: command.errorCode ?? 'ANDROID_COMMAND_FAILED', safeToRetry: false,
  }
  if (command.status === 'waiting_user') return {
    outcome: 'waiting_user', command, errorCode: command.errorCode ?? 'ANDROID_TAKEOVER_REQUIRED', safeToRetry: false,
  }
  if (command.status === 'cancelled') return {
    outcome: 'cancelled', command, errorCode: 'ANDROID_COMMAND_CANCELLED', safeToRetry: false,
  }
  return null
}

function transitionIfActive(
  store: AndroidCompanionStore,
  command: AndroidCompanionCommand,
  status: Extract<AndroidCommandStatus, 'failed' | 'unknown'>,
  errorCode: string,
): AndroidCompanionCommand {
  if (['succeeded', 'failed', 'cancelled'].includes(command.status)) return command
  if (command.status === 'waiting_user' && status === 'unknown') return command
  return store.transitionCommand({ id: command.id, expectedVersion: command.version, status, errorCode })
}

function sameTerminalResult(
  command: AndroidCompanionCommand,
  status: string,
  result: Record<string, unknown> | null,
  errorCode: string | null,
): boolean {
  return command.status === status && isDeepStrictEqual(command.response, result)
    && command.errorCode === errorCode
}

function acknowledgement(message: AndroidCompanionGatewayMessage, commandId: string): AndroidCompanionGatewayReply {
  return {
    messageType: 'ack', bindingId: message.bindingId,
    payload: { acknowledgedSequence: message.sequence, commandId },
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    descriptor => descriptor.enumerable && !descriptor.get && !descriptor.set && 'value' in descriptor,
  )
}

function requirePlainResult(value: unknown): Record<string, unknown> {
  if (!plainRecord(value)) throw invalid('Android command result must be a plain object')
  return value
}

function exactKeys(value: object, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function data(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function dataString(value: Record<string, unknown>, key: string): string {
  const item = data(value, key)
  if (typeof item !== 'string' || item.length < 1 || item.length > 200) throw invalid(`Android command ${key} is invalid`)
  return item
}

function dataPositiveInteger(value: Record<string, unknown>, key: string): number {
  const item = data(value, key)
  if (!Number.isSafeInteger(item) || Number(item) < 1) throw invalid(`Android command ${key} is invalid`)
  return Number(item)
}

function dataErrorCode(value: Record<string, unknown>, key: string): string {
  const item = dataString(value, key)
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(item)) throw invalid(`Android command ${key} is invalid`)
  return item
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_RESULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 120_000) {
    throw invalid('Android command result timeout is invalid')
  }
  return timeout
}

function invalid(message: string): AndroidCompanionValidationError {
  return new AndroidCompanionValidationError(message)
}
