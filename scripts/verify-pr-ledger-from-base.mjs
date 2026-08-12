#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const LEDGER_PATH = 'docs/harness/task-contracts.json'
const VALIDATOR_PATH = 'scripts/validate-task-contracts.mjs'

function die(message) {
  console.error(`trusted PR ledger gate rejected: ${message}`)
  process.exit(1)
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    }).trim()
  } catch (error) {
    throw new Error(error?.stderr?.toString().trim() || `git ${args.join(' ')} failed`)
  }
}

function gitRaw(args) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    })
  } catch (error) {
    throw new Error(error?.stderr?.toString().trim() || `git ${args.join(' ')} failed`)
  }
}

function parseArguments() {
  const valued = new Set(['--base', '--head', '--remote', '--branch', '--fetch-ref'])
  const values = new Map()
  let json = false
  for (let index = 2; index < process.argv.length; index += 1) {
    const name = process.argv[index]
    if (name === '--json') {
      json = true
      continue
    }
    if (!valued.has(name)) die(`${name} is unsupported`)
    const value = process.argv[++index]
    if (!value || value.startsWith('--')) die(`${name} requires a value`)
    if (values.has(name)) die(`${name} may only be provided once`)
    values.set(name, value)
  }
  return { values, json }
}

function validateRef(value, label) {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('-') || value.includes('..')) {
    die(`${label} is not a safe Git ref`)
  }
}

const { values, json } = parseArguments()
const baseArg = values.get('--base')
const expectedHead = values.get('--head')
const remote = values.get('--remote') ?? 'origin'
const branch = values.get('--branch')
const fetchRef = values.get('--fetch-ref') ?? (branch ? `refs/heads/${branch}` : undefined)
if (!baseArg || !expectedHead || !branch) die('--base, --head, and --branch are required')
validateRef(remote, 'remote')
validateRef(branch, 'branch')
validateRef(fetchRef, 'fetch ref')

try {
  const checkout = git(['rev-parse', 'HEAD^{commit}'])
  const base = git(['rev-parse', '--verify', `${baseArg}^{commit}`])
  if (checkout !== base) die(`trusted checkout ${checkout} does not match requested Base ${base}`)

  const validator = resolve(process.cwd(), VALIDATOR_PATH)
  const baseValidator = gitRaw(['show', `${base}:${VALIDATOR_PATH}`])
  const checkedOutValidator = createHash('sha256').update(readFileSync(validator)).digest('hex')
  const committedValidator = createHash('sha256').update(baseValidator).digest('hex')
  if (checkedOutValidator !== committedValidator) die('checked-out validator does not match trusted Base')

  const trackingRef = `refs/remotes/${remote}/${branch}`
  git(['fetch', '--no-tags', remote, `+${fetchRef}:${trackingRef}`])
  const fetchedHead = git(['rev-parse', 'FETCH_HEAD^{commit}'])
  if (fetchedHead !== expectedHead) die(`fetched candidate ${fetchedHead} does not match expected HEAD ${expectedHead}`)
  git(['merge-base', '--is-ancestor', base, fetchedHead])

  const trustedLedger = gitRaw(['show', `${base}:${LEDGER_PATH}`])
  const candidateLedger = gitRaw(['show', `${fetchedHead}:${LEDGER_PATH}`])
  const root = mkdtempSync(join(tmpdir(), 'hermes-trusted-pr-ledger-'))
  try {
    const previousPath = join(root, 'trusted.json')
    const candidatePath = join(root, 'candidate.json')
    writeFileSync(previousPath, trustedLedger)
    writeFileSync(candidatePath, candidateLedger)
    execFileSync(process.execPath, [validator, '--previous', previousPath, candidatePath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const evidence = {
    gate: 'trusted-base-ledger-transition',
    base,
    head: fetchedHead,
    remote,
    branch,
    fetchRef,
    validatorPath: VALIDATOR_PATH,
    validatorSha256: committedValidator,
    ledgerPath: LEDGER_PATH,
    trustedLedgerSha256: createHash('sha256').update(trustedLedger).digest('hex'),
    candidateLedgerSha256: createHash('sha256').update(candidateLedger).digest('hex'),
    transition: 'append-only-valid',
  }
  process.stdout.write(json ? `${JSON.stringify(evidence, null, 2)}\n` : `${JSON.stringify(evidence)}\n`)
} catch (error) {
  die(error instanceof Error ? error.message : String(error))
}
