function closingQuoteIndex(value: string, quote: "'" | '"'): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) continue
    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
      backslashes += 1
    }
    if (backslashes % 2 === 0) return index
  }
  return -1
}

function parseDotenvRawValue(rawValue: string): string {
  const value = rawValue.trim()
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const closingIndex = closingQuoteIndex(value, quote)
    if (closingIndex !== -1) return value.slice(1, closingIndex)
    return value
  }

  const commentMatch = value.match(/\s+#/)
  return (commentMatch ? value.slice(0, commentMatch.index) : value).trimEnd()
}

/** Read one key from dotenv text without mutating process.env. */
export function parseDotenvValue(envContent: string, key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return ''

  for (const rawLine of envContent.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (/^export\s+/.test(line)) line = line.replace(/^export\s+/, '')

    const equalsIndex = line.indexOf('=')
    if (equalsIndex === -1 || line.slice(0, equalsIndex).trim() !== key) continue
    return parseDotenvRawValue(line.slice(equalsIndex + 1))
  }

  return ''
}
