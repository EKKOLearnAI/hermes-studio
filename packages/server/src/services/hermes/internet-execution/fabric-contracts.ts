import { isProxy } from 'node:util/types'
import type { FabricCapabilityInput } from '../action-fabric/registry'
import type { FabricJsonObject } from '../action-fabric/types'

export const BILIBILI_PROVIDER = 'bilibili'
export const BILIBILI_ORIGIN = 'www.bilibili.com'
export const BILIBILI_SEARCH_CAPABILITY = 'bilibili.video.search'
export const BILIBILI_INSPECT_CAPABILITY = 'bilibili.video.inspect'

const CAPABILITIES = new Set([BILIBILI_SEARCH_CAPABILITY, BILIBILI_INSPECT_CAPABILITY])
const BVID = /^BV[0-9A-Za-z]{10}$/
const PROFILE = /^[^/\\\u0000-\u001f\u007f]{1,200}$/
const FORBIDDEN_TOOL = /(?:publish|upload|comment|reply|like|favorite|favourite|follow|unfollow|coin|danmaku|message|delete|login|logout|account|payment|purchase)/i
const SEARCH_TOOL = /search/i
const INSPECT_TOOL = /(?:inspect|detail|info|get|fetch|view)/i

export interface BilibiliVideoSummary {
  bvid: string
  title: string
  author: string
  publishedAt: string | null
  durationSeconds: number | null
  viewCount: number | null
  canonicalUrl: string
}

export interface BilibiliSearchNormalization {
  videos: BilibiliVideoSummary[]
  totalCount: number
  omittedCount: number
}

export class InternetSemanticContractError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'InternetSemanticContractError'
  }
}

function objectSchema(properties: Record<string, unknown>, required: string[]): FabricJsonObject {
  return { type: 'object', additionalProperties: false, properties, required }
}

const profileSchema = { type: 'string', minLength: 1, maxLength: 200, pattern: PROFILE.source }
const bvidSchema = { type: 'string', pattern: BVID.source, minLength: 12, maxLength: 12 }
const nullableTimestamp = { type: ['string', 'null'], format: 'date-time', maxLength: 64 }
const nullableCount = { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const videoSummarySchema = objectSchema({
  bvid: bvidSchema,
  title: { type: 'string', minLength: 1, maxLength: 200 },
  author: { type: 'string', minLength: 1, maxLength: 120 },
  publishedAt: nullableTimestamp,
  durationSeconds: { type: ['integer', 'null'], minimum: 0, maximum: 86_400 },
  viewCount: nullableCount,
  canonicalUrl: { type: 'string', minLength: 43, maxLength: 44,
    pattern: '^https://www\\.bilibili\\.com/video/BV[0-9A-Za-z]{10}/?$' },
}, ['bvid', 'title', 'author', 'publishedAt', 'durationSeconds', 'viewCount', 'canonicalUrl'])

const baseCapability = {
  version: 1,
  risk: 'low' as const,
  sideEffect: false,
  idempotency: 'supported' as const,
  reversible: false,
  compensationCapabilityId: null,
  authentication: ['hermes_profile:configured', 'bilibili_read:configured'],
  targetRestrictions: ['internet:origin', 'internet:profile', 'internet:provider'],
  cost: { currency: null, estimatedMinor: 0 },
  enabled: true,
}

export const INTERNET_FABRIC_CAPABILITIES: FabricCapabilityInput[] = [
  {
    ...baseCapability,
    id: BILIBILI_SEARCH_CAPABILITY,
    description: 'Search public Bilibili videos through a bounded read-only semantic contract',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 }, provider: { const: BILIBILI_PROVIDER }, profile: profileSchema,
      query: { type: 'string', minLength: 1, maxLength: 120 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      page: { type: 'integer', minimum: 1, maximum: 10 },
      order: { enum: ['relevance', 'newest', 'most_viewed'] },
    }, ['schemaVersion', 'provider', 'profile', 'query', 'limit', 'page', 'order']),
    outputSchema: objectSchema({
      schemaVersion: { const: 1 }, provider: { const: BILIBILI_PROVIDER }, profile: profileSchema,
      operation: { const: 'search' }, query: { type: 'string', minLength: 1, maxLength: 120 },
      status: { enum: ['succeeded', 'partial'] },
      videos: { type: 'array', maxItems: 20, items: videoSummarySchema },
      totalCount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      omittedCount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    }, ['schemaVersion', 'provider', 'profile', 'operation', 'query', 'status', 'videos', 'totalCount', 'omittedCount']),
    verificationStrategy: 'second_read_bvid_overlap',
  },
  {
    ...baseCapability,
    id: BILIBILI_INSPECT_CAPABILITY,
    description: 'Inspect one exact public Bilibili video through a bounded read-only semantic contract',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 }, provider: { const: BILIBILI_PROVIDER }, profile: profileSchema, bvid: bvidSchema,
    }, ['schemaVersion', 'provider', 'profile', 'bvid']),
    outputSchema: objectSchema({
      schemaVersion: { const: 1 }, provider: { const: BILIBILI_PROVIDER }, profile: profileSchema,
      operation: { const: 'inspect' }, status: { const: 'succeeded' }, video: videoSummarySchema,
      description: { type: 'string', maxLength: 2_000 },
      tags: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 80 } },
    }, ['schemaVersion', 'provider', 'profile', 'operation', 'status', 'video', 'description', 'tags']),
    verificationStrategy: 'second_read_exact_bvid',
  },
]

