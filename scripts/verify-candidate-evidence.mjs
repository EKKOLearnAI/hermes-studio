#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CANONICAL_LEDGER_PATH = 'docs/harness/task-contracts.json'
const BOOTSTRAP_ANCHOR = 'de18ac3a86b73e6f4e062b13635e37685694e3a0'
const TRUSTED_BASE_REMOTE = 'origin'
const TRUSTED_BASE_BRANCH = 'main'

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

function validateLedgerTransition(trustedContent, candidateContent) {
  const validator = resolve(new URL('.', import.meta.url).pathname, 'validate-task-contracts.mjs')
  const root = mkdtempSync(join(tmpdir(), 'hermes-ledger-transition-'))
  try {
    const trustedPath = join(root, 'trusted.json')
    const candidatePath = join(root, 'candidate.json')
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

  let trustedLedgerCommit = base
  let ledgerTrustSource = 'protected-base'
  if (!commitContains(base, CANONICAL_LEDGER_PATH)) {
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
  if (!commitContains(head, CANONICAL_LEDGER_PATH)) die(`HEAD does not contain canonical ledger ${CANONICAL_LEDGER_PATH}`)

  const trustedLedger = git(['show', `${trustedLedgerCommit}:${CANONICAL_LEDGER_PATH}`])
  const candidateLedger = git(['show', `${head}:${CANONICAL_LEDGER_PATH}`])
  validateLedgerTransition(trustedLedger, candidateLedger)
  const ledger = JSON.parse(candidateLedger)
  const direction = ledger?.directions?.find(item => item?.key === problemKey)
  if (!direction) die(`problem key ${problemKey} is not registered in the canonical ledger`)
  if (direction.status !== 'active') die(`problem key ${problemKey} is not active`)
  const method = direction.methods?.find(item => item?.id === methodId)
  if (!method || method.status !== 'active' || !method.issues?.includes(issue)) {
    die(`issue ${issue} is not registered under active method ${problemKey}/${methodId}`)
  }

  const patch = git(['diff', base, head], { encoding: 'buffer' })
  const patchSha256 = createHash('sha256').update(patch).digest('hex')
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
    ledger: {
      path: CANONICAL_LEDGER_PATH,
      trustedCommit: trustedLedgerCommit,
      trustSource: ledgerTrustSource,
      trustedSha256: createHash('sha256').update(trustedLedger).digest('hex'),
      candidateSha256: createHash('sha256').update(candidateLedger).digest('hex'),
      transition: 'append-only-valid',
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
} catch (error) {
  die(error instanceof Error ? error.message : String(error))
}
