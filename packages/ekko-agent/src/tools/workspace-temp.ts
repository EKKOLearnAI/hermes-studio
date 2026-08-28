import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentToolContext } from './types'

export const EKKO_WORKSPACE_TEMP_DIRECTORY = '.ekko-tmp'

/**
 * Prefer a session-owned temporary directory so files created by commands can
 * be inspected by workspace-scoped file tools. The system temp directory is a
 * compatibility fallback for hosts that do not provide a workspace.
 */
export function workspaceTempRoot(context: Pick<AgentToolContext, 'workspaceRoot' | 'cwd'> = {}): string {
  const workspaceRoot = String(context.workspaceRoot || '').trim()
  if (workspaceRoot) return join(resolve(workspaceRoot), EKKO_WORKSPACE_TEMP_DIRECTORY)
  const cwd = String(context.cwd || '').trim()
  if (cwd) return join(resolve(cwd), EKKO_WORKSPACE_TEMP_DIRECTORY)
  return join(tmpdir(), 'ekko-agent')
}

export async function ensureWorkspaceTempRoot(
  context: Pick<AgentToolContext, 'workspaceRoot' | 'cwd'> = {},
): Promise<string> {
  const directory = workspaceTempRoot(context)
  await mkdir(directory, { recursive: true })
  return directory
}

export function workspaceTempEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
  }
}

export function workspaceToolAssetDirectory(
  context: Pick<AgentToolContext, 'workspaceRoot' | 'cwd'> = {},
): string {
  return join(workspaceTempRoot(context), 'tool-assets')
}
