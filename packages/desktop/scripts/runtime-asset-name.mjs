#!/usr/bin/env node
import { arch as osArch, platform as osPlatform } from 'node:os'
import { hermesVersion, runtimeReleaseTag } from './runtime-config.mjs'

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const HERMES_VERSION = hermesVersion()
const RUNTIME_RELEASE_TAG = runtimeReleaseTag()
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
