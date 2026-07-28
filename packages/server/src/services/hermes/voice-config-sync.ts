import { saveEnvValueForProfile, updateConfigYamlForProfile } from '../config-helpers'
import { logger } from '../logger'

/**
 * Mirror Web UI speech settings into the Hermes Agent profile configuration.
 *
 * The Web UI stores its own voice provider settings and uses them for
 * `POST /api/hermes/stt/transcribe`, which only serves browser transcription.
 * Hermes Agent reads a separate `stt:` block from the profile `config.yaml`
 * plus credentials from the profile `.env`, and that is what gateway platforms
 * (Telegram, Discord, ...) use for inbound voice messages. Without mirroring,
 * a provider configured in the Web UI never reaches those platforms and Hermes
 * keeps resolving `stt.provider` to `local`.
 *
 * Key names follow the Hermes Agent reference documentation
 * (`website/docs/user-guide/features/voice-mode.md`):
 *
 *   stt:
 *     enabled: true
 *     provider: "local" | "groq" | "openai" | "mistral" | "xai"
 *
 * Only hosts with an unambiguous Hermes provider mapping are mirrored, so a
 * generic OpenAI-compatible endpoint is never silently relabelled.
 */

const STORED_SECRET_PLACEHOLDER = '[stored]'

export interface HermesSttTarget {
  /** Value written to `stt.provider` in config.yaml. */
  provider: string
  /** Env var Hermes Agent reads the credential from. */
  apiKeyEnv: string
}

const HERMES_STT_HOSTS: Array<HermesSttTarget & { hostPattern: RegExp }> = [
  { hostPattern: /(^|\.)groq\.com$/i, provider: 'groq', apiKeyEnv: 'GROQ_API_KEY' },
]

export function resolveHermesSttTarget(baseUrl: unknown): HermesSttTarget | null {
  if (typeof baseUrl !== 'string') return null
  const trimmed = baseUrl.trim()
  if (!trimmed) return null

  let host = ''
  try {
    host = new URL(trimmed).hostname
  } catch {
    return null
  }

  const match = HERMES_STT_HOSTS.find(entry => entry.hostPattern.test(host))
  return match ? { provider: match.provider, apiKeyEnv: match.apiKeyEnv } : null
}

export function isUsableSecret(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed !== STORED_SECRET_PLACEHOLDER
}

export function applyHermesSttProvider(config: Record<string, any>, provider: string): Record<string, any> {
  const stt = (typeof config.stt === 'object' && config.stt !== null) ? config.stt : {}
  stt.enabled = true
  stt.provider = provider
  config.stt = stt
  return config
}

/**
 * Returns true when the profile configuration was updated.
 * Never throws: a failed mirror must not fail the settings request itself.
 */
export async function syncSttProviderToHermesConfig(
  profile: string,
  input: { baseUrl?: unknown, apiKey?: unknown },
): Promise<boolean> {
  const target = resolveHermesSttTarget(input.baseUrl)
  if (!target) return false

  try {
    if (isUsableSecret(input.apiKey)) {
      await saveEnvValueForProfile(profile, target.apiKeyEnv, input.apiKey.trim())
    }
    await updateConfigYamlForProfile(profile, config => applyHermesSttProvider(config, target.provider))
    return true
  } catch (error) {
    logger.warn(`[voice-config-sync] failed to mirror STT settings for profile "${profile}": ${String(error)}`)
    return false
  }
}
