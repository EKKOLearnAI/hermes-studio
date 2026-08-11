import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../..')
const candidateScript = join(repoRoot, 'scripts/verify-candidate-evidence.mjs')
const contractScript = join(repoRoot, 'scripts/validate-task-contracts.mjs')
const canonicalLedgerPath = 'docs/harness/task-contracts.json'
const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fixtureLedger(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    directions: [{
      key: 'fixture-direction',
      status: 'active',
      maxTotalReworks: 1,
      methods: [{ id: 'fixture-method', status: 'active', issues: [100], reworks: 0 }],
      restarts: [],
      ...overrides,
    }],
  }
}

function makeGitFixture(options: { ledger?: unknown, includeLedger?: boolean } = {}) {
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
  if (options.includeLedger !== false) {
    const ledgerPath = join(seed, canonicalLedgerPath)
    mkdirSync(dirname(ledgerPath), { recursive: true })
    writeFileSync(ledgerPath, `${JSON.stringify(options.ledger ?? fixtureLedger(), null, 2)}\n`)
  }
  git(seed, ['add', '.'])
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
  return { root, work, base, remote }
}

function runCandidate(
  work: string,
  base: string,
  options: { branch?: string, issue?: string, method?: string, extra?: string[] } = {},
) {
  return spawnSync(process.execPath, [
    candidateScript,
    '--base', base,
    '--remote', 'origin',
    '--branch', options.branch ?? 'fix/evidence',
    '--problem-key', 'fixture-direction',
    '--issue', options.issue ?? '100',
    '--method', options.method ?? 'fixture-method',
    '--json',
    ...(options.extra ?? []),
  ], {
    cwd: work,
    encoding: 'utf8',
  })
}

function candidateLedger(work: string): Record<string, any> {
  return JSON.parse(readFileSync(join(work, canonicalLedgerPath), 'utf8'))
}

function commitLedger(work: string, ledger: unknown, message = 'change ledger') {
  writeFileSync(join(work, canonicalLedgerPath), `${JSON.stringify(ledger, null, 2)}\n`)
  git(work, ['add', canonicalLedgerPath])
  git(work, ['commit', '-m', message])
  git(work, ['push', 'origin', 'HEAD'])
}

