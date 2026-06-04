import { describe, expectTypeOf, it } from 'vitest'
import type {
  MimoTtsProvider,
  MimoTtsProviderOptions,
  OpenaiTtsProvider,
  OpenaiTtsProviderOptions,
  TtsProvider,
} from '../../packages/server/src/services/hermes/tts-providers/types'

describe('tts provider type usability', () => {
  it('accepts OpenAI provider options', () => {
    const provider: TtsProvider<OpenaiTtsProviderOptions> = {
      id: 'openai',
      async synthesize(_req, _options) {
        return {
          audio: Buffer.from('audio'),
          contentType: 'audio/mpeg',
          engine: 'openai',
          provider: 'openai',
        }
      },
    }

    expectTypeOf(provider).toEqualTypeOf<TtsProvider<OpenaiTtsProviderOptions>>()
    expectTypeOf(provider).toEqualTypeOf<OpenaiTtsProvider>()
  })

  it('accepts Mimo provider options', () => {
    const provider: TtsProvider<MimoTtsProviderOptions> = {
      id: 'mimo',
      async synthesize(_req, _options) {
        return {
          audio: Buffer.from('audio'),
          contentType: 'audio/mpeg',
          engine: 'mimo',
          provider: 'mimo',
        }
      },
    }

    expectTypeOf(provider).toEqualTypeOf<TtsProvider<MimoTtsProviderOptions>>()
    expectTypeOf(provider).toEqualTypeOf<MimoTtsProvider>()
  })
})
