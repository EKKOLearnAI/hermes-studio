import * as esbuild from 'esbuild'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { brotliCompressSync, constants, gzipSync } from 'zlib'
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf-8'))
const version = pkg.version
const clientAssetsDir = resolve(rootDir, 'dist/client/assets')

function listFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = resolve(dir, entry.name)
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath]
  })
}

function precompressClientAssets() {
  let count = 0
  for (const filePath of listFiles(clientAssetsDir)) {
    if (!/\.(js|css)$/.test(filePath) || /\.(br|gz)$/.test(filePath)) continue
    const input = readFileSync(filePath)
    const brotli = brotliCompressSync(input, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      },
    })
    const gzip = gzipSync(input, { level: 9 })
    if (brotli.length < input.length) writeFileSync(`${filePath}.br`, brotli)
    if (gzip.length < input.length) writeFileSync(`${filePath}.gz`, gzip)
    count += 1
  }
  console.log(`Precompressed ${count} client JS/CSS asset(s)`)
}

if (statSync(clientAssetsDir, { throwIfNoEntry: false })?.isDirectory()) {
  precompressClientAssets()
}

await esbuild.build({
  entryPoints: [resolve(rootDir, 'packages/server/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node23',
  format: 'cjs',
  outfile: resolve(rootDir, 'dist/server/index.js'),
  external: ['node-pty', 'node:sqlite', 'socket.io'],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  sourcemap: true,
  minify: true,
  treeShaking: true,
  logLevel: 'info',
})

const bridgeOutDir = resolve(rootDir, 'dist/server/agent-bridge')
mkdirSync(bridgeOutDir, { recursive: true })
cpSync(
  resolve(rootDir, 'packages/server/src/services/hermes/agent-bridge/hermes_bridge.py'),
  resolve(bridgeOutDir, 'hermes_bridge.py'),
)
