#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const failures = []

function fail(message) {
  failures.push(message)
}

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8')
}

function requireFile(relativePath) {
  if (!existsSync(path.join(root, relativePath))) {
    fail(`Missing required harness file: ${relativePath}`)
  }
}

function requireDir(relativePath) {
  if (!existsSync(path.join(root, relativePath))) {
    fail(`Missing required project directory: ${relativePath}`)
  }
}

function gitLines(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function changedFilesFromGit() {
  const files = new Set()

  for (const file of gitLines(['diff', '--name-only'])) files.add(file)
  for (const file of gitLines(['diff', '--name-only', '--cached'])) files.add(file)
  for (const file of gitLines(['ls-files', '--others', '--exclude-standard'])) files.add(file)

  const baseRef = process.env.GITHUB_BASE_REF
  if (baseRef) {
    const baseCandidates = [`origin/${baseRef}`, baseRef]
    let foundPrBase = false
    for (const base of baseCandidates) {
      const diff = gitLines(['diff', '--name-only', `${base}...HEAD`])
      if (diff.length > 0) {
        foundPrBase = true
        for (const file of diff) files.add(file)
        break
      }
    }
    if (process.env.GITHUB_ACTIONS === 'true' && !foundPrBase && files.size === 0) {
      fail(`Unable to inspect PR diff against ${baseRef}; build checkout must fetch full history`)
    }
  } else {
    const upstream = gitLines(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])[0]
    if (upstream) {
      for (const file of gitLines(['diff', '--name-only', `${upstream}...HEAD`])) files.add(file)
    }
  }

  return [...files].sort()
}

function isChatSessionChainFile(file) {
  return file === 'packages/client/src/api/hermes/chat.ts'
    || file === 'packages/client/src/api/hermes/group-chat.ts'
    || file === 'packages/client/src/api/hermes/sessions.ts'
    || file === 'packages/client/src/stores/hermes/group-chat.ts'
    || file === 'packages/client/src/stores/hermes/chat.ts'
    || file === 'packages/server/src/controllers/hermes/sessions.ts'
    || file === 'packages/server/src/db/hermes/session-store.ts'
    || file === 'packages/server/src/routes/hermes/group-chat.ts'
    || file.startsWith('packages/client/src/components/hermes/group-chat/')
    || file.startsWith('packages/client/src/components/hermes/chat/')
    || file.startsWith('packages/server/src/lib/context-compressor/')
    || file.startsWith('packages/server/src/services/hermes/context-engine/')
    || file.startsWith('packages/server/src/services/hermes/group-chat/')
    || file.startsWith('packages/server/src/services/hermes/run-chat/')
    || file.startsWith('packages/server/src/services/hermes/agent-bridge/')
}

function isChatChainChangeFragment(file) {
  return file.startsWith('docs/chat-chain-changes/')
    && file.endsWith('.md')
    && path.basename(file) !== 'README.md'
}

for (const file of [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'DEVELOPMENT.md',
  'docs/harness/README.md',
  'docs/harness/validation.md',
  'docs/harness/worktree-runbook.md',
  'docs/harness/pr-review.md',
  'docs/chat-chain-changes/README.md',
]) {
  requireFile(file)
}

for (const dir of [
  'packages/client/src',
  'packages/server/src',
  'packages/desktop',
  'packages/desktop/build/icons',
  'tests/client',
  'tests/server',
  'tests/e2e',
  '.github/workflows',
  'docs/chat-chain-changes',
]) {
  requireDir(dir)
}

for (const icon of [
  'packages/desktop/build/icon.png',
  'packages/desktop/build/icon.icns',
  'packages/desktop/build/icon.ico',
  'packages/desktop/build/icons/16x16.png',
  'packages/desktop/build/icons/32x32.png',
  'packages/desktop/build/icons/48x48.png',
  'packages/desktop/build/icons/64x64.png',
  'packages/desktop/build/icons/128x128.png',
  'packages/desktop/build/icons/256x256.png',
  'packages/desktop/build/icons/512x512.png',
]) {
  requireFile(icon)
}

const agents = await readText('AGENTS.md')
const agentLines = agents.trimEnd().split(/\r?\n/)
if (agentLines.length > 120) {
  fail(`AGENTS.md should stay short; found ${agentLines.length} lines, expected <= 120`)
}

for (const requiredLink of [
  'DEVELOPMENT.md',
  'ARCHITECTURE.md',
  'docs/harness/README.md',
  'docs/harness/validation.md',
  'docs/harness/worktree-runbook.md',
  'docs/harness/pr-review.md',
]) {
  if (!agents.includes(requiredLink)) {
    fail(`AGENTS.md must link to ${requiredLink}`)
  }
}

const packageJson = JSON.parse(await readText('package.json'))
for (const scriptName of [
  'harness:check',
  'test',
  'test:coverage',
  'test:e2e',
  'build',
]) {
  if (!packageJson.scripts?.[scriptName]) {
    fail(`package.json is missing script: ${scriptName}`)
  }
}

