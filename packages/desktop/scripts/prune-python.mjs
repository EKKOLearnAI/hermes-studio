#!/usr/bin/env node
// Strip __pycache__, *.pyc, tests, idle, tkinter from bundled Python to shrink the installer.
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { platform as osPlatform, arch as osArch } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const PY_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)

if (!existsSync(PY_DIR)) {
  console.error(`No bundled python at ${PY_DIR}`)
  process.exit(1)
}

const PRUNE_DIR_NAMES = new Set(['__pycache__', 'test', 'tests', 'idle_test', 'idlelib', 'turtledemo', 'tkinter', 'ensurepip'])
const PRUNE_FILE_SUFFIXES = ['.pyc', '.pyo']

let bytesFreed = 0
function walk(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (PRUNE_DIR_NAMES.has(name)) {
        bytesFreed += dirSize(p)
        rmSync(p, { recursive: true, force: true })
      } else {
        walk(p)
      }
    } else if (PRUNE_FILE_SUFFIXES.some(s => name.endsWith(s))) {
      bytesFreed += st.size
      rmSync(p, { force: true })
    }
  }
}
function dirSize(dir) {
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      total += st.isDirectory() ? dirSize(p) : st.size
    }
  } catch {}
  return total
}

walk(PY_DIR)
console.log(`✓ Pruned ~${(bytesFreed / 1024 / 1024).toFixed(1)} MB from ${PY_DIR}`)
