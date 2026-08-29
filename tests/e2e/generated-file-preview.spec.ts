import { expect, test } from '@playwright/test'
import AdmZip from 'adm-zip'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const sessionId = 'session-generated-preview'
const sessionWorkspace = '/tmp/session-generated-preview'
const generatedPath = '/Users/tester/.hermes/workspace/package.json'

const session = {
  id: sessionId,
  profile: 'research',
  source: 'cli',
  model: 'test-model',
  provider: 'test-provider',
  title: 'Generated file preview',
  preview: 'Generated file preview',
  started_at: 1_790_000_000,
  ended_at: null,
  last_active: 1_790_000_100,
  message_count: 1,
  tool_call_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  billing_provider: null,
  estimated_cost_usd: 0,
  actual_cost_usd: null,
  cost_status: '',
  workspace: sessionWorkspace,
}

function createXlsxFixture(): Buffer {
  const zip = new AdmZip()
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    </Types>`))
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`))
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Sales Data" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`))
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`))
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>Product</t></is></c><c r="B1" t="inlineStr"><is><t>Revenue</t></is></c></row>
        <row r="2"><c r="A2" t="inlineStr"><is><t>Hermes</t></is></c><c r="B2"><v>100</v></c></row>
      </sheetData>
    </worksheet>`))
  return zip.toBuffer()
}

function createDocxFixture(): Buffer {
  const zip = new AdmZip()
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`))
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`))
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>Hermes DOCX Preview</w:t></w:r></w:p>
        <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
      </w:body>
    </w:document>`))
  return zip.toBuffer()
}

function createPptxFixture(): Buffer {
  const zip = new AdmZip()
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
      <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
    </Types>`))
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
    </Relationships>`))
  zip.addFile('ppt/presentation.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
      <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
      <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
      <p:notesSz cx="6858000" cy="9144000"/>
    </p:presentation>`))
  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
    </Relationships>`))
  zip.addFile('ppt/slides/slide1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
      <p:cSld><p:spTree>
        <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="914400" y="1371600"/><a:ext cx="7315200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
          <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"/><a:t>Hermes PPTX Preview</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody>
        </p:sp>
      </p:spTree></p:cSld>
      <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
    </p:sld>`))
  return zip.toBuffer()
}

function createPdfFixture(): Buffer {
  const contentStream = 'BT /F1 18 Tf 40 80 Td (Hermes PDF Preview) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(contentStream)} >>\nstream\n${contentStream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body)
}

test('opens a Profile-generated package.json even when the session has no explicit workspace', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(({ id, path }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [id]: {
        session_id: id,
        messages: [{
          id: 1,
          session_id: id,
          role: 'assistant',
          content: `[package.json](${path})`,
          timestamp: 1_790_000_001,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        }],
        isWorking: false,
        events: [],
      },
    }
  }, { id: sessionId, path: generatedPath })

  const api = await mockHermesApi(page, { sessions: [{ ...session, workspace: null }] })
  let previewRequestUrl = ''
  let previewAuthorization = ''
  await page.route(`**/api/studio/sessions/${sessionId}/workspace-file/content**`, async route => {
    previewRequestUrl = route.request().url()
    previewAuthorization = route.request().headers().authorization || ''
    await route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: '{"name":"generated-preview"}\n',
    })
  })
  await mockChatSocket(page)

  await page.goto(`/#/hermes/session/${sessionId}`)
  const fileCard = page.locator('.markdown-file-card', { hasText: 'package.json' })
  await expect(fileCard).toBeVisible()
  await fileCard.click()

  const toolPanel = page.locator('.chat-tool-panel')
  await expect(toolPanel.locator('.file-preview')).toBeVisible()
  await expect(toolPanel.locator('.preview-filename')).toHaveText(generatedPath)
  await expect(toolPanel.locator('.preview-code')).toContainText('generated-preview')
  await expect(toolPanel.locator('.chat-tool-tabs')).toHaveCount(1)

  const requestUrl = new URL(previewRequestUrl)
  expect(requestUrl.searchParams.get('path')).toBe(generatedPath)
  expect(requestUrl.searchParams.get('text')).toBe('1')
  expect(previewAuthorization).toBe(`Bearer ${TEST_ACCESS_KEY}`)

  await toolPanel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(toolPanel.locator('.file-preview')).toHaveCount(0)
  await expect(toolPanel.locator('.files-tree-panel')).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('HTML source mode remains scrollable while its scrollbar is hidden', async ({ page }) => {
  const htmlPath = `${sessionWorkspace}/long-preview.html`
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(({ id, path }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [id]: {
        session_id: id,
        messages: [{
          id: 1,
          session_id: id,
          role: 'assistant',
          content: `[long-preview.html](${path})`,
          timestamp: 1_790_000_001,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        }],
        isWorking: false,
        events: [],
      },
    }
  }, { id: sessionId, path: htmlPath })

  const api = await mockHermesApi(page, { sessions: [session] })
  const longHtml = `<main>\n${Array.from({ length: 300 }, (_, index) => `  <p>Line ${index + 1}</p>`).join('\n')}\n</main>`
  await page.route(`**/api/studio/sessions/${sessionId}/workspace-file/content**`, route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: longHtml,
  }))
  await mockChatSocket(page)

  await page.goto(`/#/hermes/session/${sessionId}`)
  await page.locator('.markdown-file-card', { hasText: 'long-preview.html' }).click()
  const panel = page.locator('.chat-tool-panel')
  await panel.getByRole('button', { name: 'Source', exact: true }).click()
  const source = panel.locator('.source-view')
  await expect(source).toBeVisible()
  await expect.poll(() => source.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  const scrollState = await source.evaluate(element => {
    element.scrollTop = 240
    return {
      scrollTop: element.scrollTop,
      overflowY: getComputedStyle(element).overflowY,
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
    }
  })
  expect(scrollState.scrollTop).toBeGreaterThan(0)
  expect(scrollState.overflowY).toBe('auto')
  expect(scrollState.scrollbarWidth).toBe('none')
  expect(api.unexpectedRequests).toEqual([])
})

