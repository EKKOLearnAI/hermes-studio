#!/usr/bin/env node
// Merge two per-arch `latest-mac.yml` manifests (arm64 + x64) into a single
// manifest whose `files:` array lists BOTH dmgs, so electron-updater can pick
// the right architecture.
//
// Why this exists: our Release workflow builds macOS arm64 and x64 in separate
// matrix jobs, each emitting its own `latest-mac.yml`. When the publish job
// flattens the artifacts they collide and only one arch survives — leaving the
// other arch's users served a mismatched dmg (runs under Rosetta / fails the
// updater signature check). Merging the `files` lists fixes that.
//
// Usage: node merge-mac-latest-yml.mjs <a.yml> <b.yml> > latest-mac.yml
//
// The manifest shape electron-builder emits is small and regular, so we parse
// it with a focused extractor rather than pulling in a YAML dependency.

import { readFileSync } from 'node:fs'

function parse(path) {
  const text = readFileSync(path, 'utf-8')
  const version = (text.match(/^version:\s*(.+)$/m) || [])[1]?.trim()
  const releaseDate = (text.match(/^releaseDate:\s*(.+)$/m) || [])[1]?.trim()
  // Each entry under `files:` is `- url: ...` then indented sha512/size lines.
  const files = []
  const re = /- url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)\s*\n\s*size:\s*(\d+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    files.push({ url: m[1], sha512: m[2], size: Number(m[3]) })
  }
  if (!version || files.length === 0) {
    throw new Error(`Could not parse manifest at ${path} (version=${version}, files=${files.length})`)
  }
  return { version, releaseDate, files }
}

const [, , aPath, bPath] = process.argv
if (!aPath || !bPath) {
  console.error('Usage: merge-mac-latest-yml.mjs <a.yml> <b.yml>')
  process.exit(1)
}

const a = parse(aPath)
const b = parse(bPath)

if (a.version !== b.version) {
  console.error(`Version mismatch: ${aPath}=${a.version} vs ${bPath}=${b.version}`)
  process.exit(1)
}

// Dedupe by url, preserving order (a first, then b).
const seen = new Set()
const files = []
for (const f of [...a.files, ...b.files]) {
  if (seen.has(f.url)) continue
  seen.add(f.url)
  files.push(f)
}

// Top-level path/sha512/size are the legacy single-file fields; point them at
// the first entry (arm64 when arm64 is passed first). electron-updater >=6
// selects from `files` by arch; these remain as a fallback for old clients.
const head = files[0]
const releaseDate = a.releaseDate || b.releaseDate

const lines = [`version: ${a.version}`, 'files:']
for (const f of files) {
  lines.push(`  - url: ${f.url}`)
  lines.push(`    sha512: ${f.sha512}`)
  lines.push(`    size: ${f.size}`)
}
lines.push(`path: ${head.url}`)
lines.push(`sha512: ${head.sha512}`)
if (releaseDate) lines.push(`releaseDate: ${releaseDate}`)
process.stdout.write(lines.join('\n') + '\n')
