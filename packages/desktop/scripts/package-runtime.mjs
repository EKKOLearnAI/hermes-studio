#!/usr/bin/env node
// Package prepared Python/Node/Git runtime resources into a release asset.
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const PLATFORM = `${OS_LABEL}-${TARGET_ARCH}`
const OUT_DIR = resolve(ROOT, 'release', 'runtime')

const PY_DIR = resolve(ROOT, 'resources', 'python', PLATFORM)
const NODE_DIR = resolve(ROOT, 'resources', 'node', PLATFORM)
const GIT_DIR = resolve(ROOT, 'resources', 'git', PLATFORM)
const pyBin = TARGET_OS === 'win32'
  ? resolve(PY_DIR, 'python.exe')
  : resolve(PY_DIR, 'bin', 'python3')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf-8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '')
    process.exit(result.status ?? 1)
  }
  return result.stdout.trim()
}

async function sha256File(file) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', resolvePromise)
    stream.on('error', rejectPromise)
  })
  return hash.digest('hex')
}

for (const dir of [PY_DIR, NODE_DIR]) {
  if (!existsSync(dir)) {
    console.error(`Runtime directory missing: ${dir}`)
    process.exit(1)
  }
}

const hermesAgentVersion = output(pyBin, [
  '-c',
  'import importlib.metadata as m; print(m.version("hermes-agent"))',
])
const assetName = `hermes-runtime-hermes-agent-${hermesAgentVersion}-${PLATFORM}.tar.gz`
const manifestName = `hermes-runtime-${PLATFORM}.json`

mkdirSync(OUT_DIR, { recursive: true })
const stage = mkdtempSync(join(tmpdir(), `hermes-runtime-${PLATFORM}-`))

try {
  cpSync(PY_DIR, join(stage, 'python'), { recursive: true, force: true, verbatimSymlinks: true })
  cpSync(NODE_DIR, join(stage, 'node'), { recursive: true, force: true, verbatimSymlinks: true })
  if (existsSync(GIT_DIR)) {
    cpSync(GIT_DIR, join(stage, 'git'), { recursive: true, force: true, verbatimSymlinks: true })
  } else {
    mkdirSync(join(stage, 'git'), { recursive: true })
    writeFileSync(join(stage, 'git', '.placeholder'), 'Git for Windows is only bundled on Windows.\n')
  }

  const runtimeManifest = {
    schema: 1,
    platform: PLATFORM,
    targetOs: TARGET_OS,
    targetArch: TARGET_ARCH,
    hermesAgentVersion,
    asset: {
      name: assetName,
    },
  }
  writeFileSync(join(stage, 'runtime-manifest.json'), JSON.stringify(runtimeManifest, null, 2) + '\n')

  const assetPath = resolve(OUT_DIR, assetName)
  rmSync(assetPath, { force: true })
  run('tar', ['-czf', assetPath, '-C', stage, '.'])

  const sha256 = await sha256File(assetPath)
  writeFileSync(`${assetPath}.sha256`, `${sha256}  ${assetName}\n`)

  const platformManifest = {
    ...runtimeManifest,
    createdAt: new Date().toISOString(),
    asset: {
      name: assetName,
      sha256,
      size: statSync(assetPath).size,
    },
  }
  writeFileSync(resolve(OUT_DIR, manifestName), JSON.stringify(platformManifest, null, 2) + '\n')

  console.log(`Runtime asset: ${assetPath}`)
  console.log(`Runtime manifest: ${resolve(OUT_DIR, manifestName)}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
