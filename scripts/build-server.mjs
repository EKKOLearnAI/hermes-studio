import * as esbuild from 'esbuild'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync } from 'fs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf-8'))
const version = pkg.version
const serverOutDir = resolve(rootDir, 'dist/server')

function readGitValue(command) {
  try {
    return execSync(command, { cwd: rootDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function redactRemoteUrl(value) {
  if (!value) return ''
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return value.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/, '$1')
  }
}

const buildMetadata = {
  commit: readGitValue('git rev-parse --short=12 HEAD'),
  branch: readGitValue('git branch --show-current') || readGitValue('git rev-parse --abbrev-ref HEAD'),
  source: redactRemoteUrl(readGitValue('git remote get-url origin')),
  built_at: new Date().toISOString(),
}

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
    __WEBUI_BUILD_METADATA__: JSON.stringify(buildMetadata),
  },
  sourcemap: true,
  minify: true,
  treeShaking: true,
  logLevel: 'info',
})

const bridgeOutDir = resolve(serverOutDir, 'agent-bridge')
mkdirSync(bridgeOutDir, { recursive: true })
cpSync(
  resolve(rootDir, 'packages/server/src/services/hermes/agent-bridge/hermes_bridge.py'),
  resolve(bridgeOutDir, 'hermes_bridge.py'),
)
chmodSync(resolve(bridgeOutDir, 'hermes_bridge.py'), 0o755)

const skillsOutDir = resolve(rootDir, 'dist/skills')
rmSync(skillsOutDir, { recursive: true, force: true })
cpSync(
  resolve(rootDir, 'packages/skills'),
  skillsOutDir,
  { recursive: true },
)
