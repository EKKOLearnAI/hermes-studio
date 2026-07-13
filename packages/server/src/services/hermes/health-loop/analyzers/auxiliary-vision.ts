import { isProxy } from 'node:util/types'
import {
  finalizeHealthAnalysis, HealthAnalysisError, HealthAnalysisRequest, HealthAnalysisResult, validateHealthAnalysisRequest,
} from '../analysis'
import type { HealthArtifactVault } from '../artifacts'
import {
  HEALTH_PROCESSING_RETENTIONS, type HealthConsentBroker, type HealthProcessingManifest,
} from '../consent'

export interface ResolvedAuxiliaryVisionConfig {
  provider: string
  model: string
  locality: 'local' | 'remote'
  timeoutMs: number
}

export type AuxiliaryVisionConfigResolver = (profile: string) => Promise<ResolvedAuxiliaryVisionConfig>

export interface AuxiliaryVisionClientArtifact {
  artifactId: string
  mediaType: string
  content: Buffer
}

export interface AuxiliaryVisionClientInput {
  schemaVersion: 'health-vision-client-request/v1'
  provider: string
  model: string
  purpose: HealthAnalysisRequest['purpose']
  requestedFields: string[]
  selectedRegions: string[]
  artifacts: AuxiliaryVisionClientArtifact[]
}

export interface AuxiliaryVisionClient {
  analyze(input: AuxiliaryVisionClientInput, options: { signal: AbortSignal }): Promise<string | Uint8Array>
}

export interface AuxiliaryVisionAnalyzerDependencies {
  resolver: AuxiliaryVisionConfigResolver
  client: AuxiliaryVisionClient
  vault: Pick<HealthArtifactVault, 'read'>
  consentBroker?: Pick<HealthConsentBroker, 'consume'>
  maxResponseBytes?: number
}

export interface AuxiliaryVisionAnalyzer {
  analyze(request: HealthAnalysisRequest): Promise<HealthAnalysisResult>
}

const SEMANTIC = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const MANIFEST_KEYS = ['artifactIds', 'processor', 'purpose', 'selectedRegions', 'requestedFields', 'retention'] as const
const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function fail(code: ConstructorParameters<typeof HealthAnalysisError>[0]): never { throw new HealthAnalysisError(code) }

function safeConfig(value: unknown): ResolvedAuxiliaryVisionConfig {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail('HEALTH_ANALYSIS_PROCESSOR_FAILED')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== 4 || keys.some(key => typeof key !== 'string' || POISON_KEYS.has(key)
      || !['provider', 'model', 'locality', 'timeoutMs'].includes(key) || !('value' in descriptors[key]))) {
      fail('HEALTH_ANALYSIS_PROCESSOR_FAILED')
    }
    const config = Object.fromEntries((keys as string[]).map(key => [key, descriptors[key].value])) as unknown as ResolvedAuxiliaryVisionConfig
    if (typeof config.provider !== 'string' || config.provider.length < 1 || config.provider.length > 80 || !SEMANTIC.test(config.provider)
      || typeof config.model !== 'string' || config.model.length < 1 || config.model.length > 64 || !SEMANTIC.test(config.model)
      || !['local', 'remote'].includes(config.locality) || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 300_000) {
      fail('HEALTH_ANALYSIS_PROCESSOR_FAILED')
    }
    return config
  } catch (error) {
    if (error instanceof HealthAnalysisError) throw error
    return fail('HEALTH_ANALYSIS_PROCESSOR_FAILED')
  }
}

function canonical(values: string[]): string[] {
  return [...values].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && canonical(left).every((value, index) => value === canonical(right)[index])
}

function validateRemoteManifest(value: unknown, request: HealthAnalysisRequest, provider: string): HealthProcessingManifest {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail('HEALTH_ANALYSIS_CONSENT_DENIED')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== MANIFEST_KEYS.length || keys.some(key => typeof key !== 'string' || POISON_KEYS.has(key)
      || !MANIFEST_KEYS.includes(key as typeof MANIFEST_KEYS[number]) || !('value' in descriptors[key]))) {
      fail('HEALTH_ANALYSIS_CONSENT_DENIED')
    }
    const manifest = Object.fromEntries((keys as string[]).map(key => [key, descriptors[key].value])) as unknown as HealthProcessingManifest
    if (!Array.isArray(manifest.artifactIds) || !manifest.artifactIds.every(item => typeof item === 'string')
      || !Array.isArray(manifest.selectedRegions) || !manifest.selectedRegions.every(item => typeof item === 'string')
      || !Array.isArray(manifest.requestedFields) || !manifest.requestedFields.every(item => typeof item === 'string')
      || manifest.processor !== provider || manifest.purpose !== request.purpose
      || !(HEALTH_PROCESSING_RETENTIONS as readonly unknown[]).includes(manifest.retention)
      || !sameSet(manifest.artifactIds, request.artifactIds)
      || !sameSet(manifest.selectedRegions, request.selectedRegions)
      || !sameSet(manifest.requestedFields, request.requestedFields)) fail('HEALTH_ANALYSIS_CONSENT_DENIED')
    return manifest
  } catch (error) {
    if (error instanceof HealthAnalysisError) throw error
    return fail('HEALTH_ANALYSIS_CONSENT_DENIED')
  }
}

