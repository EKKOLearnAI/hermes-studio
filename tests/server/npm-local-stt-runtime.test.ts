import { describe, expect, it } from 'vitest'
import pkg from '../../package.json'

const sherpaPlatformPackages = [
  'sherpa-onnx-darwin-arm64',
  'sherpa-onnx-darwin-x64',
  'sherpa-onnx-linux-arm64',
  'sherpa-onnx-linux-x64',
  'sherpa-onnx-win-ia32',
  'sherpa-onnx-win-x64',
] as const

describe('npm local STT runtime', () => {
  it('pins every native package to the sherpa-onnx-node wrapper version', () => {
    const wrapperVersion = pkg.dependencies['sherpa-onnx-node']

    expect(wrapperVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(Object.keys(pkg.optionalDependencies).sort()).toEqual([...sherpaPlatformPackages].sort())
    for (const platformPackage of sherpaPlatformPackages) {
      expect(pkg.optionalDependencies[platformPackage]).toBe(wrapperVersion)
    }
  })
})
