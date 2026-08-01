import { dirname, join } from 'node:path'

export function venvPythonPath(venvDir, targetOs) {
  return targetOs === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python3')
}

export function bundledBasePythonPath(pythonRoot, targetOs) {
  return targetOs === 'win32'
    ? join(pythonRoot, 'base', 'python.exe')
    : join(pythonRoot, 'base', 'bin', 'python3')
}

export function bundledBaseHomePath(pythonRoot, targetOs) {
  return dirname(bundledBasePythonPath(pythonRoot, targetOs))
}

export function configWithPythonHome(config, home) {
  const normalizedHome = String(home)
  const lines = String(config).split(/\r?\n/)
  const homeIndex = lines.findIndex(line => /^\s*home\s*=/.test(line))
  if (homeIndex >= 0) {
    lines[homeIndex] = `home = ${normalizedHome}`
  } else {
    lines.unshift(`home = ${normalizedHome}`)
  }
  return lines.join('\n').replace(/\n*$/, '\n')
}

export function makeBundledBaseConfigPortable(config, targetOs) {
  const home = targetOs === 'win32' ? '../base' : '../base/bin'
  return configWithPythonHome(config, home)
}
