#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    const details = String(error.stderr || error.message || error).trim()
    throw new Error(`git ${args.join(' ')} failed${details ? `: ${details}` : ''}`)
  }
}

function fail(message) {
  console.error(`Agent Git check failed: ${message}`)
  process.exit(1)
}

const mode = process.argv[2]
if (mode !== 'start' && mode !== 'finish') {
  fail('expected "start" or "finish"')
}

try {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    fail('the current directory is not a Git working tree')
  }

  const branch = git(['branch', '--show-current'])
  if (!branch) fail('detached HEAD is not allowed for agent work')
  if (branch === 'main' || branch === 'master') {
    fail(`create a task branch before working; "${branch}" is protected`)
  }

  const status = git(['status', '--porcelain'])
  if (status) {
    fail(`the working tree is not clean:\n${status}`)
  }

  if (mode === 'start') {
    git(['rev-parse', '--verify', 'origin/main'])
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], {
        cwd: process.cwd(),
        stdio: 'ignore',
      })
    } catch {
      fail('the task branch does not contain the current local origin/main baseline')
    }
    console.log(`Agent Git start check passed on ${branch}.`)
    process.exit(0)
  }

  let upstream
  try {
    upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  } catch {
    fail(`branch "${branch}" has no upstream; push it with git push -u origin ${branch}`)
  }

  const counts = git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
    .split(/\s+/)
    .map(Number)
  const [ahead, behind] = counts
  if (ahead || behind) {
    fail(`branch "${branch}" is not synchronized with ${upstream} (${ahead} ahead, ${behind} behind)`)
  }

  console.log(`Agent Git finish check passed: ${branch} is clean and fully pushed to ${upstream}.`)
} catch (error) {
  fail(error.message || String(error))
}
