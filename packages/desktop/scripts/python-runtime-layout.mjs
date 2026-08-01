import { join } from 'node:path'

export function venvPythonPath(venvDir, targetOs) {
  return targetOs === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python3')
}

export function embeddedBasePythonPath(venvDir, targetOs) {
  return targetOs === 'win32'
    ? join(venvDir, '.base', 'python.exe')
    : join(venvDir, '.base', 'bin', 'python3')
}

export function makeEmbeddedBaseConfigRelocatable(config, targetOs) {
  const home = targetOs === 'win32' ? '.base' : '.base/bin'
  const lines = String(config).split(/\r?\n/)
  const homeIndex = lines.findIndex(line => /^\s*home\s*=/.test(line))
  if (homeIndex >= 0) {
    lines[homeIndex] = `home = ${home}`
  } else {
    lines.unshift(`home = ${home}`)
  }
  return lines.join('\n').replace(/\n*$/, '\n')
}
