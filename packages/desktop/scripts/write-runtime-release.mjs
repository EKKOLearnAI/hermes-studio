#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hermesVersion, runtimeReleaseTag } from './runtime-config.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const outFile = resolve(ROOT, 'build', 'runtime-release.json')
const tag = runtimeReleaseTag()
const hermesAgentVersion = hermesVersion()

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify({ tag, hermesAgentVersion }, null, 2) + '\n')
console.log(`Runtime release metadata: ${tag}`)
