import type { AvailableModelGroup, ProfileAvailableModels } from '@/api/hermes/system'

export function getModelGroupsForProfile(profileModelGroups: ProfileAvailableModels[], profile: string): AvailableModelGroup[] {
  return profileModelGroups.find(entry => entry.profile === profile)?.groups || []
}

export function getDefaultModelForProfile(profileModelGroups: ProfileAvailableModels[], profile: string): { provider: string; model: string } {
  const groups = getModelGroupsForProfile(profileModelGroups, profile)
  const profileModels = profileModelGroups.find(entry => entry.profile === profile)
  const defaultProvider = profileModels?.default_provider || ''
  const defaultModel = profileModels?.default || ''
  const providerGroup = defaultProvider
    ? groups.find(group => group.provider === defaultProvider)
    : undefined
  const fallbackGroup = providerGroup || groups.find(group => group.models.length > 0)
  return {
    provider: fallbackGroup?.provider || '',
    model: fallbackGroup?.models.includes(defaultModel)
      ? defaultModel
      : fallbackGroup?.models[0] || '',
  }
}

export function getProviderOptions(groups: AvailableModelGroup[]) {
  return groups.map(group => ({
    label: group.label || group.provider,
    value: group.provider,
  }))
}

export function getModelOptions(groups: AvailableModelGroup[], provider: string, displayModelName: (model: string, provider?: string) => string) {
  const group = groups.find(item => item.provider === provider)
  return (group?.models || []).map(model => ({
    label: displayModelName(model, group?.provider),
    value: model,
  }))
}
