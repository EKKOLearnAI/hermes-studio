const MERMAID_LANGUAGE = 'mermaid'

export const MERMAID_MAX_DIAGRAMS_PER_MESSAGE = 4
export const MERMAID_MAX_SOURCE_LENGTH = 20_000
export const MERMAID_RENDER_TIMEOUT_MS = 5_000
export const SUPPORT_PREVIEW_FILE_TYPES = ['txt', 'md', 'json', 'csv', 'log', 'py', 'yaml', 'yml', 'toml', 'sh', 'xml', 'html', 'css', 'js', 'ts', 'rs', 'go', 'java', 'c', 'cpp', 'h']
      
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function getFenceLanguage(info: string | undefined): string {
  return info?.trim().split(/\s+/)[0]?.toLowerCase() || ''
}

export function isMermaidFence(info: string | undefined): boolean {
  return getFenceLanguage(info) === MERMAID_LANGUAGE
}

export function encodeMermaidSource(source: string): string {
  return encodeURIComponent(source)
}

export function decodeMermaidSource(encoded: string | null | undefined): string {
  if (!encoded) return ''

  try {
    return decodeURIComponent(encoded)
  } catch {
    return ''
  }
}

export function renderMermaidPlaceholder(source: string): string {
  return [
    '<div class="mermaid-diagram" data-mermaid-pending="true"',
    ` data-mermaid-source="${escapeHtml(encodeMermaidSource(source))}">`,
    '<div class="mermaid-loading">Rendering Mermaid diagram…</div>',
    '</div>',
  ].join('')
}
