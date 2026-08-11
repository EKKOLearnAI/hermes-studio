#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

function loadLedger(path) {
  const resolved = resolve(path)
  try {
    return { path: resolved, value: JSON.parse(readFileSync(resolved, 'utf8')) }
  } catch (error) {
    throw new Error(`cannot read ${resolved}: ${error.message}`)
  }
}

function validateLedger(ledger, label) {
  const errors = []
  const reject = message => errors.push(`${label}: ${message}`)

  if (ledger?.version !== 1) reject('version must be 1')
  if (!Array.isArray(ledger?.directions)) {
    reject('directions must be an array')
    return errors
  }

  const directionKeys = new Set()
  for (const direction of ledger.directions) {
    const directionLabel = direction?.key || '(missing key)'
    if (typeof direction?.key !== 'string' || !direction.key.trim()) reject('every direction requires a stable key')
    if (directionKeys.has(direction.key)) reject(`duplicate direction key ${direction.key}`)
    directionKeys.add(direction.key)

    if (!['active', 'stopped', 'accepted'].includes(direction.status)) reject(`${directionLabel}: invalid direction status`)
    if (!Number.isInteger(direction.maxTotalReworks) || direction.maxTotalReworks < 0) {
      reject(`${directionLabel}: maxTotalReworks must be a non-negative integer`)
    }
    if (!Array.isArray(direction.methods) || direction.methods.length === 0) {
      reject(`${directionLabel}: methods must be a non-empty array`)
      continue
    }

    const methodIds = new Set()
    let totalReworks = 0
    for (const method of direction.methods) {
      if (typeof method?.id !== 'string' || !method.id.trim()) {
        reject(`${directionLabel}: every method requires an id`)
        continue
      }
      if (methodIds.has(method.id)) reject(`${directionLabel}: successor reuses validation method ${method.id}`)
      methodIds.add(method.id)
      if (!['active', 'stopped', 'accepted'].includes(method.status)) reject(`${directionLabel}/${method.id}: invalid status`)
      if (!Number.isInteger(method.reworks) || method.reworks < 0) {
        reject(`${directionLabel}/${method.id}: reworks must be a non-negative integer`)
      }
      totalReworks += Number.isInteger(method.reworks) ? method.reworks : 0
      if (!Array.isArray(method.issues) || method.issues.length === 0) reject(`${directionLabel}/${method.id}: issues must be non-empty`)
      const methodIssues = new Set()
      for (const issue of method.issues || []) {
        if (!Number.isInteger(issue) || issue <= 0) reject(`${directionLabel}/${method.id}: invalid issue number`)
        if (methodIssues.has(issue)) reject(`${directionLabel}/${method.id}: duplicate issue ${issue}`)
        methodIssues.add(issue)
      }
    }

    if (totalReworks > direction.maxTotalReworks) {
      reject(`${directionLabel}: ${totalReworks} reworks exceeds shared rework budget ${direction.maxTotalReworks}`)
    }

    const restarts = Array.isArray(direction.restarts) ? direction.restarts : []
    if (restarts.length !== direction.methods.length - 1) {
      reject(`${directionLabel}: restarts must contain exactly one ordered authorization per method change`)
    }
    for (let index = 1; index < direction.methods.length; index += 1) {
      const fromMethod = direction.methods[index - 1].id
      const toMethod = direction.methods[index].id
      const restart = restarts[index - 1]
      if (restart?.fromMethod !== fromMethod || restart?.toMethod !== toMethod) {
        reject(`${directionLabel}: missing explicit method-change restart ${fromMethod} -> ${toMethod}`)
        continue
      }
      if (typeof restart.authorizedBy !== 'string' || !restart.authorizedBy.trim()) {
        reject(`${directionLabel}: restart ${fromMethod} -> ${toMethod} requires authorizedBy`)
      }
      if (typeof restart.reason !== 'string' || restart.reason.trim().length < 12) {
        reject(`${directionLabel}: restart ${fromMethod} -> ${toMethod} requires a concrete reason`)
      }
      if (restart.budgetChange !== undefined) {
        const change = restart.budgetChange
        if (!Number.isInteger(change?.from) || !Number.isInteger(change?.to) || change.to <= change.from) {
          reject(`${directionLabel}: restart ${fromMethod} -> ${toMethod} has an invalid budgetChange`)
        }
      }
    }

    const activeMethods = direction.methods.filter(method => method.status === 'active')
    if (activeMethods.length > 1) reject(`${directionLabel}: only one validation method may be active`)
    if (direction.status === 'active' && activeMethods.length !== 1) {
      reject(`${directionLabel}: active direction requires exactly one active method`)
    }
    if (direction.status !== 'active' && activeMethods.length !== 0) {
      reject(`${directionLabel}: non-active direction cannot contain an active method`)
    }
  }

  return errors
}

