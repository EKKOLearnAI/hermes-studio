export type ProviderEnvironmentMap = Record<string, { api_key_env: string; base_url_env: string }>

export interface ProfileConfigDependencies {
  getProfileDir: (profile: string) => string
  providerEnvironmentMap: ProviderEnvironmentMap
  readConfigYamlForProfile: (profile: string) => Promise<Record<string, any>>
  safeReadFile: (filePath: string) => Promise<string | null>
}

let profileConfigDependencies: ProfileConfigDependencies | null = null
export let PROVIDER_ENV_MAP: ProviderEnvironmentMap = {}

export function configureProfileConfig(dependencies: ProfileConfigDependencies): void {
  profileConfigDependencies = dependencies
  PROVIDER_ENV_MAP = dependencies.providerEnvironmentMap
}

function configured(): ProfileConfigDependencies {
  if (!profileConfigDependencies) throw new Error('Studio profile config has not been configured')
  return profileConfigDependencies
}

export function getProfileDir(profile: string): string {
  return configured().getProfileDir(profile)
}

export function readConfigYamlForProfile(profile: string): Promise<Record<string, any>> {
  return configured().readConfigYamlForProfile(profile)
}

export function safeReadFile(filePath: string): Promise<string | null> {
  return configured().safeReadFile(filePath)
}
