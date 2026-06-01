import {
  createQuantPaperJournalEntry,
  createLegacyKanbanTask,
  generateLifeOsTacticalBriefing,
  queryLegacyKanbanTasks,
  readLifeOsOverview,
  readQuantTop10,
  runQuantPhaseCheck,
  searchLegacyMemory,
} from './legacy-adapters'
import { useMemoryQueueStore, type CandidateMemory } from '@/stores/hermes/memory-queue'
import { listGeneratedWidgets } from './generated-widgets'
import { fetchGeneratedWidgetManifest } from '@/api/aurora/generated-widgets'
import {
  extractRequestedGeneratedWidgetName,
  isCreateTaskIntent,
  isGeneratedWidgetListIntent,
  isLifeOsBriefingIntent,
  isLifeOsViewIntent,
  isMiroFishGraphIntent,
  isMemoryQuery,
  isProposeMemoryIntent,
  isQuantPaperJournalIntent,
  isQuantPhaseCheckIntent,
  isQuantViewIntent,
  isTaskQuery,
  isVideoCreationIntent,
  parseCreateTask,
  parseBrowserOpenIntent,
  extractVideoCreationBrief,
  parseLegacyAppOpenIntent,
  parseMemoryProposal,
  parseMiroFishDebateIntent,
  parseQuantPaperJournal,
  resolveMiroFishInitialView,
} from './intent-parsers'
import type {
  AuroraTool,
  GeneratedWidgetListResult,
  GeneratedWidgetLoadResult,
  LegacyAppOpenResult,
} from './tool-types'

export const ListTasksTool: AuroraTool<Awaited<ReturnType<typeof queryLegacyKanbanTasks>>> = {
  id: 'legacy.kanban.listTasks',
  name: 'ListTasksTool',
  description: 'Read current tasks from the legacy Kanban backend.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => isTaskQuery(input),
  prepare: ({ input }) => ({
    toolId: 'legacy.kanban.listTasks',
    toolName: 'ListTasksTool',
    securityLevel: 'L1_ReadOnly',
    args: { query: input, today: true },
    execute: () => queryLegacyKanbanTasks({ today: true }),
  }),
}

export const ViewLifeOSTool: AuroraTool<Awaited<ReturnType<typeof readLifeOsOverview>>> = {
  id: 'lifeos.viewState',
  name: 'ViewLifeOSTool',
  description: 'View LifeOS financial, FIRE, budget, and portfolio dashboard through Aurora.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => isLifeOsViewIntent(input),
  prepare: ({ input }) => ({
    toolId: 'lifeos.viewState',
    toolName: 'ViewLifeOSTool',
    securityLevel: 'L1_ReadOnly',
    args: { query: input },
    execute: () => readLifeOsOverview(),
  }),
}

export const GenerateLifeOSBriefingTool: AuroraTool<Awaited<ReturnType<typeof generateLifeOsTacticalBriefing>>> = {
  id: 'lifeos.generateBriefing',
  name: 'GenerateLifeOSBriefingTool',
  description: 'Generate a LifeOS tactical briefing through the existing backend.',
  securityLevel: 'L3_Approval',
  canHandle: ({ input }) => isLifeOsBriefingIntent(input),
  prepare: ({ input }) => ({
    toolId: 'lifeos.generateBriefing',
    toolName: 'GenerateLifeOSBriefingTool',
    securityLevel: 'L3_Approval',
    args: { query: input },
    execute: () => generateLifeOsTacticalBriefing(),
  }),
}

export const ViewQuantLabTool: AuroraTool<Awaited<ReturnType<typeof readQuantTop10>>> = {
  id: 'quant.viewLab',
  name: 'ViewQuantLabTool',
  description: 'View Quant Lab snapshot, Top 10 candidates, and paper trading state through Aurora.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => isQuantViewIntent(input),
  prepare: ({ input }) => ({
    toolId: 'quant.viewLab',
    toolName: 'ViewQuantLabTool',
    securityLevel: 'L1_ReadOnly',
    args: { query: input },
    execute: () => readQuantTop10(),
  }),
}

