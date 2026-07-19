import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

function packagedResourcesDirectory(context) {
  if (context.electronPlatformName === 'darwin') {
    const productFilename = context.packager.appInfo.productFilename
    return join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
  }
  return join(context.appOutDir, 'resources')
}

export function targetArchName(arch) {
  if (typeof arch === 'number') return ARCH_NAMES[arch] || String(arch)
  return String(arch)
}

export default async function verifyPackagedWebUi(context) {
  const webUiRoot = join(packagedResourcesDirectory(context), 'webui')
  const nodePtyRoot = join(webUiRoot, 'node_modules', 'node-pty')
  const nodePtyTarget = `${context.electronPlatformName}-${targetArchName(context.arch)}`
  const nodePtyPrebuild = join(nodePtyRoot, 'prebuilds', nodePtyTarget)
  const required = [
    join(webUiRoot, 'package.json'),
    join(webUiRoot, 'bin', 'hermes-web-ui.mjs'),
    join(webUiRoot, 'dist', 'server', 'index.js'),
    join(nodePtyRoot, 'package.json'),
    join(webUiRoot, 'node_modules', 'socket.io', 'package.json'),
  ]
  const missing = required.filter(path => !existsSync(path))

  const hasNodePtyPrebuild = existsSync(nodePtyPrebuild)
  if (context.electronPlatformName === 'linux' && !hasNodePtyPrebuild) {
    const compiledModule = join(nodePtyRoot, 'build', 'Release', 'pty.node')
    if (!existsSync(compiledModule)) missing.push(compiledModule)
  } else if (!hasNodePtyPrebuild) {
    missing.push(nodePtyPrebuild)
  }

  if (missing.length > 0) {
    throw new Error(`Packaged Web UI is incomplete; missing: ${missing.join(', ')}`)
  }

  console.log(`[package] verified bundled Web UI and production dependencies at ${webUiRoot}`)
}
