import { execFileSync } from 'child_process'

function commandsOnPath(command: string): string[] {
  if (process.platform !== 'win32') return [command]
  try {
    return execFileSync('where.exe', [command], {
      encoding: 'utf-8',
      windowsHide: true,
    }).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export function resolveTestPython(requiredModules: string[] = []): string {
  const candidates = [
    process.env.HERMES_TEST_PYTHON,
    process.env.PYTHON,
    ...commandsOnPath('python3'),
    ...commandsOnPath('python'),
    ...(process.platform === 'win32' ? [] : ['python3', 'python']),
  ].filter((value): value is string => Boolean(value?.trim()))

  for (const candidate of [...new Set(candidates)]) {
    try {
      execFileSync(candidate, ['-c', requiredModules.map(name => `import ${name}`).join('; ') || 'pass'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      return candidate
    } catch {}
  }

  const requirement = requiredModules.length ? ` with ${requiredModules.join(', ')}` : ''
  throw new Error(`No Python runtime${requirement} is available for tests`)
}

export function resolveBridgeTestPython(): string {
  return resolveTestPython(['zmq'])
}
