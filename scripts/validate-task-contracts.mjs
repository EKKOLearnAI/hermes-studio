#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function reject(message) {
  console.error(`task contract ledger rejected: ${message}`)
  process.exitCode = 1
}

const ledgerPath = resolve(process.argv[2] || 'docs/harness/task-contracts.json')
let ledger
try {
  ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
} catch (error) {
  console.error(`task contract ledger rejected: cannot read ${ledgerPath}: ${error.message}`)
  process.exit(1)
}

if (ledger.version !== 1) reject('version must be 1')
if (!Array.isArray(ledger.directions)) reject('directions must be an array')

const directionKeys = new Set()
for (const direction of ledger.directions || []) {
  const label = direction?.key || '(missing key)'
  if (typeof direction?.key !== 'string' || !direction.key.trim()) reject('every direction requires a stable key')
  if (directionKeys.has(direction.key)) reject(`duplicate direction key ${direction.key}`)
  directionKeys.add(direction.key)

  if (!['active', 'stopped', 'accepted'].includes(direction.status)) reject(`${label}: invalid direction status`)
  if (!Number.isInteger(direction.maxTotalReworks) || direction.maxTotalReworks < 0) {
    reject(`${label}: maxTotalReworks must be a non-negative integer`)
  }
  if (!Array.isArray(direction.methods) || direction.methods.length === 0) {
    reject(`${label}: methods must be a non-empty array`)
    continue
  }

  const methodIds = new Set()
  const issueNumbers = new Set()
  let totalReworks = 0
  for (const method of direction.methods) {
    if (typeof method?.id !== 'string' || !method.id.trim()) {
      reject(`${label}: every method requires an id`)
      continue
    }
    if (methodIds.has(method.id)) reject(`${label}: successor reuses validation method ${method.id}`)
    methodIds.add(method.id)
    if (!['active', 'stopped', 'accepted'].includes(method.status)) reject(`${label}/${method.id}: invalid status`)
    if (!Number.isInteger(method.reworks) || method.reworks < 0) reject(`${label}/${method.id}: reworks must be a non-negative integer`)
    totalReworks += Number.isInteger(method.reworks) ? method.reworks : 0
    if (!Array.isArray(method.issues) || method.issues.length === 0) reject(`${label}/${method.id}: issues must be non-empty`)
    for (const issue of method.issues || []) {
      if (!Number.isInteger(issue) || issue <= 0) reject(`${label}/${method.id}: invalid issue number`)
      if (issueNumbers.has(issue)) reject(`${label}: issue ${issue} appears in more than one method`)
      issueNumbers.add(issue)
    }
  }

  if (totalReworks > direction.maxTotalReworks) {
    reject(`${label}: ${totalReworks} reworks exceeds shared rework budget ${direction.maxTotalReworks}`)
  }

  const restarts = Array.isArray(direction.restarts) ? direction.restarts : []
  for (let index = 1; index < direction.methods.length; index += 1) {
    const fromMethod = direction.methods[index - 1].id
    const toMethod = direction.methods[index].id
    const restart = restarts.find(item => item?.fromMethod === fromMethod && item?.toMethod === toMethod)
    if (!restart) {
      reject(`${label}: missing explicit method-change restart ${fromMethod} -> ${toMethod}`)
      continue
    }
    if (typeof restart.authorizedBy !== 'string' || !restart.authorizedBy.trim()) {
      reject(`${label}: restart ${fromMethod} -> ${toMethod} requires authorizedBy`)
    }
    if (typeof restart.reason !== 'string' || restart.reason.trim().length < 12) {
      reject(`${label}: restart ${fromMethod} -> ${toMethod} requires a concrete reason`)
    }
  }

  const activeMethods = direction.methods.filter(method => method.status === 'active')
  if (activeMethods.length > 1) reject(`${label}: only one validation method may be active`)
  if (direction.status === 'active' && activeMethods.length !== 1) reject(`${label}: active direction requires exactly one active method`)
  if (direction.status !== 'active' && activeMethods.length !== 0) reject(`${label}: non-active direction cannot contain an active method`)
}

if (process.exitCode) process.exit(process.exitCode)
console.log(`task contract ledger valid: ${ledger.directions.length} direction(s)`)
