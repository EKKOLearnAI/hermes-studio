import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bundledBaseHomePath,
  bundledBasePythonPath,
  configWithPythonHome,
  makeBundledBaseConfigPortable,
  venvPythonPath,
} from '../../packages/desktop/scripts/python-runtime-layout.mjs'

describe('desktop Python runtime layout', () => {
  it('uses sibling base and venv directories for Windows Python', () => {
    const pythonRoot = join('C:\\runtime', 'python')
    const venv = join(pythonRoot, 'venv')

    expect(venvPythonPath(venv, 'win32')).toBe(
      join(venv, 'Scripts', 'python.exe'),
    )
    expect(bundledBasePythonPath(pythonRoot, 'win32')).toBe(
      join(pythonRoot, 'base', 'python.exe'),
    )
    expect(bundledBaseHomePath(pythonRoot, 'win32')).toBe(
      join(pythonRoot, 'base'),
    )
  })

  it('writes the absolute embedded Python home required by Windows', () => {
    const original = [
      'home = C:\\actions\\temp\\python',
      'implementation = CPython',
      'version_info = 3.12.13',
      'include-system-site-packages = false',
      'relocatable = true',
      '',
    ].join('\r\n')

    const home = join('C:\\runtime', 'python', 'base')
    expect(configWithPythonHome(original, home)).toBe([
      `home = ${home}`,
      'implementation = CPython',
      'version_info = 3.12.13',
      'include-system-site-packages = false',
      'relocatable = true',
      '',
    ].join('\n'))
  })

  it('uses a portable sibling base home in the release archive', () => {
    expect(makeBundledBaseConfigPortable(
      'implementation = CPython\n',
      'win32',
    )).toBe('home = ../base\nimplementation = CPython\n')
  })
})
