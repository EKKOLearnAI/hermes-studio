export type TtsProviderId = 'edge' | 'openai' | 'custom' | 'mimo'

export interface TtsSynthesisRequest {
  text: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface TtsSynthesisResult {
  audio: Buffer
  contentType: string
  engine: string
  provider: TtsProviderId
}

export interface TtsProvider<TOptions extends object = Record<string, unknown>> {
  id: TtsProviderId
  synthesize(req: TtsSynthesisRequest, options: TOptions): Promise<TtsSynthesisResult>
}

export interface OpenaiTtsProviderOptions {
  baseUrl: string
  apiKey?: string
  model?: string
  voice?: string
  rate?: string
  pitch?: string
}

export type MimoAuthMode = 'api-key' | 'bearer' | 'both'
export type MimoVoiceMode = 'preset' | 'voiceDesign' | 'voiceClone'

export interface MimoTtsProviderOptions {
  baseUrl: string
  apiKey: string
  authMode?: MimoAuthMode
  model: string
  voiceMode?: MimoVoiceMode
  voice?: string
  voiceDesignDesc?: string
  voiceCloneDataUri?: string
  voiceCloneFormat?: 'mp3' | 'wav'
  stylePrompt?: string
}

export type OpenaiTtsProvider = TtsProvider<OpenaiTtsProviderOptions>
export type MimoTtsProvider = TtsProvider<MimoTtsProviderOptions>
