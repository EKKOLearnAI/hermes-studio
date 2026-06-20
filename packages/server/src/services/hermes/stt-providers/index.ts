import { transcribeDoubaoFile } from './doubao'
import { transcribeOpenAiCompatible } from './openai'
import type { SttTranscribeInput, SttTranscribeResult } from './types'

export * from './doubao'
export * from './openai'
export * from './types'

export async function transcribeWithProvider(input: SttTranscribeInput): Promise<SttTranscribeResult> {
  switch (input.provider) {
    case 'openai':
    case 'custom':
      return transcribeOpenAiCompatible(input)
    case 'doubao':
      return transcribeDoubaoFile(input)
    default:
      throw new Error(`Unsupported STT provider: ${String(input.provider)}`)
  }
}
