import { readFile } from 'fs/promises'
import { join } from 'path'

const HEAD_TAG_RE = /<head(\s[^>]*)?>/i
const BASE_TAG_RE = /<base\b[^>]*href=(['"])(.*?)\1[^>]*>/i

function normalizeBaseHref(baseHref: string): string {
  const trimmed = baseHref.trim() || '/'
  if (!trimmed.startsWith('/')) {
    return `/${trimmed.replace(/^\.\/?/, '').replace(/^\/?/, '')}`.replace(/\/+/g, '/')
  }
  return trimmed
}

export function injectBaseHref(html: string, baseHref: string): string {
  const normalized = normalizeBaseHref(baseHref)
  const baseTag = `<base href="${normalized.endsWith('/') ? normalized : `${normalized}/`}">`

  if (BASE_TAG_RE.test(html)) {
    return html.replace(BASE_TAG_RE, baseTag)
  }

  if (HEAD_TAG_RE.test(html)) {
    return html.replace(HEAD_TAG_RE, match => `${match}\n  ${baseTag}`)
  }

  return `${baseTag}\n${html}`
}

export async function readSpaShell(root: string, baseHref: string): Promise<string> {
  const html = await readFile(join(root, 'index.html'), 'utf-8')
  return injectBaseHref(html, baseHref)
}

export function buildUnavailablePreviewHtml(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <main style="font-family: system-ui, sans-serif; padding: 24px; max-width: 42rem; margin: 0 auto;">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
