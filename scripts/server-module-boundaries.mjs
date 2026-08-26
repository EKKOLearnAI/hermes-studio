#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const SERVER_SOURCE_ROOT = 'packages/server/src'
export const LEGACY_CUTOFF_COMMIT = 'a513405354f6b038e220c587c3f729871c2b8b0d'
export const DEBT_BASELINE_PATH = 'scripts/harness/server-module-boundary-baseline.json'
export const TARGET_MODULES = Object.freeze([
  'studio',
  'hermes',
  'ekko',
  'coding-agents',
])

const TARGET_MODULE_SET = new Set(TARGET_MODULES)
const AGENT_MODULE_SET = new Set(['hermes', 'ekko', 'coding-agents'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const STUDIO_AGENT_ENTRY_POINTS = new Set(['contracts', 'public'])
const STUDIO_ROUTE_ENTRY_POINTS = new Set(['contracts', 'public', 'middleware', 'http'])

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.posix.extname(file)) && !file.endsWith('.d.ts')
}

function targetModuleInfo(file) {
  const normalized = normalizePath(file)
  const parts = normalized.split('/')
  if (parts[0] !== 'modules') return null

  const moduleName = parts[1] || null
  return {
    architecture: 'target',
    domain: moduleName,
    layer: parts[2] || null,
    moduleName,
    validModule: TARGET_MODULE_SET.has(moduleName),
  }
}

export function classifyServerFile(file) {
  const normalized = normalizePath(file)
  const target = targetModuleInfo(normalized)
  if (target) return target

  if (normalized === 'index.ts'
    || normalized === 'routes/index.ts'
    || normalized.startsWith('bootstrap/')) {
    return {
      architecture: normalized.startsWith('bootstrap/') ? 'target' : 'legacy',
      domain: 'bootstrap',
      layer: 'bootstrap',
      moduleName: null,
      validModule: true,
    }
  }

  if (normalized.startsWith('services/ekko-agent/')) {
    return legacyInfo('ekko', 'services')
  }

  if (normalized.startsWith('services/coding-agents/')
    || normalized === 'controllers/coding-agents.ts'
    || normalized === 'routes/coding-agents.ts'
    || normalized === 'routes/claude-code-proxy.ts'
    || normalized === 'routes/codex-proxy.ts') {
    return legacyInfo('coding-agents', legacyLayer(normalized))
  }

  if (normalized.startsWith('services/hermes/')
    || normalized.startsWith('controllers/hermes/')
    || normalized.startsWith('routes/hermes/')) {
    return legacyInfo('hermes', legacyLayer(normalized))
  }

  return legacyInfo('studio', legacyLayer(normalized))
}

function legacyInfo(domain, layer) {
  return {
    architecture: 'legacy',
    domain,
    layer,
    moduleName: null,
    validModule: true,
  }
}

function legacyLayer(file) {
  const first = file.split('/')[0]
  if (first === 'routes' || first === 'controllers' || first === 'services' || first === 'db') {
    return first
  }
  return null
}