function validateTransition(previous, current) {
  const errors = []
  const reject = message => errors.push(`transition: ${message}`)

  if (current.directions.length < previous.directions.length) reject('historical directions cannot be deleted')

  for (let directionIndex = 0; directionIndex < previous.directions.length; directionIndex += 1) {
    const before = previous.directions[directionIndex]
    const after = current.directions[directionIndex]
    if (!after || after.key !== before.key) {
      reject(`direction ${before.key} cannot be deleted, renamed, or reordered`)
      continue
    }
    if (before.status === 'accepted' && after.status !== 'accepted') {
      reject(`${before.key}: accepted direction cannot be reopened`)
    }
    if (after.methods.length < before.methods.length) reject(`${before.key}: historical methods cannot be deleted`)
    if (after.restarts.length < before.restarts.length) reject(`${before.key}: historical restart authorizations cannot be deleted`)

    for (let index = 0; index < before.methods.length; index += 1) {
      const oldMethod = before.methods[index]
      const newMethod = after.methods[index]
      if (!newMethod || newMethod.id !== oldMethod.id) {
        reject(`${before.key}/${oldMethod.id}: historical method cannot be deleted, renamed, or reordered`)
        continue
      }
      if (!isDeepStrictEqual(newMethod.issues, oldMethod.issues)) {
        reject(`${before.key}/${oldMethod.id}: historical Issue bindings cannot be rewritten`)
      }
      if (newMethod.reworks < oldMethod.reworks) {
        reject(`${before.key}/${oldMethod.id}: reworks cannot decrease`)
      }
      if (oldMethod.status === 'stopped' && newMethod.status !== 'stopped') {
        reject(`${before.key}/${oldMethod.id}: stopped method cannot be reactivated`)
      }
      if (oldMethod.status === 'accepted' && newMethod.status !== 'accepted') {
        reject(`${before.key}/${oldMethod.id}: accepted method cannot be changed`)
      }
    }

    for (let index = 0; index < before.restarts.length; index += 1) {
      if (!isDeepStrictEqual(after.restarts[index], before.restarts[index])) {
        reject(`${before.key}: historical restart authorization ${index + 1} cannot be rewritten or reordered`)
      }
    }

    if (after.maxTotalReworks < before.maxTotalReworks) {
      reject(`${before.key}: shared rework budget cannot decrease`)
    }
    if (after.maxTotalReworks > before.maxTotalReworks) {
      const appendedRestarts = after.restarts.slice(before.restarts.length)
      const authorizedChange = appendedRestarts.some(restart =>
        restart?.budgetChange?.from === before.maxTotalReworks
        && restart?.budgetChange?.to === after.maxTotalReworks
        && typeof restart.authorizedBy === 'string'
        && restart.authorizedBy.trim()
        && typeof restart.reason === 'string'
        && restart.reason.trim().length >= 12)
      if (!authorizedChange) {
        reject(`${before.key}: shared rework budget cannot expand without an appended authorized budgetChange`)
      }
    }
  }

  return errors
}

const args = process.argv.slice(2)
let previousPath
if (args[0] === '--previous') {
  previousPath = args[1]
  args.splice(0, 2)
}
if (args.length !== 1 || !args[0]) {
  console.error('task contract ledger rejected: usage: validate-task-contracts.mjs [--previous <trusted-ledger>] <candidate-ledger>')
  process.exit(1)
}

try {
  const current = loadLedger(args[0])
  const errors = validateLedger(current.value, 'candidate')
  if (previousPath) {
    const previous = loadLedger(previousPath)
    errors.push(...validateLedger(previous.value, 'trusted'))
    if (errors.length === 0) errors.push(...validateTransition(previous.value, current.value))
  }
  if (errors.length) {
    for (const error of errors) console.error(`task contract ledger rejected: ${error}`)
    process.exit(1)
  }
  console.log(`task contract ledger valid: ${current.value.directions.length} direction(s)`)
} catch (error) {
  console.error(`task contract ledger rejected: ${error.message}`)
  process.exit(1)
}
