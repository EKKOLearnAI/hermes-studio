export function normalizeLegacyRoutePath(rawLocation: string): string | null {
  const value = rawLocation.trim()
  if (!value) return null

  const hashless = value.startsWith('#') ? value.slice(1) : value
  const [pathPart, queryString = ''] = hashless.split('?')
  if (!pathPart.startsWith('/hermes')) return null

  let targetPath: string
  if (pathPart === '/hermes/chat') {
    targetPath = '/session/new'
  } else if (pathPart.startsWith('/hermes/session/')) {
    targetPath = `/session/${pathPart.slice('/hermes/session/'.length)}`
  } else if (pathPart === '/hermes' || pathPart === '/hermes/') {
    targetPath = '/'
  } else {
    targetPath = pathPart.slice('/hermes'.length) || '/'
  }

  return queryString ? `${targetPath}?${queryString}` : targetPath
}