export const RunQuantPhaseCheckTool: AuroraTool<Awaited<ReturnType<typeof runQuantPhaseCheck>>> = {
  id: 'quant.phaseCheck',
  name: 'RunQuantPhaseCheckTool',
  description: 'Run the Quant Lab phase validation report without creating files.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => isQuantPhaseCheckIntent(input),
  prepare: ({ input }) => ({
    toolId: 'quant.phaseCheck',
    toolName: 'RunQuantPhaseCheckTool',
    securityLevel: 'L1_ReadOnly',
    args: { query: input, ensure: false },
    execute: () => runQuantPhaseCheck(),
  }),
}

export const MiroFishDebateTool: AuroraTool<LegacyAppOpenResult> = {
  id: 'quant.mirofish.run',
  name: 'MiroFishDebateTool',
  description: 'Open the merged MiroFish cosmic graph, debate arena, and final verdict inside Aurora App Mode.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => parseMiroFishDebateIntent(input) !== null,
  prepare: ({ input }) => {
    const intent = parseMiroFishDebateIntent(input)
    if (!intent) return null
    const initialView = resolveMiroFishInitialView(input)
    const launchContext = intent.targetTicker || intent.topic
      ? {
          source: 'aurora-omnibar',
          ...(intent.targetTicker ? { targetTicker: intent.targetTicker } : {}),
          ...(intent.topic ? { topic: intent.topic } : {}),
        }
      : null
    return {
      toolId: 'quant.mirofish.run',
      toolName: 'MiroFishDebateTool',
      securityLevel: 'L1_ReadOnly',
      args: {
        query: input,
        kind: 'mirofish',
        phase: 'premarket',
        submitBackend: false,
        initialView,
        ...(intent.targetTicker ? { targetTicker: intent.targetTicker } : {}),
        ...(intent.topic ? { topic: intent.topic } : {}),
      },
      execute: async () => ({
        kind: 'mirofish',
        query: input,
        requestedAt: new Date().toISOString(),
        payload: {
          projectId: 'preview-project',
          graphPath: '/process/preview-project',
          query: input,
          initialView,
          ...(launchContext ? { launchContext } : {}),
        },
      }),
    }
  },
}

export const RunMiroFishTool = MiroFishDebateTool

export const OpenMiroFishGraphTool: AuroraTool<LegacyAppOpenResult> = {
  id: 'quant.mirofish.graph.open',
  name: 'OpenMiroFishGraphTool',
  description: 'Open the MiroFish knowledge graph visualization inside Aurora App Mode.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => isMiroFishGraphIntent(input),
  prepare: ({ input }) => ({
    toolId: 'quant.mirofish.graph.open',
    toolName: 'OpenMiroFishGraphTool',
    securityLevel: 'L1_ReadOnly',
    args: {
      query: input,
      kind: 'mirofish-graph',
    },
    execute: async () => ({
      kind: 'mirofish-graph',
      query: input,
      requestedAt: new Date().toISOString(),
      payload: {
        projectId: 'preview-project',
      },
    }),
  }),
}

export const OpenBrowserTool: AuroraTool<LegacyAppOpenResult> = {
  id: 'aurora.browser.open',
  name: 'OpenBrowserTool',
  description: 'Open a URL in the Aurora Web Sandbox App Mode.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => parseBrowserOpenIntent(input) !== null,
  prepare: ({ input }) => {
    const url = parseBrowserOpenIntent(input)
    if (!url) return null
    return {
      toolId: 'aurora.browser.open',
      toolName: 'OpenBrowserTool',
      securityLevel: 'L1_ReadOnly',
      args: {
        query: input,
        kind: 'browser',
        url,
      },
      execute: async () => ({
        kind: 'browser',
        query: input,
        requestedAt: new Date().toISOString(),
        payload: {
          initialUrl: url,
          source: 'aurora-omnibar',
        },
      }),
    }
  },
}

