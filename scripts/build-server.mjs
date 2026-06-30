import * as esbuild from 'esbuild'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf-8'))
const version = pkg.version
const serverOutDir = resolve(rootDir, 'dist/server')

rmSync(serverOutDir, { recursive: true, force: true })
mkdirSync(serverOutDir, { recursive: true })

await esbuild.build({
  entryPoints: [resolve(rootDir, 'packages/server/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node23',
  format: 'cjs',
  outfile: resolve(serverOutDir, 'index.js'),
  external: ['node-pty', 'node:sqlite', 'socket.io'],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  sourcemap: true,
  minify: true,
  treeShaking: true,
  logLevel: 'info',
})

const bridgeOutDir = resolve(serverOutDir, 'agent-bridge', 'python')
const bridgeSrcDir = resolve(rootDir, 'packages/server/src/services/hermes/agent-bridge/python')
mkdirSync(bridgeOutDir, { recursive: true })
for (const fileName of readdirSync(bridgeSrcDir)) {
  if (fileName.endsWith('.py')) {
    cpSync(resolve(bridgeSrcDir, fileName), resolve(bridgeOutDir, fileName))
  }
}
chmodSync(resolve(bridgeOutDir, 'hermes_bridge.py'), 0o755)

const serverAssetsSrcDir = resolve(rootDir, 'packages/server/src/assets')
if (existsSync(serverAssetsSrcDir)) {
  cpSync(serverAssetsSrcDir, resolve(serverOutDir, 'assets'), { recursive: true })
}

cpSync(
  resolve(rootDir, 'docs/openapi.json'),
  resolve(serverOutDir, 'openapi.json'),
)

const skillsOutDir = resolve(rootDir, 'dist/skills')
rmSync(skillsOutDir, { recursive: true, force: true })
cpSync(
  resolve(rootDir, 'packages/skills'),
  skillsOutDir,
  { recursive: true },
)

const firmwareBuildSrc = resolve(rootDir, 'packages/esp32-c3/.pio/build/esp32-c3-devkitm-1/firmware.bin')
const firmwareReleaseSrc = resolve(rootDir, 'packages/esp32-c3/release/firmware.bin')
const firmwareOutDir = resolve(rootDir, 'dist/mcu')
const firmwareOutPath = resolve(firmwareOutDir, 'firmware.bin')
if (existsSync(firmwareBuildSrc)) {
  mkdirSync(firmwareOutDir, { recursive: true })
  mkdirSync(dirname(firmwareReleaseSrc), { recursive: true })
  cpSync(firmwareBuildSrc, firmwareReleaseSrc)
  cpSync(firmwareBuildSrc, firmwareOutPath)
  console.log('[build-server] ESP32-C3 firmware copied from PlatformIO build output')
} else if (existsSync(firmwareReleaseSrc)) {
  mkdirSync(firmwareOutDir, { recursive: true })
  cpSync(firmwareReleaseSrc, firmwareOutPath)
  console.log('[build-server] ESP32-C3 firmware copied from release artifact')
} else {
  console.warn('[build-server] ESP32-C3 firmware not found, skipped dist/mcu/firmware.bin')
}
