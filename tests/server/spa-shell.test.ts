import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { buildUnavailablePreviewHtml, injectBaseHref, readSpaShell } from '../../packages/server/src/services/spa-shell'

describe('spa shell helpers', () => {
  it('injects a base href into shell HTML', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'

    expect(injectBaseHref(html, '/preview/abc/')).toContain('<base href="/preview/abc/">')
  })

  it('replaces an existing base tag when present', () => {
    const html = '<html><head><base href="/old/"><meta charset="utf-8"></head><body></body></html>'

    expect(injectBaseHref(html, '/')).toContain('<base href="/">')
    expect(injectBaseHref(html, '/')).not.toContain('/old/')
  })

  it('reads the built shell and injects the requested base href', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spa-shell-'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'index.html'), '<html><head><title>Test</title></head><body></body></html>')

    const html = await readSpaShell(root, '/preview/demo/')

    expect(html).toContain('<base href="/preview/demo/">')
    expect(html).toContain('<title>Test</title>')
  })

  it('renders a controlled unavailable preview page', () => {
    const html = buildUnavailablePreviewHtml('Preview demo', 'Preview is unavailable.')

    expect(html).toContain('Preview demo')
    expect(html).toContain('Preview is unavailable.')
  })
})