test('XLSX preview parses workbook sheets inside the isolated worker', async ({ page }) => {
  const workbookPath = `${sessionWorkspace}/sales.xlsx`
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(({ id, path }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [id]: {
        session_id: id,
        messages: [{
          id: 1,
          session_id: id,
          role: 'assistant',
          content: `[sales.xlsx](${path})`,
          timestamp: 1_790_000_001,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        }],
        isWorking: false,
        events: [],
      },
    }
  }, { id: sessionId, path: workbookPath })

  const api = await mockHermesApi(page, { sessions: [session] })
  await page.route(`**/api/studio/sessions/${sessionId}/workspace-file/content**`, route => route.fulfill({
    status: 200,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: createXlsxFixture(),
  }))
  await mockChatSocket(page)

  await page.goto(`/#/hermes/session/${sessionId}`)
  await page.locator('.markdown-file-card', { hasText: 'sales.xlsx' }).click()
  const panel = page.locator('.chat-tool-panel')
  await expect(panel.getByRole('button', { name: 'Sales Data', exact: true })).toBeVisible()
  await expect(panel.locator('.n-data-table')).toContainText('Product')
  await expect(panel.locator('.n-data-table')).toContainText('Hermes')
  await expect(panel.locator('.n-data-table')).toContainText('100')
  expect(api.unexpectedRequests).toEqual([])
})

test('DOCX, PDF, and PPTX lazy renderers open safely and cleanly replace one another', async ({ page }) => {
  const docxPath = `${sessionWorkspace}/brief.docx`
  const pdfPath = `${sessionWorkspace}/report.pdf`
  const pptxPath = `${sessionWorkspace}/deck.pptx`
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(({ id, docx, pdf, pptx }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [id]: {
        session_id: id,
        messages: [{
          id: 1,
          session_id: id,
          role: 'assistant',
          content: `[brief.docx](${docx})\n\n[report.pdf](${pdf})\n\n[deck.pptx](${pptx})`,
          timestamp: 1_790_000_001,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        }],
        isWorking: false,
        events: [],
      },
    }
  }, { id: sessionId, docx: docxPath, pdf: pdfPath, pptx: pptxPath })

  const api = await mockHermesApi(page, { sessions: [session] })
  await page.route(`**/api/studio/sessions/${sessionId}/workspace-file/content**`, route => {
    const path = new URL(route.request().url()).searchParams.get('path') || ''
    if (path.endsWith('.docx')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        body: createDocxFixture(),
      })
    }
    if (path.endsWith('.pptx')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        body: createPptxFixture(),
      })
    }
    return route.fulfill({ status: 200, contentType: 'application/pdf', body: createPdfFixture() })
  })
  await mockChatSocket(page)

  await page.goto(`/#/hermes/session/${sessionId}`)
  await page.locator('.markdown-file-card', { hasText: 'brief.docx' }).click()
  const panel = page.locator('.chat-tool-panel')
  await expect(panel.locator('.docx-container')).toContainText('Hermes DOCX Preview')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(panel.locator('.file-preview')).toHaveCount(0)
  await expect(panel.locator('.files-tree-panel')).toBeVisible()

  await page.locator('.markdown-file-card', { hasText: 'report.pdf' }).click()
  const canvas = page.locator('.chat-tool-panel .pdf-stage canvas')
  await expect(canvas).toBeVisible()
  await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).width)).toBeGreaterThan(0)
  await page.locator('.chat-tool-panel').getByRole('button', { name: 'Close', exact: true }).click()

  await page.locator('.markdown-file-card', { hasText: 'deck.pptx' }).click()
  await expect(page.locator('.chat-tool-panel .pptx-renderer-host')).toContainText('Hermes PPTX Preview')
  expect(api.unexpectedRequests).toEqual([])
})
