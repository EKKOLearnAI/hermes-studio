import type { AgentBridgeBrowserResponse } from '../agent-bridge'
import { getBridgeClient } from '../mcp'

export interface ProfileBrowserNavigateInput {
  workflowId: string
  profile: string
  url: string
  timeoutMs?: number
}

export interface ProfileBrowserSnapshotInput {
  workflowId: string
  profile: string
  timeoutMs?: number
}

/** Server-internal browser boundary. No controller exposes these primitives. */
export function navigateProfileBrowser(input: ProfileBrowserNavigateInput): Promise<AgentBridgeBrowserResponse> {
  return getBridgeClient().browserNavigate(input.workflowId, input.url, input.profile, input.timeoutMs)
}

/** Captures only the compact accessibility snapshot for the workflow-bound browser session. */
export function snapshotProfileBrowser(input: ProfileBrowserSnapshotInput): Promise<AgentBridgeBrowserResponse> {
  return getBridgeClient().browserSnapshot(input.workflowId, input.profile, input.timeoutMs)
}