export function isInternetCapability(capabilityId: string): boolean {
  return CAPABILITIES.has(capabilityId)
}

export function validateInternetSemantics(capabilityId: string, input: FabricJsonObject): boolean {
  if (!isInternetCapability(capabilityId) || !plainDataObject(input)) return false
  const expectedKeys = capabilityId === BILIBILI_SEARCH_CAPABILITY
    ? ['limit', 'order', 'page', 'profile', 'provider', 'query', 'schemaVersion']
    : ['bvid', 'profile', 'provider', 'schemaVersion']
  if (!exactDataKeys(input, expectedKeys)) return false
  if (data(input, 'schemaVersion') !== 1 || data(input, 'provider') !== BILIBILI_PROVIDER) return false
  const profile = data(input, 'profile')
  if (typeof profile !== 'string' || !PROFILE.test(profile) || profile.trim() !== profile) return false
  if (capabilityId === BILIBILI_INSPECT_CAPABILITY) return isBilibiliBvid(data(input, 'bvid'))
  const query = data(input, 'query')
  return typeof query === 'string' && query.trim() === query && query.length >= 1 && query.length <= 120
    && Number.isSafeInteger(data(input, 'limit')) && Number(data(input, 'limit')) >= 1 && Number(data(input, 'limit')) <= 20
    && Number.isSafeInteger(data(input, 'page')) && Number(data(input, 'page')) >= 1 && Number(data(input, 'page')) <= 10
    && ['relevance', 'newest', 'most_viewed'].includes(String(data(input, 'order')))
}

export function internetTargetAtoms(
  capabilityId: string,
  target: FabricJsonObject,
  input: FabricJsonObject,
): string[] | null {
  if (!validateInternetSemantics(capabilityId, input) || !plainDataObject(target)
    || !exactDataKeys(target, ['kind', 'origin', 'profile', 'provider'])) return null
  const profile = data(input, 'profile')
  if (data(target, 'kind') !== 'internet_provider' || data(target, 'provider') !== BILIBILI_PROVIDER
    || data(target, 'origin') !== BILIBILI_ORIGIN || data(target, 'profile') !== profile) return null
  return [`internet:profile:${String(profile)}`, `internet:origin:${BILIBILI_ORIGIN}`,
    `internet:provider:${BILIBILI_PROVIDER}`]
}

export function validateInternetOutputSemantics(
  capabilityId: string,
  input: FabricJsonObject,
  output: FabricJsonObject,
): boolean {
  if (!isInternetCapability(capabilityId)) return true
  if (!validateInternetSemantics(capabilityId, input) || !plainDataObject(output)) return false
  if (data(output, 'provider') !== BILIBILI_PROVIDER || data(output, 'profile') !== data(input, 'profile')) return false
  if (capabilityId === BILIBILI_INSPECT_CAPABILITY) {
    if (data(output, 'operation') !== 'inspect') return false
    const video = data(output, 'video')
    return validNormalizedVideo(video) && data(video, 'bvid') === data(input, 'bvid')
  }
  if (data(output, 'operation') !== 'search' || data(output, 'query') !== data(input, 'query')) return false
  const videos = data(output, 'videos')
  const totalCount = data(output, 'totalCount')
  const omittedCount = data(output, 'omittedCount')
  if (!Array.isArray(videos) || videos.length > Number(data(input, 'limit'))
    || !Number.isSafeInteger(totalCount) || !Number.isSafeInteger(omittedCount)
    || Number(totalCount) !== videos.length + Number(omittedCount)) return false
  const ids = new Set<string>()
  for (let index = 0; index < videos.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(videos, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor) || !validNormalizedVideo(descriptor.value)) return false
    const bvid = String(data(descriptor.value, 'bvid'))
    if (ids.has(bvid)) return false
    ids.add(bvid)
  }
  return true
}

