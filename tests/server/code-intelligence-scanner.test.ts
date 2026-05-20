import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanCodeIntelligence } from '../../packages/server/src/services/hermes/code-intelligence/scanner'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-code-intel-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('scanCodeIntelligence', () => {
  it('summarizes TypeScript, Vue, Python, and C++ detection without reading dependency folders', async () => {
    const root = fixture()
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    writeFileSync(join(root, 'src', 'App.vue'), '<template />\n<script setup lang="ts"></script>\n')
    writeFileSync(join(root, 'src', 'main.ts'), 'console.log("ok")\n')
    writeFileSync(join(root, 'src', 'bridge.py'), 'print("ok")\n')
    writeFileSync(join(root, 'node_modules', 'ignored', 'huge.ts'), 'ignored\n')

    const result = await scanCodeIntelligence(root)

    expect(result.root).toBe(root)
    expect(result.languages.TypeScript.files).toBe(1)
    expect(result.languages.Vue.files).toBe(1)
    expect(result.languages.Python.files).toBe(1)
    expect(result.languages['C/C++'].status).toBe('not_detected')
    expect(result.manifests.some((item) => item.name === 'package.json')).toBe(true)
    expect(result.recommendedSkills).toContain('codebase-inspection')
    expect(result.recommendedSkills).toContain('hermes-agent')
  })

  it('marks C/C++ as detected when CMake or C++ files exist', async () => {
    const root = fixture()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n')
    writeFileSync(join(root, 'addon.cpp'), 'int main() { return 0; }\n')

    const result = await scanCodeIntelligence(root)

    expect(result.languages['C/C++'].status).toBe('detected')
    expect(result.capabilities.cpp.reason).toContain('CMakeLists.txt')
  })
})