function writeLedger(root: string, ledger: unknown, name = 'ledger.json'): string {
  const path = join(root, name)
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`)
  return path
}

function validStoppedLedger() {
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
  it('emits machine-derived identity after trusted-base ledger validation and a fresh remote round-trip', () => {
    const { work, base } = makeGitFixture()
    const result = runCandidate(work, base)

    expect(result.status, result.stderr).toBe(0)
    const evidence = JSON.parse(result.stdout)
    expect(evidence.base).toBe(base)
    expect(evidence.fetchedBase).toBe(base)
    expect(evidence.head).toBe(git(work, ['rev-parse', 'HEAD']))
    expect(evidence.tree).toBe(git(work, ['rev-parse', 'HEAD^{tree}']))
    expect(evidence.remoteHead).toBe(evidence.head)
    expect(evidence.remoteTrackingHead).toBe(evidence.head)
    const patch = execFileSync('git', ['diff', base, evidence.head], { cwd: work })
    expect(evidence.patchSha256).toBe(createHash('sha256').update(patch).digest('hex'))
    expect(evidence.worktree).toBe('clean')
    expect(evidence.ledger).toMatchObject({
      path: canonicalLedgerPath,
      trustedCommit: base,
      trustSource: 'protected-base',
      transition: 'append-only-valid',
    })
    expect(evidence.contract).toEqual({ problemKey: 'fixture-direction', issue: 100, method: 'fixture-method' })
  })

  it('accepts a legal authorized method change and explicit shared-budget expansion', () => {
    const { work, base } = makeGitFixture()
    const data = candidateLedger(work)
    const direction = data.directions[0]
    direction.maxTotalReworks = 2
    direction.methods[0].status = 'stopped'
    direction.methods[0].reworks = 1
    direction.methods.push({
      id: 'anchored-transition',
      status: 'active',
      issues: [100],
      reworks: 0,
    })
    direction.restarts.push({
      fromMethod: 'fixture-method',
      toMethod: 'anchored-transition',
      authorizedBy: 'product-owner',
      reason: 'replace candidate snapshots with a trusted append-only transition',
      budgetChange: { from: 1, to: 2 },
    })
    commitLedger(work, data)

    const result = runCandidate(work, base, { method: 'anchored-transition' })

    expect(result.status, result.stderr).toBe(0)
  })

  it('fails closed when the candidate commit was not pushed', () => {
    const { work, base } = makeGitFixture()
    writeFileSync(join(work, 'local-only.txt'), 'not pushed\n')
    git(work, ['add', 'local-only.txt'])
    git(work, ['commit', '-m', 'local only'])

    const result = runCandidate(work, base)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not match freshly fetched remote head')
  })

  it('fails closed for dirty worktrees, wrong branches, and missing remote branches', () => {
    const { work, base } = makeGitFixture()
    writeFileSync(join(work, 'dirty.txt'), 'dirty\n')
    const dirty = runCandidate(work, base)
    expect(dirty.status).not.toBe(0)
    expect(dirty.stderr).toContain('worktree is not clean')

    rmSync(join(work, 'dirty.txt'))
    const wrong = runCandidate(work, base, { branch: 'fix/missing' })
    expect(wrong.status).not.toBe(0)
    expect(wrong.stderr).toContain('does not match requested branch')

    git(work, ['checkout', '-b', 'fix/missing'])
    const missing = runCandidate(work, base, { branch: 'fix/missing' })
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('unable to fetch remote branch')
  })

  it('fails closed when the requested trusted Base differs from the freshly fetched protected branch', () => {
    const { work } = makeGitFixture()
    const result = runCandidate(work, git(work, ['rev-parse', 'HEAD']))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not match freshly fetched trusted base')
  })

  it('fails closed when a candidate Issue is not registered under the active problem and method', () => {
    const { work, base } = makeGitFixture()
    const result = runCandidate(work, base, { issue: '101' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('is not registered under active method')
  })

  it('rejects an arbitrary ledger path instead of replacing the canonical fact source', () => {
    const { root, work, base } = makeGitFixture()
    const replacement = writeLedger(root, fixtureLedger({
      methods: [{ id: 'fixture-method', status: 'active', issues: [101], reworks: 0 }],
    }), 'replacement.json')

    const result = runCandidate(work, base, { issue: '101', extra: ['--ledger', replacement] })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--ledger is unsupported')
  })

  it('rejects rewritten Issue bindings and rework counters in the canonical ledger', () => {
    const issueFixture = makeGitFixture()
    const changedIssue = candidateLedger(issueFixture.work)
    changedIssue.directions[0].methods[0].issues = [101]
    commitLedger(issueFixture.work, changedIssue)
    const issueResult = runCandidate(issueFixture.work, issueFixture.base, { issue: '101' })
    expect(issueResult.status).not.toBe(0)
    expect(issueResult.stderr).toContain('historical Issue bindings cannot be rewritten')

    const reworkFixture = makeGitFixture({
      ledger: fixtureLedger({
        maxTotalReworks: 2,
        methods: [{ id: 'fixture-method', status: 'active', issues: [100], reworks: 1 }],
      }),
    })
    const resetReworks = candidateLedger(reworkFixture.work)
    resetReworks.directions[0].methods[0].reworks = 0
    commitLedger(reworkFixture.work, resetReworks)
    const reworkResult = runCandidate(reworkFixture.work, reworkFixture.base)
    expect(reworkResult.status).not.toBe(0)
    expect(reworkResult.stderr).toContain('reworks cannot decrease')
  })

  it('rejects reactivation of a stopped method and deletion of historical methods', () => {
    const stopped = fixtureLedger({
      status: 'stopped',
      methods: [{ id: 'fixture-method', status: 'stopped', issues: [100], reworks: 1 }],
    })
    const reactivationFixture = makeGitFixture({ ledger: stopped })
    const reactivated = candidateLedger(reactivationFixture.work)
    reactivated.directions[0].status = 'active'
    reactivated.directions[0].methods[0].status = 'active'
    commitLedger(reactivationFixture.work, reactivated)
    const reactivation = runCandidate(reactivationFixture.work, reactivationFixture.base)
    expect(reactivation.status).not.toBe(0)
    expect(reactivation.stderr).toContain('stopped method cannot be reactivated')

    const history = {
      version: 1,
      directions: [{
        key: 'fixture-direction',
        status: 'stopped',
        maxTotalReworks: 2,
        methods: [
          { id: 'first-method', status: 'stopped', issues: [100], reworks: 1 },
          { id: 'fixture-method', status: 'stopped', issues: [100], reworks: 1 },
        ],
        restarts: [{
          fromMethod: 'first-method',
          toMethod: 'fixture-method',
          authorizedBy: 'product-owner',
          reason: 'replace the first method with a distinct validation method',
        }],
      }],
    }
    const deletionFixture = makeGitFixture({ ledger: history })
    const deleted = candidateLedger(deletionFixture.work)
    deleted.directions[0].methods.pop()
    deleted.directions[0].restarts = []
    commitLedger(deletionFixture.work, deleted)
    const deletion = runCandidate(deletionFixture.work, deletionFixture.base)
    expect(deletion.status).not.toBe(0)
    expect(deletion.stderr).toContain('historical methods cannot be deleted')
  })

  it('rejects silent budget expansion and rewritten authorization history', () => {
    const budgetFixture = makeGitFixture()
    const expanded = candidateLedger(budgetFixture.work)
    expanded.directions[0].maxTotalReworks = 2
    commitLedger(budgetFixture.work, expanded)
    const budget = runCandidate(budgetFixture.work, budgetFixture.base)
    expect(budget.status).not.toBe(0)
    expect(budget.stderr).toContain('cannot expand without an appended authorized budgetChange')

    const authorizedBase = fixtureLedger({
      maxTotalReworks: 2,
      methods: [
        { id: 'first-method', status: 'stopped', issues: [100], reworks: 1 },
        { id: 'fixture-method', status: 'active', issues: [100], reworks: 0 },
      ],
      restarts: [{
        fromMethod: 'first-method',
        toMethod: 'fixture-method',
        authorizedBy: 'product-owner',
        reason: 'replace the first method with a distinct validation method',
        budgetChange: { from: 1, to: 2 },
      }],
    })
    const authorizationFixture = makeGitFixture({ ledger: authorizedBase })
    const rewritten = candidateLedger(authorizationFixture.work)
    rewritten.directions[0].restarts[0].authorizedBy = 'candidate'
    commitLedger(authorizationFixture.work, rewritten)
    const authorization = runCandidate(authorizationFixture.work, authorizationFixture.base)
    expect(authorization.status).not.toBe(0)
    expect(authorization.stderr).toContain('historical restart authorization')
  })

  it('fails closed for a forged or disconnected bootstrap anchor', () => {
    const { work, base } = makeGitFixture({ includeLedger: false })
    const ledgerPath = join(work, canonicalLedgerPath)
    mkdirSync(dirname(ledgerPath), { recursive: true })
    writeFileSync(ledgerPath, `${JSON.stringify(fixtureLedger(), null, 2)}\n`)
    git(work, ['add', canonicalLedgerPath])
    git(work, ['commit', '-m', 'candidate-controlled ledger'])
    git(work, ['push', 'origin', 'HEAD'])

    const disconnected = runCandidate(work, base)
    expect(disconnected.status).not.toBe(0)
    expect(disconnected.stderr).toContain('frozen bootstrap anchor')
    expect(disconnected.stderr).toContain('is not an ancestor')

    const forged = runCandidate(work, base, { extra: ['--anchor', git(work, ['rev-parse', 'HEAD'])] })
    expect(forged.status).not.toBe(0)
    expect(forged.stderr).toContain('--anchor is unsupported')
  })
})

describe('task contract anti-loop gate', () => {
  it('accepts a stopped direction with an explicit method-change restart and exhausted shared budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-contract-gate-'))
    roots.push(root)
    const ledger = writeLedger(root, validStoppedLedger())
    const result = spawnSync(process.execPath, [contractScript, ledger], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
  })

  it('rejects cross-issue rework budget resets', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-contract-gate-'))
    roots.push(root)
    const data = validStoppedLedger()
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
    const data = validStoppedLedger()
    data.directions[0].maxTotalReworks = 3
    data.directions[0].methods.push({ id: 'example-state-model', status: 'active', issues: [2490], reworks: 0 })
    data.directions[0].status = 'active'
    const ledger = writeLedger(root, data)
    const result = spawnSync(process.execPath, [contractScript, ledger], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('reuses validation method')
  })
})