function strictResponse(value: string | Uint8Array, maxBytes: number): unknown {
  try {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value instanceof Uint8Array ? value : fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
    if (bytes.byteLength < 2 || bytes.byteLength > maxBytes) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.trimStart().startsWith('```') || !text.trimStart().startsWith('{') || !text.trimEnd().endsWith('}')) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
    const output = JSON.parse(text)
    if (!output || typeof output !== 'object' || Array.isArray(output)) fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
    return output
  } catch (error) {
    if (error instanceof HealthAnalysisError) throw error
    return fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
  }
}

async function dispatchWithTimeout(
  client: AuxiliaryVisionClient,
  input: AuxiliaryVisionClientInput,
  timeoutMs: number,
): Promise<string | Uint8Array> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new HealthAnalysisError('HEALTH_ANALYSIS_TIMEOUT'))
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([client.analyze(input, { signal: controller.signal }), timeout])
  } catch (error) {
    if (error instanceof HealthAnalysisError && error.code === 'HEALTH_ANALYSIS_TIMEOUT') throw error
    throw new HealthAnalysisError('HEALTH_ANALYSIS_PROCESSOR_FAILED')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createAuxiliaryVisionAnalyzer(dependencies: AuxiliaryVisionAnalyzerDependencies): AuxiliaryVisionAnalyzer {
  if (!dependencies || typeof dependencies.resolver !== 'function' || !dependencies.client
    || typeof dependencies.client.analyze !== 'function' || !dependencies.vault || typeof dependencies.vault.read !== 'function') {
    fail('HEALTH_ANALYSIS_PROCESSOR_FAILED')
  }
  const maxResponseBytes = dependencies.maxResponseBytes ?? 512 * 1024
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 128 || maxResponseBytes > 2 * 1024 * 1024) {
    fail('HEALTH_ANALYSIS_PROCESSOR_FAILED')
  }

  return {
    async analyze(inputRequest): Promise<HealthAnalysisResult> {
      let request = validateHealthAnalysisRequest(inputRequest)
      let config: ResolvedAuxiliaryVisionConfig
      try { config = safeConfig(await dependencies.resolver(request.profile)) }
      catch { throw new HealthAnalysisError('HEALTH_ANALYSIS_PROCESSOR_FAILED') }
      request = validateHealthAnalysisRequest(inputRequest, config.locality)

      if (config.locality === 'remote') {
        const manifest = validateRemoteManifest(request.manifest, request, config.provider)
        if (!dependencies.consentBroker || typeof dependencies.consentBroker.consume !== 'function'
          || typeof request.consentToken !== 'string') fail('HEALTH_ANALYSIS_CONSENT_DENIED')
        try {
          await dependencies.consentBroker.consume(request.consentToken, manifest)
        } catch { throw new HealthAnalysisError('HEALTH_ANALYSIS_CONSENT_DENIED') }
      }

      const artifacts: AuxiliaryVisionClientArtifact[] = []
      for (const artifactId of request.artifactIds) {
        try {
          const read = await dependencies.vault.read(artifactId)
          if (!read || read.artifact.id !== artifactId || typeof read.artifact.mediaType !== 'string'
            || !(read.content instanceof Uint8Array)) fail('HEALTH_ANALYSIS_ARTIFACT_DENIED')
          artifacts.push({ artifactId, mediaType: read.artifact.mediaType, content: Buffer.from(read.content) })
        } catch { throw new HealthAnalysisError('HEALTH_ANALYSIS_ARTIFACT_DENIED') }
      }

      const response = await dispatchWithTimeout(dependencies.client, {
        schemaVersion: 'health-vision-client-request/v1', provider: config.provider, model: config.model,
        purpose: request.purpose, requestedFields: [...request.requestedFields], selectedRegions: [...request.selectedRegions], artifacts,
      }, config.timeoutMs)
      const output = strictResponse(response, maxResponseBytes) as Record<string, unknown>
      if (output.modelVersion !== config.model || output.parserVersion !== 'vision-json-v1') fail('HEALTH_ANALYSIS_INVALID_OUTPUT')
      return finalizeHealthAnalysis(request, output, { processor: config.provider, locality: config.locality })
    },
  }
}
