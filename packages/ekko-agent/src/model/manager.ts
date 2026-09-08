import type {
  EkkoConfig,
  EkkoModelAuthorizationSettings,
  EkkoModelProviderSettings,
} from '../config'
import type {
  ConfiguredModelAuthorizationEntry,
  ConfiguredModelProviderEntry,
  EkkoConfigStore,
  InstallModelProviderPresetOptions,
} from '../config-store'
import type {
  EkkoModelAuthorizationCredentials,
  EkkoModelAuthorizationManager,
} from './authorization'
import type { ResolveConfiguredModelProviderInput } from './provider-config'
import type { EkkoModelProviderPreset } from './provider-presets'
import type { ModelClient, ModelClientOptions, ModelProviderConfig } from './types'

export interface EkkoModelManagerOptions {
  config: EkkoConfigStore
  authorizations: EkkoModelAuthorizationManager
  resolveProvider: (input?: Omit<ResolveConfiguredModelProviderInput, 'config'>) => ModelProviderConfig
  createClient: (
    input?: Omit<ResolveConfiguredModelProviderInput, 'config'>,
    clientOptions?: ModelClientOptions,
  ) => ModelClient
}

/** Public model module used through `ekko.model`. */
export class EkkoModelManager {
  readonly authorization: EkkoModelAuthorizationManager
  private readonly config: EkkoConfigStore
  private readonly resolveProvider: EkkoModelManagerOptions['resolveProvider']
  private readonly createClientFactory: EkkoModelManagerOptions['createClient']

  constructor(options: EkkoModelManagerOptions) {
    this.config = options.config
    this.authorization = options.authorizations
    this.resolveProvider = options.resolveProvider
    this.createClientFactory = options.createClient
  }

  listPresets(): EkkoModelProviderPreset[] {
    return this.config.listModelProviderPresets()
  }

  getPreset(id: string): EkkoModelProviderPreset | undefined {
    return this.config.getModelProviderPreset(id)
  }

  setPreset(
    id: string,
    preset: Omit<EkkoModelProviderPreset, 'id'> & { id?: string },
  ): EkkoConfig {
    return this.config.setModelProviderPreset(id, preset)
  }

  updatePreset(id: string, patch: Partial<EkkoModelProviderPreset>): EkkoConfig {
    return this.config.updateModelProviderPreset(id, patch)
  }

  deletePreset(id: string): boolean {
    return this.config.deleteModelProviderPreset(id)
  }

  install(id: string, options: InstallModelProviderPresetOptions = {}): EkkoConfig {
    return this.config.installModelProviderPreset(id, options)
  }

  listProviders(): ConfiguredModelProviderEntry[] {
    return this.config.listModelProviders()
  }

  getProvider(id: string): EkkoModelProviderSettings | undefined {
    return this.config.getModelProvider(id)
  }

  setProvider(id: string, settings: EkkoModelProviderSettings): EkkoConfig {
    return this.config.setModelProvider(id, settings)
  }

  updateProvider(id: string, patch: Partial<EkkoModelProviderSettings>): EkkoConfig {
    return this.config.updateModelProvider(id, patch)
  }

  deleteProvider(id: string): boolean {
    return this.config.deleteModelProvider(id)
  }

  setDefault(provider: string, model?: string): EkkoConfig {
    return this.config.setDefaultModel(provider, model)
  }

  listAuthorizations(): ConfiguredModelAuthorizationEntry[] {
    return this.authorization.list()
  }

  getAuthorization(provider: string): EkkoModelAuthorizationSettings | undefined {
    return this.authorization.get(provider)
  }

  setAuthorization(provider: string, settings: EkkoModelAuthorizationSettings): EkkoConfig {
    return this.authorization.set(provider, settings)
  }

  updateAuthorization(
    provider: string,
    patch: Partial<EkkoModelAuthorizationSettings>,
  ): EkkoConfig {
    return this.authorization.update(provider, patch)
  }

  deleteAuthorization(provider: string): boolean {
    return this.authorization.delete(provider)
  }

  refreshAuthorization(
    provider: string,
    model?: string,
  ): Promise<EkkoModelAuthorizationCredentials> {
    return this.authorization.refresh(provider, model)
  }

  resolveAuthorization(
    provider: string,
    model?: string,
  ): Promise<EkkoModelAuthorizationCredentials> {
    return this.authorization.resolve(provider, model)
  }

  providerConfig(
    input: Omit<ResolveConfiguredModelProviderInput, 'config'> = {},
  ): ModelProviderConfig {
    return this.resolveProvider(input)
  }

  createClient(
    input: Omit<ResolveConfiguredModelProviderInput, 'config'> = {},
    clientOptions: ModelClientOptions = {},
  ): ModelClient {
    return this.createClientFactory(input, clientOptions)
  }
}
