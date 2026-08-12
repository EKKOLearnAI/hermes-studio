import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../..')
const candidateScript = join(repoRoot, 'scripts/verify-candidate-evidence.mjs')
const contractScript = join(repoRoot, 'scripts/validate-task-contracts.mjs')
const trustedPrScript = join(repoRoot, 'scripts/verify-pr-ledger-from-base.mjs')
const canonicalPatchScript = join(repoRoot, 'scripts/canonical-git-patch.mjs')
const canonicalLedgerPath = 'docs/harness/task-contracts.json'
const validatorPath = 'scripts/validate-task-contracts.mjs'
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

function makeGitFixture(options: {
  ledger?: unknown
  includeLedger?: boolean
  includeValidator?: boolean
  candidateAttributes?: string
} = {}) {
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
  if (options.includeValidator !== false) {
    const target = join(seed, validatorPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(contractScript))
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
  writeFileSync(join(work, 'another.txt'), 'candidate two\n')
  if (options.candidateAttributes) {
    writeFileSync(join(work, '.gitattributes'), options.candidateAttributes)
  }
  git(work, ['add', 'change.txt', 'another.txt', ...(options.candidateAttributes ? ['.gitattributes'] : [])])
  git(work, ['commit', '-m', 'candidate'])
  git(work, ['push', '-u', 'origin', 'fix/evidence'])
  return { root, seed, work, base, remote }
}

function runCandidate(
  work: string,
  base: string,
  options: {
    branch?: string
    issue?: string
    method?: string
    extra?: string[]
    env?: NodeJS.ProcessEnv
  } = {},
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
    env: options.env ?? process.env,
  })
}

