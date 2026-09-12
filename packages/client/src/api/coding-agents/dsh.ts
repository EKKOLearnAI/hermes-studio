import { request } from '../client'

export interface DshNativePluginInventory {
  source: 'native-presets'; sourceHome: string; packageVersion: string; defaultPreset: string
  web?: DshWebPackages
  runtimeConnected: false; discovery: 'shipped-and-user-roots'
  presets: Array<{ id: string; name: string; description: string; trust: 'system' | 'user'; sourcePath: string; isDefault: boolean; error?: string
    entries: Array<{ entryId: string; title?: string; description?: string; moduleName: string; configuredEnabled: boolean | 'conditional'; runtimePhase: null; groupPath: string[] }>
  }>
}
export const readNativeDshPlugins = () => request<DshNativePluginInventory>('/api/coding-agents/dsh/plugin-inventory')

export interface DshWebPackages {
  profile: 'web'; sourcePath: string; revision: string
  packages: Array<{ name: string; title?: string; description?: string; requested: string; version: string; bundle: boolean; containsBrowserPart: boolean; sourcePath: string; error: string }>
}
export const changeWebPlugins = (body: { action: 'install'; packageSpec: string } | { action: 'remove'; packageName: string }, revision: string) =>
  request<DshNativePluginInventory>('/api/coding-agents/dsh/web-plugins', { method: 'POST', headers: { 'If-Match': `"${revision}"` }, body: JSON.stringify(body) })
export const openDshPluginUi = () => request<{ id: string; path: string }>('/api/coding-agents/dsh/ui-session', { method: 'POST' })
export const closeDshPluginUi = (id: string) => request<void>(`/api/coding-agents/dsh/ui-session/${id}`, { method: 'DELETE' })
