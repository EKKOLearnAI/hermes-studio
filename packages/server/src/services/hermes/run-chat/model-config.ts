import { readConfigYamlForProfile } from '../../config-helpers'

export type RunModelGroup = { provider: string; models: string[] }

function runtimeProvider(provider: string): string {
  return provider === 'claude-oauth' ? 'anthropic' : provider
}

async function resolveDefaultModelConfig(profile: string): Promise<{ model: string; provider: string }> {
  try {
    const config = await readConfigYamlForProfile(profile)
    const modelConfig = config?.model
    const model = typeof modelConfig === 'string'
      ? modelConfig.trim()
      : String(modelConfig?.default || '').trim()
    const provider = typeof modelConfig === 'object'
      ? String(modelConfig?.provider || '').trim()
      : ''
    return { model, provider: runtimeProvider(provider) }
  } catch {
    return { model: '', provider: '' }
  }
}

export async function resolveBridgeRunModelConfig(options: {
  profile: string
  sessionModel?: string | null
  sessionProvider?: string | null
  requestedModel?: string | null
  requestedProvider?: string | null
  modelGroups?: RunModelGroup[]
}): Promise<{ model: string; provider: string }> {
  const sessionModel = String(options.sessionModel || '').trim()
  const sessionProvider = String(options.sessionProvider || '').trim()
  const requestedModel = String(options.requestedModel || '').trim()
  const requestedProvider = String(options.requestedProvider || '').trim()
  const candidateModel = requestedModel || sessionModel
  const candidateProvider = requestedProvider || sessionProvider
  return !candidateModel || !candidateProvider
    ? resolveDefaultModelConfig(options.profile)
    : { model: candidateModel, provider: runtimeProvider(candidateProvider) }
}
