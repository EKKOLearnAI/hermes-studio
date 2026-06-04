import { edgeTtsProvider } from './edge'
import { customTtsProvider, openaiTtsProvider } from './openai'
import { mimoTtsProvider } from './mimo'
import type { TtsProvider, TtsProviderId } from './types'

const providers: Record<TtsProviderId, TtsProvider<any>> = {
  edge: edgeTtsProvider,
  openai: openaiTtsProvider,
  custom: customTtsProvider,
  mimo: mimoTtsProvider,
}

export function getTtsProvider(provider: string): TtsProvider<any> | undefined {
  return providers[provider as TtsProviderId]
}