const architecture = await readText('ARCHITECTURE.md')
for (const phrase of [
  'packages/client/src',
  'packages/server/src',
  'packages/desktop',
  'HERMES_WEB_UI_HOME',
  'fail_on_unmatched_files: true',
]) {
  if (!architecture.includes(phrase)) {
    fail(`ARCHITECTURE.md should document: ${phrase}`)
  }
}

const buildWorkflow = await readText('.github/workflows/build.yml')
if (!buildWorkflow.includes('npm run harness:check')) {
  fail('Build workflow must run npm run harness:check')
}
if (!buildWorkflow.includes('fetch-depth: 0')) {
  fail('Build workflow checkout must use fetch-depth: 0 so harness:check can inspect PR diffs')
}

const chatSessionsDoc = await readText('docs/cli-chat-sessions.md')
for (const phrase of [
  '最后重建时间',
  '维护要求',
  '最近链路变更记录',
  'docs/chat-chain-changes/',
  '每个 PR 一个变更片段',
  'packages/server/src/services/hermes/agent-bridge/',
  'packages/server/src/services/hermes/group-chat/',
  'packages/server/src/lib/context-compressor/',
  '任何改动都算 Chat 链路改动',
]) {
  if (!chatSessionsDoc.includes(phrase)) {
    fail(`docs/cli-chat-sessions.md must document chat chain maintenance rule: ${phrase}`)
  }
}

const changedFiles = changedFilesFromGit()
const changedChatChainFiles = changedFiles.filter(
  file => !isChatChainChangeFragment(file)
    && file !== 'docs/chat-chain-changes/README.md'
    && file !== 'docs/cli-chat-sessions.md'
    && isChatSessionChainFile(file),
)
const changedChatChainFragments = changedFiles.filter(isChatChainChangeFragment)
if (changedChatChainFiles.length > 0 && changedChatChainFragments.length === 0) {
  fail(
    [
      'Chat session chain changed without adding a docs/chat-chain-changes/*.md fragment.',
      'Add one fragment with date, PR/commit, touched feature, and behavior impact.',
      `Changed chain files: ${changedChatChainFiles.join(', ')}`,
    ].join(' '),
  )
}
for (const file of changedChatChainFragments) {
  if (!existsSync(path.join(root, file))) {
    fail(`Chat chain change fragment was removed instead of added/updated: ${file}`)
    continue
  }
  const fragment = await readText(file)
  for (const marker of ['date:', 'feature:', 'impact:']) {
    if (!fragment.includes(marker)) {
      fail(`Chat chain change fragment ${file} must include frontmatter field: ${marker}`)
    }
  }
  if (!fragment.includes('pr:') && !fragment.includes('commit:')) {
    fail(`Chat chain change fragment ${file} must include either pr: or commit:`)
  }
}

const desktopReleaseWorkflow = await readText('.github/workflows/desktop-release.yml')
const desktopManualBuildWorkflow = await readText('.github/workflows/desktop-manual-build.yml')
const desktopMacUpdateManifestWorkflow = await readText('.github/workflows/desktop-mac-update-manifest.yml')
const desktopRuntimeWorkflow = await readText('.github/workflows/desktop-runtime.yml')
const electronBuilderConfig = await readText('packages/desktop/electron-builder.yml')
const desktopPackageJson = await readText('packages/desktop/package.json')
const desktopInstallHermes = await readText('packages/desktop/scripts/install-hermes.mjs')
const desktopWebuiServer = await readText('packages/desktop/src/main/webui-server.ts')
const desktopRuntimeManager = await readText('packages/desktop/src/main/runtime-manager.ts')
const desktopPaths = await readText('packages/desktop/src/main/paths.ts')
const desktopRuntimeAssetName = await readText('packages/desktop/scripts/runtime-asset-name.mjs')
if (!desktopReleaseWorkflow.includes('files: ${{ matrix.artifact_files }}')) {
  fail('desktop-release.yml must upload matrix-specific artifact_files')
}

if (!electronBuilderConfig.includes('icon: build/icons')) {
  fail('electron-builder.yml must configure the Linux icon set')
}

for (const target of ['target_os: darwin', 'target_os: win32', 'target_os: linux']) {
  if (!desktopReleaseWorkflow.includes(target)) {
    fail(`desktop-release.yml is missing matrix target ${target}`)
  }
}

for (const expectedGlob of ['*.dmg', '*.exe', '*.AppImage']) {
  if (!desktopReleaseWorkflow.includes(expectedGlob)) {
    fail(`desktop-release.yml is missing expected artifact glob ${expectedGlob}`)
  }
}

if (!desktopReleaseWorkflow.includes('fail_on_unmatched_files: true')) {
  fail('desktop-release.yml must keep fail_on_unmatched_files: true')
}