export function isBilibiliBvid(value: unknown): value is string {
  return typeof value === 'string' && BVID.test(value)
}

export function bilibiliVideoUrl(bvid: string): string {
  if (!isBilibiliBvid(bvid)) throw new InternetSemanticContractError('BILIBILI_BVID_INVALID')
  return `https://${BILIBILI_ORIGIN}/video/${bvid}`
}

export function bilibiliSearchUrl(input: Pick<Record<string, unknown>, 'query' | 'order' | 'page'>): string {
  const query = input.query
  const page = input.page
  const order = input.order
  if (typeof query !== 'string' || query.trim() !== query || !query || query.length > 120
    || !Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > 10
    || !['relevance', 'newest', 'most_viewed'].includes(String(order))) {
    throw new InternetSemanticContractError('BILIBILI_SEARCH_INPUT_INVALID')
  }
  const params = new URLSearchParams({ keyword: query,
    order: order === 'newest' ? 'pubdate' : order === 'most_viewed' ? 'click' : 'totalrank', page: String(page) })
  return `https://search.bilibili.com/all?${params.toString()}`
}

export function isAllowedBilibiliPublicUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
  if (url.hostname === BILIBILI_ORIGIN) {
    return /^\/video\/BV[0-9A-Za-z]{10}\/?$/.test(url.pathname) && !url.search
  }
  if (url.hostname !== 'search.bilibili.com' || url.pathname !== '/all') return false
  const keys = [...url.searchParams.keys()].sort()
  return keys.join(',') === 'keyword,order,page'
    && !!url.searchParams.get('keyword') && String(url.searchParams.get('keyword')).length <= 120
    && ['totalrank', 'pubdate', 'click'].includes(String(url.searchParams.get('order')))
    && /^(?:[1-9]|10)$/.test(String(url.searchParams.get('page')))
}

export function isBilibiliReadOnlyToolName(capabilityId: string, toolName: string): boolean {
  if (!isInternetCapability(capabilityId) || typeof toolName !== 'string' || toolName.length < 1 || toolName.length > 160
    || FORBIDDEN_TOOL.test(toolName)) return false
  return capabilityId === BILIBILI_SEARCH_CAPABILITY ? SEARCH_TOOL.test(toolName) : INSPECT_TOOL.test(toolName)
}

export function normalizeBilibiliSearchPayload(payload: unknown, requestedLimit: number): BilibiliSearchNormalization {
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 20) {
    throw new InternetSemanticContractError('BILIBILI_RESPONSE_BOUNDS_INVALID')
  }
  const items = resultItems(payload)
  if (items.length > 100) throw new InternetSemanticContractError('BILIBILI_RESPONSE_BOUNDS_INVALID')
  const unique = new Map<string, BilibiliVideoSummary>()
  for (let index = 0; index < items.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(items, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new InternetSemanticContractError('BILIBILI_RESPONSE_INVALID')
    }
    const normalized = normalizeBilibiliVideo(descriptor.value)
    if (normalized && !unique.has(normalized.bvid)) unique.set(normalized.bvid, normalized)
  }
  if (items.length > 0 && unique.size === 0) throw new InternetSemanticContractError('BILIBILI_RESPONSE_INVALID')
  const videos = [...unique.values()].slice(0, requestedLimit)
  const declared = declaredTotal(payload)
  const totalCount = Math.max(unique.size, declared ?? unique.size)
  return { videos, totalCount, omittedCount: totalCount - videos.length }
}

export function normalizeBilibiliInspectPayload(payload: unknown): {
  video: BilibiliVideoSummary; description: string; tags: string[]
} {
  const candidate = plainDataObject(payload) && data(payload, 'video') !== undefined ? data(payload, 'video') : payload
  const video = normalizeBilibiliVideo(candidate)
  if (!video || !plainDataObject(candidate)) throw new InternetSemanticContractError('BILIBILI_RESPONSE_INVALID')
  const rawDescription = data(candidate, 'description') ?? data(candidate, 'desc') ?? ''
  const description = typeof rawDescription === 'string' ? boundedCleanText(rawDescription, 2_000, true) : ''
  const rawTags = data(candidate, 'tags')
  const tags = normalizeTags(rawTags)
  return { video, description, tags }
}