export const OpenVideoStudioTool: AuroraTool<LegacyAppOpenResult> = {
  id: 'aurora.videoStudio.open',
  name: 'OpenVideoStudioTool',
  description: 'Open Aurora Video Studio for storyboard and AI video prompt preparation without leaving the app.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => isVideoCreationIntent(input),
  prepare: ({ input }) => {
    const brief = extractVideoCreationBrief(input)
    return {
      toolId: 'aurora.videoStudio.open',
      toolName: 'OpenVideoStudioTool',
      securityLevel: 'L1_ReadOnly',
      args: {
        query: input,
        kind: 'video-studio',
        initialPrompt: brief,
      },
      execute: async () => ({
        kind: 'video-studio',
        query: input,
        requestedAt: new Date().toISOString(),
        payload: {
          initialPrompt: brief,
          source: 'aurora-omnibar',
        },
      }),
    }
  },
}

export const OpenHermesAppTool: AuroraTool<LegacyAppOpenResult> = {
  id: 'aurora.legacyApp.open',
  name: 'OpenHermesAppTool',
  description: 'Open a legacy Hermes workspace view inside Aurora App Mode without showing the sidebar.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => parseLegacyAppOpenIntent(input) !== null,
  prepare: ({ input }) => {
    const kind = parseLegacyAppOpenIntent(input)
    if (!kind) return null
    return {
      toolId: 'aurora.legacyApp.open',
      toolName: 'OpenHermesAppTool',
      securityLevel: 'L1_ReadOnly',
      args: { query: input, kind },
      execute: async () => ({
        kind,
        query: input,
        requestedAt: new Date().toISOString(),
      }),
    }
  },
}

export const CreatePaperJournalTool: AuroraTool<Awaited<ReturnType<typeof createQuantPaperJournalEntry>>> = {
  id: 'quant.paperJournal.create',
  name: 'CreatePaperJournalTool',
  description: 'Append a paper trading journal entry through Quant Lab after approval.',
  securityLevel: 'L3_Approval',
  canHandle: ({ input }) => isQuantPaperJournalIntent(input) && parseQuantPaperJournal(input) !== null,
  prepare: ({ input }) => {
    const request = parseQuantPaperJournal(input)
    if (!request) return null
    return {
      toolId: 'quant.paperJournal.create',
      toolName: 'CreatePaperJournalTool',
      securityLevel: 'L3_Approval',
      args: request,
      execute: () => createQuantPaperJournalEntry(request),
    }
  },
}

export const ListGeneratedWidgetsTool: AuroraTool<GeneratedWidgetListResult> = {
  id: 'aurora.generatedWidget.list',
  name: 'ListGeneratedWidgetsTool',
  description: 'List all safely discoverable generated Vue widgets.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => isGeneratedWidgetListIntent(input),
  prepare: ({ input }) => ({
    toolId: 'aurora.generatedWidget.list',
    toolName: 'ListGeneratedWidgetsTool',
    securityLevel: 'L1_ReadOnly',
    args: { query: input },
    execute: async () => {
      const loadableWidgets = listGeneratedWidgets()
      const loadableNames = new Set(loadableWidgets.map(widget => widget.widgetName))
      const merged = new Map<string, GeneratedWidgetListResult['widgets'][number]>()

      try {
        const manifest = await fetchGeneratedWidgetManifest()
        for (const widget of manifest.widgets) {
          merged.set(widget.widgetName, {
            widgetName: widget.widgetName,
            componentPath: widget.componentPath,
            deployedAt: widget.deployedAt,
            buildId: widget.buildId,
            spec: widget.spec,
            source: widget.source,
            securityStatus: widget.securityStatus,
            permissions: widget.permissions,
            loadable: loadableNames.has(widget.widgetName) && widget.securityStatus === 'passed',
          })
        }

        for (const widget of loadableWidgets) {
          if (merged.has(widget.widgetName)) continue
          merged.set(widget.widgetName, {
            widgetName: widget.widgetName,
            componentPath: widget.componentPath,
            deployedAt: null,
            buildId: null,
            spec: null,
            source: 'bundle',
            securityStatus: 'passed',
            loadable: true,
          })
        }

        return {
          query: input,
          manifestSource: 'backend',
          widgets: [...merged.values()].sort((a, b) => a.widgetName.localeCompare(b.widgetName)),
          generatedAt: manifest.generatedAt,
        }
      } catch {
        return {
          query: input,
          manifestSource: 'bundle-fallback',
          widgets: loadableWidgets.map(({ widgetName, componentPath }) => ({
            widgetName,
            componentPath,
            deployedAt: null,
            buildId: null,
            spec: null,
            source: 'bundle',
            securityStatus: 'passed',
            loadable: true,
          })),
          generatedAt: new Date().toISOString(),
        }
      }
    },
  }),
}

