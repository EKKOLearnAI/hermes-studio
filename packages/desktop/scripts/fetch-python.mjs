#!/usr/bin/env node
// Download python-build-standalone for the current (or target) platform/arch
// and extract into resources/python/<os>-<arch>/
import { mkdirSync, existsSync, createWriteStream, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir, platform as osPlatform, arch as osArch } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Pin a known-good python-build-standalone release. Bump intentionally.
const PBS_TAG = process.env.PBS_TAG || '20260510'
const PYTHON_VERSION = process.env.PBS_PY || '3.12.13'

const TARGET_OS = process.env.TARGET_OS || osPlatform() // darwin | win32 | linux
const TARGET_ARCH = process.env.TARGET_ARCH || osArch() // arm64 | x64

const TRIPLE_MAP = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
}

const key = `${TARGET_OS}-${TARGET_ARCH}`
const triple = TRIPLE_MAP[key]
if (!triple) {
  console.error(`Unsupported target: ${key}`)
  process.exit(1)
}

// electron-builder uses `mac`/`win`/`linux` for `${os}` — match that
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const OUT_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)
const FLAVOR = 'install_only_stripped'
const FILE = `cpython-${PYTHON_VERSION}+${PBS_TAG}-${triple}-${FLAVOR}.tar.gz`
const PBS_BASE_URL = (process.env.PBS_BASE_URL || 'https://github.com/astral-sh/python-build-standalone/releases/download').replace(/\/$/, '')
const URL = `${PBS_BASE_URL}/${PBS_TAG}/${FILE}`

if (existsSync(resolve(OUT_DIR, 'python')) || existsSync(resolve(OUT_DIR, 'bin', 'python3'))) {
  console.log(`✓ Python already present at ${OUT_DIR}, skipping`)
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })
const tarPath = resolve(tmpdir(), FILE)

console.log(`→ Fetching ${URL}`)
const curl = spawnSync('curl', ['-fL', '--retry', '3', '-o', tarPath, URL], { stdio: 'inherit' })
if (curl.status !== 0) {
  console.error('curl failed')
  process.exit(curl.status ?? 1)
}

console.log(`→ Extracting into ${OUT_DIR}`)
// PBS tarballs unpack to a top-level "python/" directory; --strip-components=1 flattens it
const tar = spawnSync('tar', ['-xzf', tarPath, '-C', OUT_DIR, '--strip-components=1'], { stdio: 'inherit' })
if (tar.status !== 0) {
  console.error('tar failed')
  process.exit(tar.status ?? 1)
}

rmSync(tarPath, { force: true })
console.log(`✓ Python ready at ${OUT_DIR}`)