export function collectModuleSpecifiers(source, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const specifiers = new Set()

  function addStringLiteral(node) {
    if (node && ts.isStringLiteralLike(node)) specifiers.add(node.text)
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      addStringLiteral(node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) addStringLiteral(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return [...specifiers].sort()
}

export function resolveServerImport(fromFile, specifier, allFiles) {
  if (!specifier.startsWith('.')) return null

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
  const candidates = [base]
  const extension = path.posix.extname(base)

  if (extension) {
    const withoutExtension = base.slice(0, -extension.length)
    for (const candidateExtension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${withoutExtension}${candidateExtension}`)
    }
  } else {
    for (const candidateExtension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${base}${candidateExtension}`)
    }
    for (const candidateExtension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${base}/index${candidateExtension}`)
    }
  }

  for (const candidate of candidates) {
    if (allFiles.has(candidate)) return candidate
  }
  return null
}

export function forbiddenDomainDependency(fromDomain, toDomain) {
  if (fromDomain === 'bootstrap' || fromDomain === toDomain) return false
  if (fromDomain === 'studio') return AGENT_MODULE_SET.has(toDomain)
  return AGENT_MODULE_SET.has(fromDomain) && AGENT_MODULE_SET.has(toDomain)
}

function targetDependencyFailures(fromFile, toFile) {
  const from = classifyServerFile(fromFile)
  const to = classifyServerFile(toFile)
  if (from.architecture !== 'target' || from.domain === 'bootstrap') return []

  const failures = []
  if (to.architecture === 'legacy' && to.domain !== 'bootstrap') {
    failures.push(`${fromFile} must not import legacy server source ${toFile}`)
    return failures
  }

  if (to.architecture !== 'target') return failures
  if (!to.validModule) {
    failures.push(`${fromFile} imports unknown server module ${to.moduleName || '(missing name)'} via ${toFile}`)
    return failures
  }

  if (forbiddenDomainDependency(from.domain, to.domain)) {
    failures.push(`${fromFile} (${from.domain}) must not depend on ${toFile} (${to.domain})`)
    return failures
  }

  if (AGENT_MODULE_SET.has(from.domain) && to.domain === 'studio') {
    const allowedEntryPoints = from.layer === 'routes'
      ? STUDIO_ROUTE_ENTRY_POINTS
      : STUDIO_AGENT_ENTRY_POINTS
    if (!allowedEntryPoints.has(to.layer)) {
      failures.push(
        `${fromFile} must use Studio contracts/public APIs, not Studio internal path ${toFile}`,
      )
    }
  }

  if (from.domain !== to.domain) return failures

  if (from.layer === 'routes'
    && !['routes', 'controllers', 'contracts', 'public', 'middleware', 'http'].includes(to.layer)) {
    failures.push(`${fromFile} is a route and must delegate through controllers instead of ${toFile}`)
  }
  if (from.layer === 'controllers'
    && !['services', 'contracts', 'public', 'http'].includes(to.layer)) {
    failures.push(`${fromFile} is a controller and must delegate through services instead of ${toFile}`)
  }
  if (from.layer === 'services' && ['routes', 'controllers', 'sockets'].includes(to.layer)) {
    failures.push(`${fromFile} is a service and must not depend on transport layer ${toFile}`)
  }

  return failures
}

export function validateTargetDependency(fromFile, toFile) {
  return targetDependencyFailures(normalizePath(fromFile), normalizePath(toFile))
}

export function compareDebtBaseline(currentEdges, baselineEdges) {
  const current = new Set(currentEdges.map(edgeKey))
  const baseline = new Set(baselineEdges.map(edgeKey))
  return {
    added: [...current].filter(edge => !baseline.has(edge)).sort(),
    stale: [...baseline].filter(edge => !current.has(edge)).sort(),
  }
}

function edgeKey(edge) {
  if (typeof edge === 'string') return edge
  return `${normalizePath(edge.from)} -> ${normalizePath(edge.to)}`
}

function edgeFromKey(key) {
  const [from, to] = key.split(' -> ')
  return { from, to }
}

function gitOutput(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function repositoryServerFiles(root) {
  const output = gitOutput(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    SERVER_SOURCE_ROOT,
  ])
  return output
    .split(/\r?\n/)
    .map(file => file.trim())
    .filter(Boolean)
    .map(file => normalizePath(path.posix.relative(SERVER_SOURCE_ROOT, file)))
    .sort()
}

function legacyFilesAtCutoff(root) {
  const output = gitOutput(root, [
    'ls-tree',
    '-r',
    '--name-only',
    LEGACY_CUTOFF_COMMIT,
    '--',
    SERVER_SOURCE_ROOT,
  ])
  return new Set(
    output
      .split(/\r?\n/)
      .map(file => file.trim())
      .filter(Boolean)
      .map(file => normalizePath(path.posix.relative(SERVER_SOURCE_ROOT, file))),
  )
}

async function collectDependencyEdges(sourceRoot, sourceFiles) {
  const allFiles = new Set(sourceFiles)
  const dependencies = []
  for (const from of sourceFiles.filter(isSourceFile)) {
    const source = await readFile(path.join(sourceRoot, from), 'utf8')
    for (const specifier of collectModuleSpecifiers(source, from)) {
      const to = resolveServerImport(from, specifier, allFiles)
      if (to) dependencies.push({ from, to })
    }
  }
  return dependencies
}

function uniqueSortedEdges(edges) {
  return [...new Set(edges.map(edgeKey))].sort().map(edgeFromKey)
}

export async function inspectServerModuleBoundaries(root = process.cwd()) {
  const sourceRoot = path.join(root, SERVER_SOURCE_ROOT)
  const sourceFiles = repositoryServerFiles(root)
  const dependencies = await collectDependencyEdges(sourceRoot, sourceFiles)
  const failures = []

  for (const file of sourceFiles) {
    const info = classifyServerFile(file)
    if (info.architecture === 'target' && info.domain !== 'bootstrap' && !info.validModule) {
      failures.push(
        `${SERVER_SOURCE_ROOT}/${file} uses unknown module ${info.moduleName || '(missing name)'}; `
        + `expected one of: ${TARGET_MODULES.join(', ')}`,
      )
    }
  }

  for (const dependency of dependencies) {
    for (const failure of targetDependencyFailures(dependency.from, dependency.to)) {
      failures.push(`${SERVER_SOURCE_ROOT}/${failure}`)
    }
  }

  const forbiddenLegacyEdges = uniqueSortedEdges(dependencies.filter(({ from, to }) => {
    const fromInfo = classifyServerFile(from)
    const toInfo = classifyServerFile(to)
    return fromInfo.architecture === 'legacy'
      && toInfo.architecture === 'legacy'
      && forbiddenDomainDependency(fromInfo.domain, toInfo.domain)
  }))

  return { dependencies, failures, forbiddenLegacyEdges, sourceFiles }
}

export async function checkServerModuleBoundaries(root = process.cwd()) {
  const inspection = await inspectServerModuleBoundaries(root)
  const failures = [...inspection.failures]
  let cutoffFiles
  try {
    cutoffFiles = legacyFilesAtCutoff(root)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    failures.push(
      `Cannot read server boundary cutoff commit ${LEGACY_CUTOFF_COMMIT}. `
      + `Fetch full Git history before running the harness. ${detail}`,
    )
  }

  if (cutoffFiles) {
    const newLegacyFiles = inspection.sourceFiles.filter(file =>
      !file.startsWith('modules/')
      && !file.startsWith('bootstrap/')
      && !cutoffFiles.has(file),
    )
    if (newLegacyFiles.length > 0) {
      failures.push(
        'New server files must be created under packages/server/src/modules/<module> or '
        + `packages/server/src/bootstrap. Legacy additions: ${newLegacyFiles.join(', ')}`,
      )
    }
  }

  const baselineFile = path.join(root, DEBT_BASELINE_PATH)
  if (!existsSync(baselineFile)) {
    failures.push(`Missing server module boundary debt baseline: ${DEBT_BASELINE_PATH}`)
    return failures
  }

  let baseline
  try {
    baseline = JSON.parse(await readFile(baselineFile, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    failures.push(`Cannot parse ${DEBT_BASELINE_PATH}: ${detail}`)
    return failures
  }

  if (baseline.schema !== 1) failures.push(`${DEBT_BASELINE_PATH} must use schema 1`)
  if (baseline.cutoffCommit !== LEGACY_CUTOFF_COMMIT) {
    failures.push(`${DEBT_BASELINE_PATH} cutoffCommit must remain ${LEGACY_CUTOFF_COMMIT}`)
  }
  if (!Array.isArray(baseline.forbiddenImports)) {
    failures.push(`${DEBT_BASELINE_PATH} must contain a forbiddenImports array`)
    return failures
  }

  const debtDiff = compareDebtBaseline(inspection.forbiddenLegacyEdges, baseline.forbiddenImports)
  if (debtDiff.added.length > 0) {
    failures.push(
      'Server module dependency debt increased. Move the shared dependency to Studio or inject it '
      + `through a Studio contract. New edges: ${debtDiff.added.join(', ')}`,
    )
  }
  if (debtDiff.stale.length > 0) {
    failures.push(
      `Server module dependency debt was removed; shrink ${DEBT_BASELINE_PATH}. `
      + `Stale edges: ${debtDiff.stale.join(', ')}`,
    )
  }

  return failures
}

async function runCli() {
  const root = process.cwd()
  if (process.argv.includes('--print-current-debt')) {
    const inspection = await inspectServerModuleBoundaries(root)
    process.stdout.write(`${JSON.stringify({
      schema: 1,
      cutoffCommit: LEGACY_CUTOFF_COMMIT,
      forbiddenImports: inspection.forbiddenLegacyEdges.map(edgeKey),
    }, null, 2)}\n`)
    return
  }

  const failures = await checkServerModuleBoundaries(root)
  if (failures.length > 0) {
    console.error('Server module boundary check failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('Server module boundary check passed')
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) await runCli()
