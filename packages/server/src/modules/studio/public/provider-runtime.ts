export interface ProviderRuntimeDependencies {
  getModelContextLength: (...args: any[]) => number
  getModelRuntimeCapabilities: (...args: any[]) => any
}

let providerRuntimeDependencies: ProviderRuntimeDependencies | null = null

export function configureProviderRuntime(dependencies: ProviderRuntimeDependencies): void {
  providerRuntimeDependencies = dependencies
}

function configured(): ProviderRuntimeDependencies {
  if (!providerRuntimeDependencies) throw new Error('Studio provider runtime has not been configured')
  return providerRuntimeDependencies
}

export function getModelContextLength(...args: any[]): number {
  return configured().getModelContextLength(...args)
}

export function getModelRuntimeCapabilities(...args: any[]): any {
  return configured().getModelRuntimeCapabilities(...args)
}
