import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { mergePiSettings, userSettingsProvidesPiMcpAdapter } from '../../packages/server/src/modules/coding-agents/services/pi/settings'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

it.each([
  [undefined, true], [[], false], [['*.ts'], true], [['!**'], false],
  [['-index.ts'], false], [['other.ts'], false], [['!**', '+index.ts'], true],
])('honors Pi adapter extension filters %j', (extensions, expected) => {
  expect(userSettingsProvidesPiMcpAdapter({
    packages: [{ source: 'npm:pi-mcp-adapter@2.32.1', extensions }],
  })).toBe(expected)
})

it('does not treat a missing or explicitly excluded extension as installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-adapter-settings-'))
  homes.push(home)
  const adapter = join(home, 'pi-mcp-adapter', 'index.ts')
  expect(userSettingsProvidesPiMcpAdapter({ extensions: [adapter] })).toBe(false)
  mkdirSync(dirname(adapter), { recursive: true })
  writeFileSync(adapter, 'export default function () {}')
  expect(userSettingsProvidesPiMcpAdapter({ extensions: [adapter] })).toBe(true)
  expect(userSettingsProvidesPiMcpAdapter({ extensions: [adapter, `-${adapter}`] })).toBe(false)
})

it('resolves local package sources against their settings file and ignores malformed settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-adapter-settings-'))
  homes.push(home)
  const adapter = join(home, 'pi-mcp-adapter')
  mkdirSync(adapter)
  const settings = mergePiSettings([
    { content: '{', baseDir: home },
    { content: JSON.stringify({ packages: [{ source: './pi-mcp-adapter' }] }), baseDir: home },
  ], join(home, 'bundle', 'index.ts'))
  expect(settings.packages).toEqual([{ source: adapter }])
  expect(userSettingsProvidesPiMcpAdapter(settings)).toBe(true)
})

it('does not mistake a Studio-generated bundled entry for a user adapter', () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-adapter-settings-'))
  homes.push(home)
  const bundle = join(home, 'pi-mcp-adapter', 'index.ts')
  mkdirSync(dirname(bundle), { recursive: true })
  writeFileSync(bundle, 'export default function () {}')
  const settings = mergePiSettings([
    { content: JSON.stringify({ extensions: [bundle] }), baseDir: home },
  ], bundle)
  expect(userSettingsProvidesPiMcpAdapter(settings)).toBe(false)
  expect(settings.extensions).toEqual([])
})
