#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hermesSource, runtimeReleaseTag } from './runtime-config.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const outFile = resolve(ROOT, 'build', 'runtime-release.json')
const tag = runtimeReleaseTag()
const source = hermesSource()
const hermesAgentVersion = source.version

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify({
  tag,
  hermesAgentVersion,
  hermesSource: {
    repository: source.repository,
    ref: source.ref,
    commit: source.commit,
  },
}, null, 2) + '\n')
console.log(`Runtime release metadata: ${tag}`)
