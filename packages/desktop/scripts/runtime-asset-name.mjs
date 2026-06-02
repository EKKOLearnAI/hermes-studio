#!/usr/bin/env node
import { arch as osArch, platform as osPlatform } from 'node:os'

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const HERMES_VERSION = process.env.HERMES_VERSION || '0.15.2'
const RUNTIME_RELEASE_TAG = process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG
  || process.env.RUNTIME_RELEASE_TAG
  || `hermes-${HERMES_VERSION}-runtime`
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS

if (!['win', 'mac', 'linux'].includes(OS_LABEL) || !['x64', 'arm64'].includes(TARGET_ARCH)) {
  console.error(`Unsupported runtime target: ${TARGET_OS}-${TARGET_ARCH}`)
  process.exit(1)
}

const platform = `${OS_LABEL}-${TARGET_ARCH}`
const asset = `hermes-runtime-hermes-agent-${HERMES_VERSION}-${platform}.tar.gz`
const manifest = `hermes-runtime-${platform}.json`

if (process.argv.includes('--manifest')) {
  console.log(manifest)
} else if (process.argv.includes('--platform')) {
  console.log(platform)
} else if (process.argv.includes('--release-tag')) {
  console.log(RUNTIME_RELEASE_TAG)
} else {
  console.log(asset)
}
