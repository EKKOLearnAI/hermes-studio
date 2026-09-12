import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/** DSH runtime policy and composition must not become shared agent behavior. */
export function dshModuleViolations(filename, source) {
  const file = filename.replaceAll('\\', '/')
  if (file.includes('/services/dsh/')) {
    return /from ['"](?:\.\.\/index|\.\.)['"]/.test(source)
      ? [`${file}: DSH services must receive platform helpers instead of importing the agent registry`] : []
  }
  const failures = []
  for (const token of ['DSH_PERMISSION_MODE', 'studio-web-acp', '@deepseek-ai/dsh-web-app', 'writeDshAcpAdapter', 'prepareDshWebProfile', 'new DshAcpTurn(']) {
    if (source.includes(token)) failures.push(`${file}: ${token} belongs in coding-agents/services/dsh`)
  }
  if (/function\s+(?:executeDshPluginCommand|getNativeDshPluginInventory)\s*\(/.test(source)) failures.push(`${file}: implement DSH plugin operations inside services/dsh; registry wiring may only delegate`)
  return failures
}

export async function checkDshModuleBoundaries(root) {
  const failures = []
  async function visit(directory) {
    for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${item.name}`
      if (item.isDirectory()) await visit(file)
      else if (item.name.endsWith('.ts')) failures.push(...dshModuleViolations(file, await readFile(path.join(root, file), 'utf8')))
    }
  }
  await visit('packages/server/src')
  return failures
}