function workflowCaseBody(text, caseLabel) {
  const start = text.indexOf(`${caseLabel})`)
  if (start < 0) fail(`desktop-manual-build.yml is missing ${caseLabel} case`)
  const end = text.indexOf(';;', start)
  if (end < 0) fail(`desktop-manual-build.yml ${caseLabel} case is missing terminator`)
  return text.slice(start, end)
}

for (const macCase of ['darwin-arm64', 'darwin-x64']) {
  const body = workflowCaseBody(desktopManualBuildWorkflow, macCase)
  if (body.includes('latest*.yml')) {
    fail(`desktop-manual-build.yml must not publish single-arch macOS update manifests from ${macCase}`)
  }
  for (const glob of ['*.dmg.blockmap', '*.zip.blockmap']) {
    if (!body.includes(glob)) {
      fail(`desktop-manual-build.yml ${macCase} must keep uploading ${glob}`)
    }
  }
}

for (const phrase of [
  'mac-update-manifest:',
  "if: needs.validate.outputs.target_os == 'darwin' && github.event.inputs.release_tag != ''",
  'Both macOS architectures are not available yet; leaving latest-mac.yml unchanged.',
  'gh release upload "$TAG" /tmp/latest-mac.yml',
]) {
  if (!desktopManualBuildWorkflow.includes(phrase)) {
    fail(`desktop-manual-build.yml must include macOS manifest repair behavior: ${phrase}`)
  }
}

if (!desktopMacUpdateManifestWorkflow.includes('Repair macOS Update Manifest')) {
  fail('desktop-mac-update-manifest.yml must provide a manual macOS manifest repair workflow')
}

if (!desktopMacUpdateManifestWorkflow.includes("gh release download \"$TAG\"") || !desktopMacUpdateManifestWorkflow.includes('/tmp/latest-mac.yml')) {
  fail('desktop-mac-update-manifest.yml must generate latest-mac.yml from release assets')
}

if (!desktopMacUpdateManifestWorkflow.includes('gh release upload "$TAG" /tmp/latest-mac.yml')) {
  fail('desktop-mac-update-manifest.yml must upload the merged latest-mac.yml to the release')
}

for (const phrase of [
  'resources/python/${os}-${arch}',
  'resources/node/${os}-${arch}',
  'resources/git/${os}-${arch}',
]) {
  if (electronBuilderConfig.includes(phrase)) {
    fail(`electron-builder.yml must not bundle desktop runtime resource: ${phrase}`)
  }
}

for (const phrase of [
  '"fetch:node"',
  '"fetch:git"',
  '"prepare:runtime"',
  '"package:runtime"',
  '"runtime:asset-name"',
]) {
  if (!desktopPackageJson.includes(phrase)) {
    fail(`packages/desktop/package.json must support runtime package publishing: ${phrase}`)
  }
}

for (const phrase of [
  'steps.check.outputs.missing',
  'npm --prefix packages/desktop run prepare:runtime',
  'npm --prefix packages/desktop run package:runtime',
]) {
  if (!desktopRuntimeWorkflow.includes(phrase)) {
    fail(`desktop-runtime.yml must build and publish missing runtime package assets: ${phrase}`)
  }
}

if (!desktopRuntimeAssetName.includes('hermes-runtime-hermes-agent-')) {
  fail('runtime asset naming must include hermes-agent version')
}

for (const phrase of [
  'websockets',
  'agent-browser@^0.26.0',
  'AGENT_BROWSER_HOME',
  'AGENT_BROWSER_EXECUTABLE_PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'ms-playwright',
  'removeBrokenDashboardAuthPlugin',
]) {
  if (!desktopInstallHermes.includes(phrase)) {
    fail(`install-hermes.mjs must bundle Hermes browser runtime support: ${phrase}`)
  }
}

for (const phrase of [
  'bundledNodeBin',
  'HERMES_AGENT_NODE',
  'HERMES_AGENT_GIT',
  'PLAYWRIGHT_BROWSERS_PATH',
  'ms-playwright',
]) {
  if (!desktopWebuiServer.includes(phrase)) {
    fail(`desktop webui server must expose bundled browser runtime: ${phrase}`)
  }
}

for (const phrase of [
  'HERMES_DESKTOP_RUNTIME_URL',
  'HERMES_DESKTOP_RUNTIME_BASE_URL',
  'runtime-manifest.json',
]) {
  if (!desktopRuntimeManager.includes(phrase)) {
    fail(`desktop runtime manager must support downloadable runtime packages: ${phrase}`)
  }
}

if (!desktopPaths.includes('HERMES_DESKTOP_RUNTIME_DIR')) {
  fail('desktop paths must allow HERMES_DESKTOP_RUNTIME_DIR override')
}

if (failures.length > 0) {
  console.error('Harness check failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Harness check passed')
