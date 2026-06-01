import { AURORA_TOOLS } from './tool-definitions'
import type { AuroraTool, AuroraToolExecution } from './tool-types'

export type {
  AuroraTool,
  AuroraToolContext,
  AuroraToolExecution,
  AuroraToolSecurityLevel,
  GeneratedWidgetListResult,
  GeneratedWidgetLoadResult,
  LegacyAppOpenResult,
} from './tool-types'

export {
  CreatePaperJournalTool,
  CreateTaskTool,
  GenerateLifeOSBriefingTool,
  ListGeneratedWidgetsTool,
  ListTasksTool,
  LoadGeneratedWidgetTool,
  MiroFishDebateTool,
  OpenHermesAppTool,
  OpenVideoStudioTool,
  OpenMiroFishGraphTool,
  ProposeMemoryTool,
  RunMiroFishTool,
  RunQuantPhaseCheckTool,
  SearchMemoryTool,
  ViewLifeOSTool,
  ViewQuantLabTool,
} from './tool-definitions'

export const ToolRegistry = {
  all(): AuroraTool[] {
    return AURORA_TOOLS
  },

  findForInput(input: string): AuroraToolExecution | null {
    const context = { input }
    for (const tool of AURORA_TOOLS) {
      if (!tool.canHandle(context)) continue
      return tool.prepare(context)
    }
    return null
  },

  get(id: string): AuroraTool | undefined {
    return AURORA_TOOLS.find(tool => tool.id === id)
  },
}
