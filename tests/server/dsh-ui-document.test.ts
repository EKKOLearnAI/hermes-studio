import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('keeps the native transport functional after production minification without bundling native UI packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-bundle-'))
  try {
    const out = join(root, 'slot.cjs')
    const result = await build({ entryPoints: ['packages/server/src/modules/coding-agents/services/dsh/ui-slot.ts'], outfile: out, bundle: true, minify: true, platform: 'node', format: 'cjs', metafile: true })
    expect(Object.keys(result.metafile!.inputs)).toEqual(['packages/server/src/modules/coding-agents/services/dsh/ui-slot.ts'])
    const { dshUiDocument } = createRequire(import.meta.url)(out)
    const mount = '/api/coding-agents/dsh/ui/fixture/'
    const html = dshUiDocument('<html><head><script src="/plugins/boot.js"></script></head><body></body></html>', mount)
    expect(html).toContain(`src="${mount}plugins/boot.js"`)
    const fetched: string[] = [], sockets: string[] = [], scripts: string[] = []
    const context: any = { URL, Request, Promise, setInterval: () => 1, clearInterval: () => {}, location: new URL('https://studio.example' + mount), XMLHttpRequest: class { open() {} }, document: { createElement: () => ({}), head: { appendChild: (script: any) => { scripts.push(script.src); script.onload() } } } }
    context.window = { fetch: async (url: string) => { fetched.push(String(url)) }, addEventListener: () => {}, WebSocket: class { constructor(url: string) { sockets.push(url) } }, EventSource: class {} }
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context)
    await context.window.fetch('/plugin-owned/config')
    new context.window.WebSocket('wss://studio.example/api/remote.mux')
    await context.window.__DSH_TRANSPORT__.loadBundle('/plugins/native.js')
    expect(fetched).toEqual(['https://studio.example' + mount + 'plugin-owned/config'])
    expect(sockets).toEqual(['wss://studio.example' + mount + 'api/remote.mux'])
    expect(scripts).toEqual(['https://studio.example' + mount + 'plugins/native.js'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
