export type ProviderEnvironmentMap = Record<string, { api_key_env: string; base_url_env: string }>

export interface ProfileConfigDependencies {
  getProfilesBaseDir: () => string
  getProfileDir: (profile: string) => string
  listProfileNames: () => string[]
  providerEnvironmentMap: ProviderEnvironmentMap
  readConfigYamlForProfile: (profile: string) => Promise<Record<string, any>>
  safeReadFile: (filePath: string) => Promise<string | null>
  saveEnvValueForProfile: (profile: string, key: string, value: string) => Promise<void>
  updateConfigYamlForProfile: <T = void>(
    profile: string,
    updater: (config: Record<string, any>) => any,
  ) => Promise<T | undefined>
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

export function getProfilesBaseDir(): string {
  return configured().getProfilesBaseDir()
}

export function listProfileNames(): string[] {
  return configured().listProfileNames()
}

export function readConfigYamlForProfile(profile: string): Promise<Record<string, any>> {
  return configured().readConfigYamlForProfile(profile)
}

export function safeReadFile(filePath: string): Promise<string | null> {
  return configured().safeReadFile(filePath)
}

export function saveEnvValueForProfile(profile: string, key: string, value: string): Promise<void> {
  return configured().saveEnvValueForProfile(profile, key, value)
}

export function updateConfigYamlForProfile<T = void>(
  profile: string,
  updater: (config: Record<string, any>) => any,
): Promise<T | undefined> {
  return configured().updateConfigYamlForProfile<T>(profile, updater)
}