function runTrustedPrGate(
  seed: string,
  base: string,
  head: string,
  options: { branch?: string } = {},
) {
  return spawnSync(process.execPath, [
    trustedPrScript,
    '--base', base,
    '--head', head,
    '--remote', 'origin',
    '--branch', options.branch ?? 'fix/evidence',
    '--json',
  ], {
    cwd: seed,
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
    const patch = execFileSync(evidence.patchCommand[0], evidence.patchCommand.slice(1), { cwd: work })
    expect(evidence.patchSha256).toBe(createHash('sha256').update(patch).digest('hex'))
    expect(evidence.worktree).toBe('clean')
    expect(evidence.ledger).toMatchObject({
      path: canonicalLedgerPath,
      trustedCommit: base,
      trustSource: 'protected-base',
      transition: 'append-only-valid',
    })
    expect(evidence.patchCommand).toEqual([
      process.execPath,
      canonicalPatchScript,
      base,
      evidence.head,
    ])
    expect(evidence.contract).toEqual({ problemKey: 'fixture-direction', issue: 100, method: 'fixture-method' })
  })

  it('rejects candidate-authored method changes and budget expansions', () => {
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

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('authorization changes must already exist in the trusted Base')
  })

  it('uses the validator stored in the trusted Base instead of a candidate replacement', () => {
    const { seed, work, base } = makeGitFixture()
    const data = candidateLedger(work)
    data.directions[0].methods[0].issues = [101]
    writeFileSync(join(work, canonicalLedgerPath), `${JSON.stringify(data, null, 2)}\n`)
    writeFileSync(join(work, validatorPath), '#!/usr/bin/env node\nprocess.exit(0)\n')
    git(work, ['add', canonicalLedgerPath, validatorPath])
    git(work, ['commit', '-m', 'candidate bypass'])
    git(work, ['push', 'origin', 'HEAD'])
    const head = git(work, ['rev-parse', 'HEAD'])

    const result = runTrustedPrGate(seed, base, head)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('historical Issue bindings cannot be rewritten')
  })

  it('accepts unchanged authorization data through the Base-owned PR gate', () => {
    const { seed, work, base } = makeGitFixture()
    const head = git(work, ['rev-parse', 'HEAD'])

    const result = runTrustedPrGate(seed, base, head)

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      gate: 'trusted-base-ledger-transition',
      base,
      head,
      transition: 'append-only-valid',
    })
  })

  it('reports a non-authoritative bootstrap state when the trusted Base has no validator', () => {
    const { work, base } = makeGitFixture({ includeValidator: false })
    const result = runCandidate(work, base)

    expect(result.status).toBe(2)
    const evidence = JSON.parse(result.stdout)
    expect(evidence.gate).toEqual({
      status: 'bootstrap-review-required',
      authoritative: false,
      reason: 'trusted Base does not contain the ledger validator',
    })
    expect(evidence.ledger.transition).toBe('not-authoritatively-validated')
  })

  it('produces the same patch identity under hostile local diff configuration', () => {
    const { work, base } = makeGitFixture()
    const normal = runCandidate(work, base)
    expect(normal.status, normal.stderr).toBe(0)
    const expected = JSON.parse(normal.stdout)

    git(work, ['config', 'diff.noprefix', 'true'])
    git(work, ['config', 'diff.mnemonicPrefix', 'true'])
    git(work, ['config', 'diff.renames', 'true'])
    git(work, ['config', 'diff.algorithm', 'histogram'])
    git(work, ['config', 'diff.indentHeuristic', 'true'])
    git(work, ['config', 'diff.context', '8'])
    git(work, ['config', 'diff.interHunkContext', '8'])
    const orderFile = join(work, '.git', 'hostile-diff-order')
    writeFileSync(orderFile, 'change.txt\nanother.txt\n')
    git(work, ['config', 'diff.orderFile', orderFile])
    git(work, ['config', 'core.quotePath', 'false'])
    git(work, ['config', 'color.ui', 'always'])
    const hostile = runCandidate(work, base)

    expect(hostile.status, hostile.stderr).toBe(0)
    expect(JSON.parse(hostile.stdout).patchSha256).toBe(expected.patchSha256)
  })

  it('isolates patch bytes from repository, info, global, and system attributes', () => {
    const { root, work, base } = makeGitFixture({
      candidateAttributes: [
        'change.txt binary',
        'another.txt diff=hostile',
        '',
      ].join('\n'),
    })
    git(work, ['config', 'diff.hostile.binary', 'true'])
    const normal = runCandidate(work, base)
    expect(normal.status, normal.stderr).toBe(0)
    const expected = JSON.parse(normal.stdout)

    const infoAttributes = resolve(work, git(work, ['rev-parse', '--git-path', 'info/attributes']))
    writeFileSync(infoAttributes, 'another.txt binary\n')
    const globalAttributes = join(root, 'global-attributes')
    const systemAttributes = join(root, 'system-attributes')
    writeFileSync(globalAttributes, 'change.txt diff=hostile\n')
    writeFileSync(systemAttributes, 'another.txt diff=hostile\n')
    const globalConfig = join(root, 'global-config')
    const systemConfig = join(root, 'system-config')
    writeFileSync(globalConfig, [
      '[core]',
      `\tattributesFile = ${globalAttributes}`,
      '[diff "hostile"]',
      '\tbinary = true',
      '',
    ].join('\n'))
    writeFileSync(systemConfig, [
      '[core]',
      `\tattributesFile = ${systemAttributes}`,
      '[diff "hostile"]',
      '\tbinary = true',
      '',
    ].join('\n'))

    const hostile = runCandidate(work, base, {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_SYSTEM: systemConfig,
      },
    })

    expect(hostile.status, hostile.stderr).toBe(0)
    const evidence = JSON.parse(hostile.stdout)
    expect(evidence.patchSha256).toBe(expected.patchSha256)
    const patch = execFileSync(evidence.patchCommand[0], evidence.patchCommand.slice(1), {
      cwd: work,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_SYSTEM: systemConfig,
      },
    }).toString()
    expect(createHash('sha256').update(patch).digest('hex')).toBe(evidence.patchSha256)
    expect(patch).toContain('+candidate')
    expect(patch).toContain('+candidate two')
    expect(patch).not.toContain('Binary files ')
    expect(evidence.patchIsolation).toEqual({
      commandOwner: 'scripts/canonical-git-patch.mjs',
      attributes: 'isolated recursive info/attributes unsets diff-affecting repository attributes',
      globalAttributes: 'disabled',
      systemAttributes: 'disabled',
      repositoryConfig: 'isolated bare repository',
    })
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
      maxTotalReworks: 2,
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
    expect(budget.stderr).toContain('shared rework budget expansion must already exist in the trusted Base')

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
    expect(authorization.stderr).toContain('authorizedBy must be an approved role')
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

  it('rejects self-authorization and a zero-cost successor restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-contract-gate-'))
    roots.push(root)
    const data = fixtureLedger({
      maxTotalReworks: 2,
      methods: [
        { id: 'first-method', status: 'stopped', issues: [100], reworks: 0 },
        { id: 'second-method', status: 'active', issues: [101], reworks: 0 },
      ],
      restarts: [{
        fromMethod: 'first-method',
        toMethod: 'second-method',
        authorizedBy: 'candidate',
        reason: 'candidate grants itself another validation attempt',
      }],
    })
    const ledger = writeLedger(root, data)
    const result = spawnSync(process.execPath, [contractScript, ledger], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('authorizedBy must be an approved role')
    expect(result.stderr).toContain('must consume at least one rework before a successor')
  })

  it('rejects an active direction whose shared budget is exhausted', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-contract-gate-'))
    roots.push(root)
    const ledger = writeLedger(root, fixtureLedger({
      maxTotalReworks: 1,
      methods: [{ id: 'fixture-method', status: 'active', issues: [100], reworks: 1 }],
    }))
    const result = spawnSync(process.execPath, [contractScript, ledger], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('exhausted shared rework budget cannot remain active')
  })

  it('rejects a successor ordering where an earlier method remains active', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-contract-gate-'))
    roots.push(root)
    const ledger = writeLedger(root, fixtureLedger({
      maxTotalReworks: 2,
      methods: [
        { id: 'first-method', status: 'active', issues: [100], reworks: 1 },
        { id: 'second-method', status: 'stopped', issues: [101], reworks: 0 },
      ],
      restarts: [{
        fromMethod: 'first-method',
        toMethod: 'second-method',
        authorizedBy: 'product-owner',
        reason: 'replace the first method with a separately reviewed successor',
      }],
    }))
    const result = spawnSync(process.execPath, [contractScript, ledger], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('only the final successor method may be active')
    expect(result.stderr).toContain('predecessor method must be stopped')
  })
})
