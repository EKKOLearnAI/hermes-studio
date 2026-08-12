#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function die(message) {
  console.error(`canonical patch rejected: ${message}`)
  process.exit(1)
}

function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: options.encoding ?? 'utf8',
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 100 * 1024 * 1024,
    })
  } catch (error) {
    const detail = error?.stderr?.toString().trim()
    throw new Error(detail || `git ${args.join(' ')} failed`)
  }
}

if (process.argv.length !== 4) die('usage: canonical-git-patch.mjs <base> <head>')

const base = process.argv[2]
const head = process.argv[3]
const root = mkdtempSync(join(tmpdir(), 'hermes-canonical-patch-'))

try {
  const sourceGitDir = realpathSync(git(['rev-parse', '--git-common-dir']).trim())
  const objectDirectory = join(sourceGitDir, 'objects')
  const isolatedGitDir = join(root, 'repo.git')
  const isolatedHome = join(root, 'home')
  const isolatedXdg = join(root, 'xdg')
  const emptyConfig = join(root, 'empty-config')
  const emptyAttributes = join(root, 'empty-attributes')
  const emptyOrder = join(root, 'empty-order')
  mkdirSync(isolatedHome)
  mkdirSync(isolatedXdg)
  writeFileSync(emptyConfig, '')
  writeFileSync(emptyAttributes, '')
  writeFileSync(emptyOrder, '')
  git(['init', '--bare', '--quiet', isolatedGitDir])
  writeFileSync(
    join(isolatedGitDir, 'info/attributes'),
    '** !binary !diff !merge !text !eol !filter !working-tree-encoding\n',
  )

  const env = {
    ...process.env,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_OBJECT_DIRECTORY: objectDirectory,
    HOME: isolatedHome,
    LC_ALL: 'C',
    XDG_CONFIG_HOME: isolatedXdg,
  }
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS)/.test(name)
      || ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(name)) {
      delete env[name]
    }
  }

  const patch = git([
    `--git-dir=${isolatedGitDir}`,
    '-c', `core.attributesFile=${emptyAttributes}`,
    '-c', 'diff.external=',
    '-c', 'diff.noprefix=false',
    '-c', 'diff.mnemonicPrefix=false',
    '-c', 'diff.renames=false',
    '-c', 'diff.algorithm=myers',
    '-c', 'diff.indentHeuristic=false',
    '-c', 'diff.context=3',
    '-c', 'diff.interHunkContext=0',
    '-c', `diff.orderFile=${emptyOrder}`,
    '-c', 'core.quotePath=true',
    '-c', 'color.ui=false',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    '--full-index',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--no-renames',
    '--diff-algorithm=myers',
    '--no-color',
    '--unified=3',
    '--inter-hunk-context=0',
    '--no-indent-heuristic',
    '--no-relative',
    '--ignore-submodules=none',
    '--submodule=short',
    base,
    head,
    '--',
  ], { encoding: 'buffer', env })
  process.stdout.write(patch)
} catch (error) {
  die(error instanceof Error ? error.message : String(error))
} finally {
  rmSync(root, { recursive: true, force: true })
}
