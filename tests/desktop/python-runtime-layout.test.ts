import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  embeddedBasePythonPath,
  makeEmbeddedBaseConfigRelocatable,
  venvPythonPath,
} from '../../packages/desktop/scripts/python-runtime-layout.mjs'

describe('desktop Python runtime layout', () => {
  it('uses a standard Windows venv around an embedded base interpreter', () => {
    const venv = join('C:\\runtime', 'python', 'venv')

    expect(venvPythonPath(venv, 'win32')).toBe(
      join(venv, 'Scripts', 'python.exe'),
    )
    expect(embeddedBasePythonPath(venv, 'win32')).toBe(
      join(venv, '.base', 'python.exe'),
    )
  })

  it('rewrites the build-machine Python home to the embedded relative base', () => {
    const original = [
      'home = C:\\actions\\temp\\python',
      'implementation = CPython',
      'version_info = 3.12.13',
      'include-system-site-packages = false',
      'relocatable = true',
      '',
    ].join('\r\n')

    expect(makeEmbeddedBaseConfigRelocatable(original, 'win32')).toBe([
      'home = .base',
      'implementation = CPython',
      'version_info = 3.12.13',
      'include-system-site-packages = false',
      'relocatable = true',
      '',
    ].join('\n'))
  })

  it('adds a relative home when uv omits one', () => {
    expect(makeEmbeddedBaseConfigRelocatable(
      'implementation = CPython\n',
      'win32',
    )).toBe('home = .base\nimplementation = CPython\n')
  })
})
