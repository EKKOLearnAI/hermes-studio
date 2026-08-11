#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) die(`${name} requires a value`)
  return value
}

const baseArg = argument('--base')
const remote = argument('--remote', 'origin')
const branch = argument('--branch')
const ledgerPath = argument('--ledger')
const problemKey = argument('--problem-key')
const issueArg = argument('--issue')
const methodId = argument('--method')
const json = process.argv.includes('--json')

if (!baseArg) die('--base is required')
if (!branch) die('--branch is required')
if (!ledgerPath) die('--ledger is required')
if (!problemKey) die('--problem-key is required')
if (!issueArg || !/^\d+$/.test(issueArg)) die('--issue must be a positive integer')
if (!methodId) die('--method is required')
if (!/^[A-Za-z0-9._/-]+$/.test(remote)) die('remote contains unsupported characters')
if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
  die('branch is not a safe Git ref name')
}

try {
  const issue = Number(issueArg)
  const ledger = JSON.parse(readFileSync(resolve(process.cwd(), ledgerPath), 'utf8'))
  const direction = ledger?.directions?.find(item => item?.key === problemKey)
  if (!direction) die(`problem key ${problemKey} is not registered in the task contract ledger`)
  if (direction.status !== 'active') die(`problem key ${problemKey} is not active`)
  const method = direction.methods?.find(item => item?.id === methodId)
  if (!method || method.status !== 'active' || !method.issues?.includes(issue)) {
    die(`issue ${issue} is not registered under active method ${problemKey}/${methodId}`)
  }

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
  if (head !== fetchedHead) {
    die(`local HEAD ${head} does not match freshly fetched remote head ${fetchedHead}`)
  }
  if (head !== remoteTrackingHead) {
    die(`local HEAD ${head} does not match remote-tracking head ${remoteTrackingHead}`)
  }

  const patch = git(['diff', base, head], { encoding: 'buffer' })
  const patchSha256 = createHash('sha256').update(patch).digest('hex')
  const evidence = {
    base,
    head,
    tree,
    patchSha256,
    remote,
    branch,
    fetchedHead,
    remoteHead: fetchedHead,
    remoteTrackingHead,
    worktree: 'clean',
    contract: { problemKey, issue, method: methodId },
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
  } else {
    for (const [key, value] of Object.entries(evidence)) console.log(`${key}=${value}`)
  }
} catch (error) {
  die(error instanceof Error ? error.message : String(error))
}
