#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

for (const file of [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'DEVELOPMENT.md',
  'docs/harness/README.md',
  'docs/harness/validation.md',
  'docs/harness/worktree-runbook.md',
  'docs/harness/pr-review.md',
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

const desktopReleaseWorkflow = await readText('.github/workflows/desktop-release.yml')
const electronBuilderConfig = await readText('packages/desktop/electron-builder.yml')
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

if (failures.length > 0) {
  console.error('Harness check failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Harness check passed')