export const LoadGeneratedWidgetTool: AuroraTool<GeneratedWidgetLoadResult> = {
  id: 'aurora.generatedWidget.load',
  name: 'LoadGeneratedWidgetTool',
  description: 'Render a safely generated Vue widget from the components/generated folder.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => extractRequestedGeneratedWidgetName(input) !== null,
  prepare: ({ input }) => {
    const widgetName = extractRequestedGeneratedWidgetName(input)
    if (!widgetName) return null
    return {
      toolId: 'aurora.generatedWidget.load',
      toolName: 'LoadGeneratedWidgetTool',
      securityLevel: 'L1_ReadOnly',
      args: {
        query: input,
        widgetName,
      },
      execute: async () => ({
        widgetName,
        componentPath: `packages/client/src/components/generated/${widgetName}.vue`,
        query: input,
        requestedAt: new Date().toISOString(),
      }),
    }
  },
}

export const SearchMemoryTool: AuroraTool<Awaited<ReturnType<typeof searchLegacyMemory>>> = {
  id: 'legacy.memory.search',
  name: 'SearchMemoryTool',
  description: 'Search the legacy Memory module without modifying it.',
  securityLevel: 'L1_ReadOnly',
  canHandle: ({ input }) => isMemoryQuery(input),
  prepare: ({ input }) => ({
    toolId: 'legacy.memory.search',
    toolName: 'SearchMemoryTool',
    securityLevel: 'L1_ReadOnly',
    args: { query: input },
    execute: () => searchLegacyMemory(input),
  }),
}

export const ProposeMemoryTool: AuroraTool<CandidateMemory> = {
  id: 'aurora.memory.propose',
  name: 'ProposeMemoryTool',
  description: 'Create a candidate memory in the review queue without writing long-term memory.',
  securityLevel: 'L2_Draft',
  canHandle: ({ input }) => isProposeMemoryIntent(input) && parseMemoryProposal(input) !== null,
  prepare: ({ input }) => {
    const proposal = parseMemoryProposal(input)
    if (!proposal) return null
    return {
      toolId: 'aurora.memory.propose',
      toolName: 'ProposeMemoryTool',
      securityLevel: 'L2_Draft',
      args: proposal,
      execute: async () => useMemoryQueueStore().proposeMemory(proposal),
    }
  },
}

export const CreateTaskTool: AuroraTool<Awaited<ReturnType<typeof createLegacyKanbanTask>>> = {
  id: 'legacy.kanban.createTask',
  name: 'CreateTaskTool',
  description: 'Create a task through the legacy Kanban backend after approval.',
  securityLevel: 'L3_Approval',
  canHandle: ({ input }) => isCreateTaskIntent(input) && parseCreateTask(input) !== null,
  prepare: ({ input }) => {
    const task = parseCreateTask(input)
    if (!task) return null
    return {
      toolId: 'legacy.kanban.createTask',
      toolName: 'CreateTaskTool',
      securityLevel: 'L3_Approval',
      args: task,
      execute: () => createLegacyKanbanTask(task),
    }
  },
}

export const AURORA_TOOLS: AuroraTool[] = [
  ListTasksTool,
  GenerateLifeOSBriefingTool,
  RunQuantPhaseCheckTool,
  OpenMiroFishGraphTool,
  MiroFishDebateTool,
  OpenVideoStudioTool,
  OpenBrowserTool,
  OpenHermesAppTool,
  CreatePaperJournalTool,
  ViewLifeOSTool,
  ViewQuantLabTool,
  ListGeneratedWidgetsTool,
  LoadGeneratedWidgetTool,
  ProposeMemoryTool,
  SearchMemoryTool,
  CreateTaskTool,
]
