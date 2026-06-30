import path from 'node:path'
import { AgentToolError } from './types'

export function resolveToolPath(inputPath: string, context: { cwd?: string; workspaceRoot?: string } = {}): string {
  const base = context.cwd || context.workspaceRoot || process.cwd()
  const resolved = path.resolve(base, inputPath)

  if (context.workspaceRoot) {
    const root = path.resolve(context.workspaceRoot)
    const relative = path.relative(root, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AgentToolError(`Path is outside workspaceRoot: ${inputPath}`, 'PATH_OUTSIDE_WORKSPACE')
    }
  }

  return resolved
}
