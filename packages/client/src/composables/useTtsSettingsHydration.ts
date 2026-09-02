import { watch, type WatchSource, type WatchStopHandle } from 'vue'
import { hasApiKey } from '@/api/client'
import { loadServerTtsSettings } from '@/composables/useVoiceSettings'

export interface ServerTtsSettingsHydrationSources {
  isLoginPage: WatchSource<boolean>
  activeProfileName: WatchSource<string | null>
}

export function watchServerTtsSettingsHydration(
  sources: ServerTtsSettingsHydrationSources,
): WatchStopHandle {
  return watch(
    [sources.isLoginPage, sources.activeProfileName],
    ([isLoginPage, activeProfileName]) => {
      if (isLoginPage || !activeProfileName?.trim() || !hasApiKey()) return
      void loadServerTtsSettings().catch(() => undefined)
    },
    { immediate: true },
  )
}
