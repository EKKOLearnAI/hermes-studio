import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../..')
const candidateScript = join(repoRoot, 'scripts/verify-candidate-evidence.mjs')
const contractScript = join(repoRoot, 'scripts/validate-task-contracts.mjs')
const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeGitFixture() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-engineering-gate-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const work = join(root, 'work')

  mkdirSync(seed)
  git(root, ['init', '--bare', remote])
  git(seed, ['init', '-b', 'main'])
  git(seed, ['config', 'user.name', 'Gate Test'])
  git(seed, ['config', 'user.email', 'gate@example.test'])
  writeFileSync(join(seed, 'README.md'), 'base\n')
  git(seed, ['add', 'README.md'])
  git(seed, ['commit', '-m', 'base'])
  git(seed, ['remote', 'add', 'origin', remote])
  git(seed, ['push', '-u', 'origin', 'main'])
  git(root, ['clone', '--branch', 'main', remote, work])
  git(work, ['config', 'user.name', 'Gate Test'])
  git(work, ['config', 'user.email', 'gate@example.test'])
  git(work, ['checkout', '-b', 'fix/evidence'])
  const base = git(work, ['rev-parse', 'HEAD'])
  writeFileSync(join(work, 'change.txt'), 'candidate\n')
  git(work, ['add', 'change.txt'])
  git(work, ['commit', '-m', 'candidate'])
  git(work, ['push', '-u', 'origin', 'fix/evidence'])
  const ledger = writeLedger(root, {
    version: 1,
    directions: [{
      key: 'fixture-direction',
      status: 'active',
      maxTotalReworks: 1,
      methods: [{ id: 'fixture-method', status: 'active', issues: [100], reworks: 0 }],
      restarts: [],
    }],
  })
  return { work, base, remote, ledger }
}

function runCandidate(work: string, base: string, ledger: string, branch = 'fix/evidence', issue = '100') {
  return spawnSync(process.execPath, [
    candidateScript,
    '--base', base,
    '--remote', 'origin',
    '--branch', branch,
    '--ledger', ledger,
    '--problem-key', 'fixture-direction',
    '--issue', issue,
    '--method', 'fixture-method',
    '--json',
  ], {
    cwd: work,
    encoding: 'utf8',
  })
}

function writeLedger(root: string, ledger: unknown): string {
  const path = join(root, 'ledger.json')
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`)
  return path
}

function validLedger() {
  return {
    version: 1,
    directions: [{
      key: 'durable-handoff',
      status: 'stopped',
      maxTotalReworks: 2,
      methods: [
        { id: 'design-review', status: 'stopped', issues: [2482], reworks: 1 },
        { id: 'example-state-model', status: 'stopped', issues: [2488], reworks: 1 },
      ],
      restarts: [{
        fromMethod: 'design-review',
        toMethod: 'example-state-model',
        authorizedBy: 'product-owner',
        reason: 'replace prose review with executable state model',
      }],
    }],
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('candidate evidence gate', () => {
  it('emits machine-derived identity only after a fresh remote round-trip', () => {
    const { work, base, ledger } = makeGitFixture()
    const result = runCandidate(work, base, ledger)

    expect(result.status, result.stderr).toBe(0)
    const evidence = JSON.parse(result.stdout)
    expect(evidence.base).toBe(base)
    expect(evidence.head).toBe(git(work, ['rev-parse', 'HEAD']))
    expect(evidence.tree).toBe(git(work, ['rev-parse', 'HEAD^{tree}']))
    expect(evidence.remoteHead).toBe(evidence.head)
    expect(evidence.remoteTrackingHead).toBe(evidence.head)
    const patch = execFileSync('git', ['diff', base, evidence.head], { cwd: work })
    expect(evidence.patchSha256).toBe(createHash('sha256').update(patch).digest('hex'))
    expect(evidence.worktree).toBe('clean')
    expect(evidence.contract).toEqual({ problemKey: 'fixture-direction', issue: 100, method: 'fixture-method' })
  })

  it('fails closed when the candidate commit was not pushed', () => {
    const { work, base, ledger } = makeGitFixture()
    writeFileSync(join(work, 'local-only.txt'), 'not pushed\n')
    git(work, ['add', 'local-only.txt'])
    git(work, ['commit', '-m', 'local only'])

    const result = runCandidate(work, base, ledger)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not match freshly fetched remote head')
  })

  it('fails closed for dirty worktrees, wrong branches, and missing remote branches', () => {
    const { work, base, ledger } = makeGitFixture()
    writeFileSync(join(work, 'dirty.txt'), 'dirty\n')
    const dirty = runCandidate(work, base, ledger)
    expect(dirty.status).not.toBe(0)
    expect(dirty.stderr).toContain('worktree is not clean')

    rmSync(join(work, 'dirty.txt'))
    const wrong = runCandidate(work, base, ledger, 'fix/missing')
    expect(wrong.status).not.toBe(0)
    expect(wrong.stderr).toContain('does not match requested branch')

    git(work, ['checkout', '-b', 'fix/missing'])
    const missing = runCandidate(work, base, ledger, 'fix/missing')
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('unable to fetch remote branch')
  })

  it('fails closed when a candidate Issue is not registered under the active problem and method', () => {
    const { work, base, ledger } = makeGitFixture()
    const result = runCandidate(work, base, ledger, 'fix/evidence', '101')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('is not registered under active method')
  })
})

describe('task contract anti-loop gate', () => {
  it('accepts a stopped direction with an explicit method-change restart and exhausted shared budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-contract-gate-'))
    roots.push(root)
    const ledger = writeLedger(root, validLedger())
    const result = spawnSync(process.execPath, [contractScript, ledger], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
  })

  it('rejects cross-issue rework budget resets', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-contract-gate-'))
    roots.push(root)
    const data = validLedger()
    data.directions[0].methods.push({ id: 'third-issue-same-budget', status: 'active', issues: [2489], reworks: 1 })
    data.directions[0].status = 'active'
    const ledger = writeLedger(root, data)
    const result = spawnSync(process.execPath, [contractScript, ledger], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('exceeds shared rework budget')
  })

  it('rejects successor work that restarts a stopped validation method', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-contract-gate-'))
    roots.push(root)
    const data = validLedger()
    data.directions[0].maxTotalReworks = 3
    data.directions[0].methods.push({ id: 'example-state-model', status: 'active', issues: [2490], reworks: 0 })
    data.directions[0].status = 'active'
    const ledger = writeLedger(root, data)
    const result = spawnSync(process.execPath, [contractScript, ledger], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('reuses validation method')
  })
})
