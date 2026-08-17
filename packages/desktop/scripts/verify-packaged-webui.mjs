import { existsSync, readdirSync } from 'node:fs'
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

function sherpaPlatformName(platform) {
  return platform === 'win32' ? 'win' : platform
}

function sharpRuntimeRoots(webUiRoot, platform, arch) {
  const target = `${platform}-${arch}`
  const roots = [join(webUiRoot, 'node_modules', '@img', `sharp-${target}`)]
  if (platform !== 'win32') {
    roots.push(join(webUiRoot, 'node_modules', '@img', `sharp-libvips-${target}`))
  }
  return roots
}

function containsRuntimeFile(root, extensions) {
  if (!existsSync(root)) return false
  const entries = readdirSync(root, { withFileTypes: true })
  return entries.some((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return containsRuntimeFile(path, extensions)
    return extensions.some(extension => {
      if (extension === '.so') return /\.so(?:\.\d+)*$/.test(entry.name)
      return entry.name.endsWith(extension)
    })
  })
}

function sherpaRuntimeFiles(platform) {
  if (platform === 'win32') {
    return [
      'sherpa-onnx.node',
      'onnxruntime.dll',
      'onnxruntime_providers_shared.dll',
      'sherpa-onnx-c-api.dll',
      'sherpa-onnx-cxx-api.dll',
    ]
  }
  if (platform === 'darwin') {
    return [
      'sherpa-onnx.node',
      'libonnxruntime.dylib',
      'libsherpa-onnx-c-api.dylib',
      'libsherpa-onnx-cxx-api.dylib',
    ]
  }
  return [
    'sherpa-onnx.node',
    'libonnxruntime.so',
    'libsherpa-onnx-c-api.so',
    'libsherpa-onnx-cxx-api.so',
  ]
}

export default async function verifyPackagedWebUi(context) {
  const webUiRoot = join(packagedResourcesDirectory(context), 'webui')
  const nodePtyRoot = join(webUiRoot, 'node_modules', 'node-pty')
  const nodePtyTarget = `${context.electronPlatformName}-${targetArchName(context.arch)}`
  const nodePtyPrebuild = join(nodePtyRoot, 'prebuilds', nodePtyTarget)
  const sherpaTarget = `sherpa-onnx-${sherpaPlatformName(context.electronPlatformName)}-${targetArchName(context.arch)}`
  const sherpaRoot = join(webUiRoot, 'node_modules', sherpaTarget)
  const sharpRoots = sharpRuntimeRoots(webUiRoot, context.electronPlatformName, targetArchName(context.arch))
  const required = [
    join(webUiRoot, 'package.json'),
    join(webUiRoot, 'bin', 'hermes-web-ui.mjs'),
    join(webUiRoot, 'dist', 'server', 'index.js'),
    join(nodePtyRoot, 'package.json'),
    join(webUiRoot, 'node_modules', 'socket.io', 'package.json'),
    join(webUiRoot, 'node_modules', 'sharp', 'package.json'),
    ...sharpRoots.map(root => join(root, 'package.json')),
    join(webUiRoot, 'node_modules', 'sherpa-onnx-node', 'package.json'),
    join(sherpaRoot, 'package.json'),
    ...sherpaRuntimeFiles(context.electronPlatformName).map(file => join(sherpaRoot, file)),
  ]
  const missing = required.filter(path => !existsSync(path))

  const sharpNativeRoot = sharpRoots[0]
  if (!containsRuntimeFile(sharpNativeRoot, ['.node'])) {
    missing.push(join(sharpNativeRoot, '**', '*.node'))
  }
  if (context.electronPlatformName !== 'win32') {
    const sharpLibvipsRoot = sharpRoots[1]
    const sharedLibraryExtensions = context.electronPlatformName === 'darwin' ? ['.dylib'] : ['.so']
    if (!containsRuntimeFile(sharpLibvipsRoot, sharedLibraryExtensions)) {
      missing.push(join(sharpLibvipsRoot, '**', `*${sharedLibraryExtensions[0]}`))
    }
  }

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
