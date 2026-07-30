// @vitest-environment jsdom
import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import HtmlFilePreview from '@/components/hermes/files/HtmlFilePreview.vue'
import {
  getFilePreviewKind,
  previewMimeMatches,
} from '@/utils/hermes/file-preview'
import { getLanguageFromPath } from '@/stores/hermes/files'
import {
  MAX_CELL_CHARACTERS,
  MAX_TABLE_CELLS,
  limitTabularRows,
  parseCsvPreview,
} from '@/utils/hermes/tabular-preview'
import { assertBoundedOoxmlArchive } from '@/utils/hermes/ooxml-archive'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButtonGroup: { template: '<div class="button-group"><slot /></div>' },
  NButton: {
    emits: ['click'],
    template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
  },
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

describe('generated file preview formats', () => {
  function zipDirectoryFixture(uncompressedBytes: number): ArrayBuffer {
    const buffer = new ArrayBuffer(46 + 22)
    const view = new DataView(buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint32(24, uncompressedBytes, true)
    view.setUint32(46, 0x06054b50, true)
    view.setUint16(54, 1, true)
    view.setUint16(56, 1, true)
    view.setUint32(58, 46, true)
    view.setUint32(62, 0, true)
    return buffer
  }

  it('maps supported extensions to dedicated renderers and validates MIME types', () => {
    expect(getFilePreviewKind('package.json')).toBe('text')
    expect(getLanguageFromPath('package.json')).toBe('json')
    expect(getFilePreviewKind('src/main.rs')).toBe('text')
    expect(getLanguageFromPath('src/main.rs')).toBe('rust')
    expect(getFilePreviewKind('infra/main.tf')).toBe('text')
    expect(getLanguageFromPath('infra/main.tf')).toBe('hcl')
    expect(getFilePreviewKind('scripts/release.ps1')).toBe('text')
    expect(getLanguageFromPath('scripts/release.ps1')).toBe('powershell')
    expect(getFilePreviewKind('templates/page.twig')).toBe('text')
    expect(getLanguageFromPath('templates/page.twig')).toBe('twig')
    expect(getFilePreviewKind('Dockerfile.production')).toBe('text')
    expect(getLanguageFromPath('Dockerfile.production')).toBe('dockerfile')
    expect(getFilePreviewKind('.prettierrc')).toBe('text')
    expect(getLanguageFromPath('.prettierrc')).toBe('json')
    expect(getFilePreviewKind('page.html')).toBe('html')
    expect(getFilePreviewKind('report.pdf')).toBe('pdf')
    expect(getFilePreviewKind('brief.docx')).toBe('docx')
    expect(getFilePreviewKind('deck.pptx')).toBe('presentation')
    expect(getFilePreviewKind('metrics.xlsx')).toBe('spreadsheet')
    expect(getFilePreviewKind('metrics.csv')).toBe('csv')
    expect(getFilePreviewKind('legacy.xls')).toBeNull()
    expect(previewMimeMatches('pdf', 'application/pdf')).toBe(true)
    expect(previewMimeMatches('pdf', 'text/html')).toBe(false)
    expect(previewMimeMatches('presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(true)
    expect(previewMimeMatches('csv', 'text/csv; charset=utf-8')).toBe(true)
  })

  it('renders HTML in a restrictive iframe and strips active content and URLs', async () => {
    const wrapper = mount(HtmlFilePreview, {
      props: {
        content: [
          '<html><head><meta http-equiv="refresh" content="0; url=https://evil.test"></head>',
          '<body onload="steal()"><script>steal()</script><form action="https://evil.test"></form>',
          '<a href="https://evil.test">leave</a><img src="https://evil.test/pixel.png" onerror="steal()">',
          '<img src="data:image/png;base64,AAAA"></body></html>',
        ].join(''),
      },
    })

    const iframe = wrapper.get('iframe')
    expect(iframe.attributes('sandbox')).toBe('')
    expect(iframe.attributes('allow')).toBeUndefined()
    expect(iframe.attributes('referrerpolicy')).toBe('no-referrer')

    const srcdoc = iframe.attributes('srcdoc') || ''
    const parsed = new DOMParser().parseFromString(srcdoc, 'text/html')
    const csp = parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')
    expect(csp?.getAttribute('content')).toContain("default-src 'none'")
    expect(parsed.querySelector('script')).toBeNull()
    expect(parsed.querySelector('form')).toBeNull()
    expect(parsed.querySelector('[onload], [onerror]')).toBeNull()
    expect(parsed.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(parsed.querySelectorAll('img')[0]?.hasAttribute('src')).toBe(false)
    expect(parsed.querySelectorAll('img')[1]?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(parsed.querySelector('style')?.textContent).toContain('scrollbar-width: none')

    await wrapper.findAll('button')[1].trigger('click')
    expect(wrapper.find('.source-view code.hljs').exists()).toBe(true)
    expect(wrapper.find('.source-view').html()).toContain('hljs-tag')
  })

  it('lets the HTML preview fill the available drawer height', () => {
    const htmlPreviewSource = readFileSync('packages/client/src/components/hermes/files/HtmlFilePreview.vue', 'utf8')
    const filePreviewSource = readFileSync('packages/client/src/components/hermes/files/FilePreview.vue', 'utf8')

    expect(htmlPreviewSource).toMatch(/\.html-preview\s*\{[\s\S]*flex: 1;[\s\S]*height: 100%;[\s\S]*min-height: 0;/)
    expect(htmlPreviewSource).toMatch(/\.html-frame\s*\{[\s\S]*flex: 1;[\s\S]*height: 100%;[\s\S]*min-height: 0;/)
    expect(htmlPreviewSource).not.toContain('min-height: 420px')
    expect(filePreviewSource).toMatch(/\.file-preview\s*\{[\s\S]*height: 100%;[\s\S]*min-height: 0;/)
    expect(filePreviewSource).toMatch(/\.preview-content\s*\{[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*min-height: 0;/)
  })

  it('parses quoted CSV cells and enforces table and cell limits', () => {
    expect(parseCsvPreview('name,notes\nAda,"hello, world"\nBob,"line 1\nline 2"').rows).toEqual([
      ['name', 'notes'],
      ['Ada', 'hello, world'],
      ['Bob', 'line 1\nline 2'],
    ])

    const oversizedRows = Array.from({ length: MAX_TABLE_CELLS + 1 }, (_, index) => [index])
    const limited = limitTabularRows(oversizedRows)
    expect(limited.truncated).toBe(true)
    expect(limited.rows.length).toBeLessThanOrEqual(1_000)

    const longCell = limitTabularRows([['x'.repeat(MAX_CELL_CHARACTERS + 10)]])
    expect(longCell.truncated).toBe(true)
    expect(longCell.rows[0][0]).toHaveLength(MAX_CELL_CHARACTERS + 1)
  })

  it('rejects OOXML archives whose expanded entries exceed preview limits', () => {
    expect(() => assertBoundedOoxmlArchive(zipDirectoryFixture(1_024))).not.toThrow()
    expect(() => assertBoundedOoxmlArchive(zipDirectoryFixture(65 * 1024 * 1024))).toThrow(/not safe to preview/)
    expect(() => assertBoundedOoxmlArchive(new ArrayBuffer(22))).toThrow(/ZIP directory is missing/)
  })
})
