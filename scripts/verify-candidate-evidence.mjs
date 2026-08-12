#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CANONICAL_LEDGER_PATH = 'docs/harness/task-contracts.json'
const VALIDATOR_PATH = 'scripts/validate-task-contracts.mjs'
const BOOTSTRAP_ANCHOR = 'de18ac3a86b73e6f4e062b13635e37685694e3a0'
const TRUSTED_BASE_REMOTE = 'origin'
const TRUSTED_BASE_BRANCH = 'main'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CANONICAL_PATCH_SCRIPT = join(SCRIPT_DIR, 'canonical-git-patch.mjs')

function die(message) {
  console.error(`candidate evidence rejected: ${message}`)
  process.exit(1)
}

function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: options.encoding ?? 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 100 * 1024 * 1024,
    })
  } catch (error) {
    const detail = error?.stderr?.toString().trim()
    throw new Error(detail || `git ${args.join(' ')} failed`)
  }
}

function parseArguments() {
  const valued = new Set(['--base', '--remote', '--branch', '--problem-key', '--issue', '--method'])
  const flags = new Set(['--json'])
  const values = new Map()
  const enabled = new Set()
  for (let index = 2; index < process.argv.length; index += 1) {
    const name = process.argv[index]
    if (flags.has(name)) {
      enabled.add(name)
      continue
    }
    if (!valued.has(name)) die(`${name.startsWith('--') ? name : `argument ${name}`} is unsupported`)
    const value = process.argv[index + 1]
    if (!value || value.startsWith('--')) die(`${name} requires a value`)
    if (values.has(name)) die(`${name} may only be provided once`)
    values.set(name, value)
    index += 1
  }
  return {
    value: (name, fallback) => values.get(name) ?? fallback,
    has: name => enabled.has(name),
  }
}

function safeGitName(value, label) {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('-') || value.includes('..')) {
    die(`${label} is not a safe Git ref name`)
  }
}

function commitContains(commit, path) {
  try {
    git(['cat-file', '-e', `${commit}:${path}`])
    return true
  } catch {
    return false
  }
}

