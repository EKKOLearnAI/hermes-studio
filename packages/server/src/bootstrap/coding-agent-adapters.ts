import {
  PROVIDER_ENV_MAP,
  readConfigYamlForProfile,
  safeReadFile,
} from '../services/config-helpers'
import { getProfileDir } from '../services/hermes/hermes-profile'
import * as modelContext from '../services/hermes/model-context'
import * as responseStream from '../services/hermes/run-chat/response-stream'
import * as runUsage from '../services/hermes/run-chat/usage'
import * as responseUtils from '../services/hermes/run-chat/response-utils'
import * as workspaceDiff from '../services/hermes/run-chat/workspace-diff-tracker'
import { getChatRunServer } from '../services/hermes/run-chat/server-registry'
import { getOrCreateSession } from '../services/hermes/run-chat/compression'
import { configureProfileConfig } from '../modules/studio/public/profile-config'
import { configureProviderRuntime } from '../modules/studio/public/provider-runtime'
import { configureRunState } from '../modules/studio/public/run-state'

configureProfileConfig({
  getProfileDir,
  providerEnvironmentMap: PROVIDER_ENV_MAP,
  readConfigYamlForProfile,
  safeReadFile,
})
configureProviderRuntime({
  getModelContextLength: modelContext.getModelContextLength,
  getModelRuntimeCapabilities: (...args: any[]) => {
    const resolver = (modelContext as any).getModelRuntimeCapabilities
    return typeof resolver === 'function'
      ? resolver(...args)
      : { contextWindow: modelContext.getModelContextLength(...args) }
  },
})
const optional = (candidate: unknown, fallback: (...args: any[]) => any) => (
  typeof candidate === 'function' ? candidate as (...args: any[]) => any : fallback
)
configureRunState({
  applyResponseStreamEvent: optional((responseStream as any).applyResponseStreamEvent, () => null),
  calcAndUpdateUsage: optional((runUsage as any).calcAndUpdateUsage, async () => ({})),
  completeWorkspaceRunCheckpoint: optional((workspaceDiff as any).completeWorkspaceRunCheckpoint, () => undefined),
  extractResponseText: optional((responseUtils as any).extractResponseText, () => ''),
  flushResponseRunToDb: optional((responseStream as any).flushResponseRunToDb, () => undefined),
  getChatRunServer,
  getOrCreateSession,
  startWorkspaceRunCheckpoint: optional((workspaceDiff as any).startWorkspaceRunCheckpoint, () => undefined),
  updateContextTokenUsage: optional((runUsage as any).updateContextTokenUsage, () => undefined),
})
