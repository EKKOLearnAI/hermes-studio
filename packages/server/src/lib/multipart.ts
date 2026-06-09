export class MultipartParseError extends Error {}

export function parseMultipartBoundary(contentType: string): Buffer | null {
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i)
  const boundary = (match?.[1] || match?.[2] || '').trim()
  return boundary ? Buffer.from(`--${boundary}`) : null
}

export function splitMultipart(raw: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundary, start)
    if (idx === -1) break
    if (start > 0) {
      parts.push(raw.subarray(start + 2, idx))
    }
    start = idx + boundary.length
  }
  return parts
}

export function parseMultipartFilename(header: string): string | null {
  const disposition = header.match(/Content-Disposition:\s*form-data;([^\r\n]*)/i)?.[1]
  if (!disposition) return null

  const encodedFilename = disposition.match(/(?:^|;)\s*filename\*\s*=\s*([^;\r\n]+)/i)?.[1]
  if (encodedFilename) {
    const value = encodedFilename.trim().replace(/^"|"$/g, '')
    const utf8Match = value.match(/^UTF-8''(.+)$/i)
    if (!utf8Match) return null

    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      throw new MultipartParseError('Malformed multipart filename')
    }
  }

  return disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1] ?? null
}