function validateLedgerTransition(validatorContent, trustedContent, candidateContent) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-ledger-transition-'))
  try {
    const validator = join(root, 'trusted-validator.mjs')
    const trustedPath = join(root, 'trusted.json')
    const candidatePath = join(root, 'candidate.json')
    writeFileSync(validator, validatorContent)
    writeFileSync(trustedPath, trustedContent)
    writeFileSync(candidatePath, candidateContent)
    execFileSync(process.execPath, [validator, '--previous', trustedPath, candidatePath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message
    die(`canonical ledger transition is invalid: ${detail}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function canonicalPatch(base, head) {
  const command = [
    process.execPath,
    CANONICAL_PATCH_SCRIPT,
    base,
    head,
  ]
  return {
    command,
    bytes: execFileSync(command[0], command.slice(1), {
      cwd: process.cwd(),
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 100 * 1024 * 1024,
    }),
  }
}

const args = parseArguments()
const baseArg = args.value('--base')
const remote = args.value('--remote', 'origin')
const branch = args.value('--branch')
const problemKey = args.value('--problem-key')
const issueArg = args.value('--issue')
const methodId = args.value('--method')

if (!baseArg) die('--base is required')
if (!branch) die('--branch is required')
if (!problemKey) die('--problem-key is required')
if (!issueArg || !/^\d+$/.test(issueArg) || Number(issueArg) <= 0) die('--issue must be a positive integer')
if (!methodId) die('--method is required')
safeGitName(remote, 'remote')
safeGitName(branch, 'branch')

try {
  const issue = Number(issueArg)
  const inside = git(['rev-parse', '--is-inside-work-tree']).trim()
  if (inside !== 'true') die('current directory is not a Git worktree')

  const status = git(['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.trim()) die('worktree is not clean')

  const currentBranch = git(['branch', '--show-current']).trim()
  if (currentBranch !== branch) {
    die(`current branch ${currentBranch || '(detached)'} does not match requested branch ${branch}`)
  }

  const base = git(['rev-parse', '--verify', `${baseArg}^{commit}`]).trim()
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  const tree = git(['rev-parse', '--verify', 'HEAD^{tree}']).trim()

  const baseTrackingRef = `refs/remotes/${TRUSTED_BASE_REMOTE}/${TRUSTED_BASE_BRANCH}`
  try {
    git(['fetch', '--no-tags', TRUSTED_BASE_REMOTE, `+refs/heads/${TRUSTED_BASE_BRANCH}:${baseTrackingRef}`])
  } catch {
    die(`unable to fetch trusted base branch ${TRUSTED_BASE_REMOTE}/${TRUSTED_BASE_BRANCH}`)
  }
  const fetchedBase = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).trim()
  if (base !== fetchedBase) die(`base ${base} does not match freshly fetched trusted base ${fetchedBase}`)
  try {
    git(['merge-base', '--is-ancestor', base, head])
  } catch {
    die(`base ${base} is not an ancestor of HEAD ${head}`)
  }

  const trackingRef = `refs/remotes/${remote}/${branch}`
  try {
    git(['fetch', '--no-tags', remote, `+refs/heads/${branch}:${trackingRef}`])
  } catch {
    die(`unable to fetch remote branch ${remote}/${branch}`)
  }
  const fetchedHead = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).trim()
  const remoteTrackingHead = git(['rev-parse', '--verify', `${trackingRef}^{commit}`]).trim()
  if (head !== fetchedHead) die(`local HEAD ${head} does not match freshly fetched remote head ${fetchedHead}`)
  if (head !== remoteTrackingHead) die(`local HEAD ${head} does not match remote-tracking head ${remoteTrackingHead}`)

  const baseHasLedger = commitContains(base, CANONICAL_LEDGER_PATH)
  const baseHasValidator = commitContains(base, VALIDATOR_PATH)
  const authoritative = baseHasLedger && baseHasValidator
  let trustedLedgerCommit = base
  let ledgerTrustSource = 'protected-base'
  if (!authoritative) {
    if (baseHasLedger) {
      ledgerTrustSource = 'untrusted-bootstrap-base'
    } else {
      trustedLedgerCommit = BOOTSTRAP_ANCHOR
      ledgerTrustSource = 'frozen-bootstrap-anchor'
      try {
        git(['merge-base', '--is-ancestor', BOOTSTRAP_ANCHOR, head])
      } catch {
        die(`frozen bootstrap anchor ${BOOTSTRAP_ANCHOR} is not an ancestor of HEAD ${head}`)
      }
      if (!commitContains(BOOTSTRAP_ANCHOR, CANONICAL_LEDGER_PATH)) {
        die(`frozen bootstrap anchor ${BOOTSTRAP_ANCHOR} does not contain the canonical ledger`)
      }
    }
  }
  if (!commitContains(head, CANONICAL_LEDGER_PATH)) die(`HEAD does not contain canonical ledger ${CANONICAL_LEDGER_PATH}`)

  const trustedLedger = git(['show', `${trustedLedgerCommit}:${CANONICAL_LEDGER_PATH}`])
  const candidateLedger = git(['show', `${head}:${CANONICAL_LEDGER_PATH}`])
  if (authoritative) {
    const trustedValidator = git(['show', `${base}:${VALIDATOR_PATH}`])
    validateLedgerTransition(trustedValidator, trustedLedger, candidateLedger)
  }
  const ledger = JSON.parse(candidateLedger)
  const direction = ledger?.directions?.find(item => item?.key === problemKey)
  if (!direction) die(`problem key ${problemKey} is not registered in the canonical ledger`)
  if (direction.status !== 'active') die(`problem key ${problemKey} is not active`)
  const method = direction.methods?.find(item => item?.id === methodId)
  if (!method || method.status !== 'active' || !method.issues?.includes(issue)) {
    die(`issue ${issue} is not registered under active method ${problemKey}/${methodId}`)
  }

  const patch = canonicalPatch(base, head)
  const patchSha256 = createHash('sha256').update(patch.bytes).digest('hex')
  const evidence = {
    base,
    head,
    tree,
    patchSha256,
    baseRemote: TRUSTED_BASE_REMOTE,
    baseBranch: TRUSTED_BASE_BRANCH,
    fetchedBase,
    remote,
    branch,
    fetchedHead,
    remoteHead: fetchedHead,
    remoteTrackingHead,
    worktree: 'clean',
    patchCommand: patch.command,
    patchIsolation: {
      commandOwner: 'scripts/canonical-git-patch.mjs',
      attributes: 'isolated recursive info/attributes unsets diff-affecting repository attributes',
      globalAttributes: 'disabled',
      systemAttributes: 'disabled',
      repositoryConfig: 'isolated bare repository',
    },
    gate: authoritative
      ? { status: 'trusted-base-validated', authoritative: true }
      : {
          status: 'bootstrap-review-required',
          authoritative: false,
          reason: 'trusted Base does not contain the ledger validator',
        },
    ledger: {
      path: CANONICAL_LEDGER_PATH,
      trustedCommit: trustedLedgerCommit,
      trustSource: ledgerTrustSource,
      trustedSha256: createHash('sha256').update(trustedLedger).digest('hex'),
      candidateSha256: createHash('sha256').update(candidateLedger).digest('hex'),
      transition: authoritative ? 'append-only-valid' : 'not-authoritatively-validated',
    },
    contract: { problemKey, issue, method: methodId },
  }

  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
  } else {
    for (const [key, value] of Object.entries(evidence)) {
      console.log(`${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    }
  }
  if (!authoritative) process.exit(2)
} catch (error) {
  die(error instanceof Error ? error.message : String(error))
}