function normalizeBilibiliVideo(value: unknown): BilibiliVideoSummary | null {
  if (!plainDataObject(value)) return null
  const bvid = data(value, 'bvid')
  const title = cleanCandidateText(data(value, 'title'), 200)
  const owner = data(value, 'owner')
  const authorValue = data(value, 'author') ?? data(value, 'uploader')
    ?? (plainDataObject(owner) ? data(owner, 'name') : undefined)
  const author = cleanCandidateText(authorValue, 120)
  if (!isBilibiliBvid(bvid) || title === null || author === null) return null
  return {
    bvid, title, author,
    publishedAt: normalizePublishedAt(data(value, 'publishedAt') ?? data(value, 'pubdate')),
    durationSeconds: normalizeDuration(data(value, 'durationSeconds') ?? data(value, 'duration')),
    viewCount: normalizeCount(data(value, 'viewCount') ?? data(value, 'play')),
    canonicalUrl: bilibiliVideoUrl(bvid),
  }
}

function validNormalizedVideo(value: unknown): value is FabricJsonObject {
  if (!plainDataObject(value) || !exactDataKeys(value,
    ['author', 'bvid', 'canonicalUrl', 'durationSeconds', 'publishedAt', 'title', 'viewCount'])) return false
  const bvid = data(value, 'bvid')
  return isBilibiliBvid(bvid) && data(value, 'canonicalUrl') === bilibiliVideoUrl(bvid)
    && cleanCandidateText(data(value, 'title'), 200) === data(value, 'title')
    && cleanCandidateText(data(value, 'author'), 120) === data(value, 'author')
    && nullableInteger(data(value, 'durationSeconds'), 86_400)
    && nullableInteger(data(value, 'viewCount'), Number.MAX_SAFE_INTEGER)
    && (data(value, 'publishedAt') === null || normalizedTimestamp(data(value, 'publishedAt')) === data(value, 'publishedAt'))
}

function resultItems(payload: unknown): unknown[] {
  if (Array.isArray(payload) && !isProxy(payload)) return denseArray(payload)
  if (!plainDataObject(payload)) throw new InternetSemanticContractError('BILIBILI_RESPONSE_INVALID')
  const value = data(payload, 'videos') ?? data(payload, 'items')
  if (!Array.isArray(value) || isProxy(value)) throw new InternetSemanticContractError('BILIBILI_RESPONSE_INVALID')
  return denseArray(value)
}

function denseArray(value: unknown[]): unknown[] {
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key === 'symbol' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
    throw new InternetSemanticContractError('BILIBILI_RESPONSE_INVALID')
  }
  return value
}

function declaredTotal(payload: unknown): number | null {
  if (!plainDataObject(payload)) return null
  const value = data(payload, 'totalCount') ?? data(payload, 'total')
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function normalizePublishedAt(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value
    const date = new Date(milliseconds)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
  return normalizedTimestamp(value)
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function normalizeDuration(value: unknown): number | null {
  if (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 86_400) return Number(value)
  if (typeof value !== 'string') return null
  if (/^\d{1,5}$/.test(value)) return normalizeDuration(Number(value))
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)) return null
  const parts = value.split(':').map(Number)
  const seconds = parts.length === 2 ? parts[0]! * 60 + parts[1]! : parts[0]! * 3_600 + parts[1]! * 60 + parts[2]!
  return parts.some(part => part < 0 || part >= 60) || seconds > 86_400 ? null : seconds
}

function normalizeCount(value: unknown): number | null {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value)
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value)) {
    const count = Number(value)
    return Number.isSafeInteger(count) ? count : null
  }
  return null
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || isProxy(value) || value.length > 64) {
    throw new InternetSemanticContractError('BILIBILI_RESPONSE_INVALID')
  }
  const result: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new InternetSemanticContractError('BILIBILI_RESPONSE_INVALID')
    }
    const raw = plainDataObject(descriptor.value) ? data(descriptor.value, 'name') : descriptor.value
    const tag = cleanCandidateText(raw, 80)
    if (tag && !result.includes(tag) && result.length < 32) result.push(tag)
  }
  return result
}

function cleanCandidateText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  try { return boundedCleanText(value, maximum, false) } catch { return null }
}

function boundedCleanText(value: string, maximum: number, allowEmpty: boolean): string {
  const text = value.replace(/<[^>]{0,512}>/g, '').replace(/\s+/g, ' ').trim()
  if ((!allowEmpty && !text) || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new InternetSemanticContractError('BILIBILI_RESPONSE_INVALID')
  }
  return text
}

function nullableInteger(value: unknown, maximum: number): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum)
}

function plainDataObject(value: unknown): value is FabricJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string'
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && 'value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}))
}

function data(value: unknown, key: string): unknown {
  if (!plainDataObject(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined
}

function exactDataKeys(value: FabricJsonObject, expected: string[]): boolean {
  const keys = Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string').sort()
  const sorted = [...expected].sort()
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index])
}
