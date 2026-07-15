import { describe, expect, it } from 'vitest'
import { validateFabricSchema } from '../../packages/server/src/services/hermes/action-fabric'
import {
  BILIBILI_INSPECT_CAPABILITY,
  BILIBILI_SEARCH_CAPABILITY,
  bilibiliSearchUrl,
  bilibiliVideoUrl,
  INTERNET_FABRIC_CAPABILITIES,
  internetTargetAtoms,
  InternetSemanticContractError,
  isAllowedBilibiliPublicUrl,
  isBilibiliBvid,
  isBilibiliReadOnlyToolName,
  normalizeBilibiliInspectPayload,
  normalizeBilibiliSearchPayload,
  validateInternetOutputSemantics,
  validateInternetSemantics,
} from '../../packages/server/src/services/hermes/internet-execution'

describe('internet execution semantic contracts', () => {
  it('defines only bounded read-only Bilibili search and inspect capabilities', () => {
    expect(INTERNET_FABRIC_CAPABILITIES.map(item => ({
      id: item.id, sideEffect: item.sideEffect, risk: item.risk, idempotency: item.idempotency,
      verification: item.verificationStrategy,
    }))).toEqual([
      { id: 'bilibili.video.search', sideEffect: false, risk: 'low', idempotency: 'supported',
        verification: 'second_read_bvid_overlap' },
      { id: 'bilibili.video.inspect', sideEffect: false, risk: 'low', idempotency: 'supported',
        verification: 'second_read_exact_bvid' },
    ])
    const search = INTERNET_FABRIC_CAPABILITIES[0]!
    const input = searchInput()
    expect(validateFabricSchema(input, search.inputSchema)).toBe(true)
    for (const injected of [
      { tool: 'search_videos' }, { server: 'bilibili' }, { url: 'https://example.com' },
      { browserAction: 'click' }, { action: 'like' }, { comment: 'write' }, { rawArguments: {} },
    ]) {
      expect(validateFabricSchema({ ...input, ...injected }, search.inputSchema)).toBe(false)
    }
    expect(INTERNET_FABRIC_CAPABILITIES.some(item => /(?:publish|comment|like|favorite|follow)/.test(item.id))).toBe(false)
  })

  it('requires exact plain semantic inputs without invoking accessors', () => {
    expect(validateInternetSemantics(BILIBILI_SEARCH_CAPABILITY, searchInput())).toBe(true)
    expect(validateInternetSemantics(BILIBILI_INSPECT_CAPABILITY, inspectInput())).toBe(true)
    expect(validateInternetSemantics(BILIBILI_SEARCH_CAPABILITY, { ...searchInput(), query: ' padded ' })).toBe(false)
    expect(validateInternetSemantics(BILIBILI_INSPECT_CAPABILITY, { ...inspectInput(), bvid: 'av123' })).toBe(false)
    expect(validateInternetSemantics('bilibili.video.like', searchInput())).toBe(false)
    let getterCalls = 0
    const poisoned = { ...searchInput() }
    Object.defineProperty(poisoned, 'query', { enumerable: true, get: () => { getterCalls += 1; return 'leak' } })
    expect(validateInternetSemantics(BILIBILI_SEARCH_CAPABILITY, poisoned)).toBe(false)
    expect(getterCalls).toBe(0)
  })

  it('derives exact profile, origin, and provider target atoms', () => {
    const input = searchInput()
    const target = { kind: 'internet_provider', provider: 'bilibili', origin: 'www.bilibili.com', profile: 'default' }
    expect(internetTargetAtoms(BILIBILI_SEARCH_CAPABILITY, target, input)).toEqual([
      'internet:profile:default', 'internet:origin:www.bilibili.com', 'internet:provider:bilibili',
    ])
    expect(internetTargetAtoms(BILIBILI_SEARCH_CAPABILITY, { ...target, profile: 'other' }, input)).toBeNull()
    expect(internetTargetAtoms(BILIBILI_SEARCH_CAPABILITY, { ...target, url: 'https://evil.example' }, input)).toBeNull()
    expect(internetTargetAtoms('bilibili.video.like', target, input)).toBeNull()
  })

  it('constructs only public bounded Bilibili URLs from semantic fields', () => {
    expect(isBilibiliBvid('BV1xx411c7mD')).toBe(true)
    expect(bilibiliVideoUrl('BV1xx411c7mD')).toBe('https://www.bilibili.com/video/BV1xx411c7mD')
    expect(bilibiliSearchUrl({ query: 'Hermes AI', order: 'newest', page: 2 }))
      .toBe('https://search.bilibili.com/all?keyword=Hermes+AI&order=pubdate&page=2')
    expect(isAllowedBilibiliPublicUrl('https://www.bilibili.com/video/BV1xx411c7mD')).toBe(true)
    expect(isAllowedBilibiliPublicUrl('https://search.bilibili.com/all?keyword=Hermes+AI&order=pubdate&page=2')).toBe(true)
    for (const url of [
      'http://www.bilibili.com/video/BV1xx411c7mD',
      'https://www.bilibili.com/account',
      'https://evil.example/video/BV1xx411c7mD',
      'https://localhost/video/BV1xx411c7mD',
      'https://127.0.0.1/video/BV1xx411c7mD',
      'https://[::1]/video/BV1xx411c7mD',
      'https://user:password@www.bilibili.com/video/BV1xx411c7mD',
      'https://search.bilibili.com/all?keyword=x&order=pubdate&page=2&token=secret',
      'file:///etc/passwd',
    ]) expect(isAllowedBilibiliPublicUrl(url)).toBe(false)
    expect(() => bilibiliVideoUrl('not-a-bvid')).toThrow(InternetSemanticContractError)
  })

  it('normalizes bounded provider search results to unique computed video identities', () => {
    const normalized = normalizeBilibiliSearchPayload({ total: 8, items: [
      { bvid: 'BV1xx411c7mD', title: '<em>Hermes</em> AI', author: 'Alice', pubdate: 1_700_000_000,
        duration: '03:12', play: '1234', url: 'https://evil.example/ignored' },
      { bvid: 'BV1xx411c7mD', title: 'duplicate', author: 'Alice' },
      { bvid: 'BV1yy411c7mE', title: 'Second', owner: { name: 'Bob' }, durationSeconds: 90, viewCount: 10 },
      { bvid: 'invalid', title: 'Dropped', author: 'Mallory' },
    ] }, 2)
    expect(normalized).toEqual({
      videos: [
        { bvid: 'BV1xx411c7mD', title: 'Hermes AI', author: 'Alice',
          publishedAt: '2023-11-14T22:13:20.000Z', durationSeconds: 192, viewCount: 1234,
          canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' },
        { bvid: 'BV1yy411c7mE', title: 'Second', author: 'Bob', publishedAt: null,
          durationSeconds: 90, viewCount: 10, canonicalUrl: 'https://www.bilibili.com/video/BV1yy411c7mE' },
      ],
      totalCount: 8,
      omittedCount: 6,
    })
    expect(() => normalizeBilibiliSearchPayload({ items: [{ raw: 'unrecognized' }] }, 5))
      .toThrowError('BILIBILI_RESPONSE_INVALID')
    expect(() => normalizeBilibiliSearchPayload({ items: Array.from({ length: 101 }, () => ({})) }, 5))
      .toThrowError('BILIBILI_RESPONSE_BOUNDS_INVALID')
  })

  it('normalizes one inspect result and enforces output identity and count semantics', () => {
    const inspected = normalizeBilibiliInspectPayload({ video: {
      bvid: 'BV1xx411c7mD', title: 'Hermes', uploader: 'Alice', description: '  public   description ',
      tags: ['AI', { name: 'Agent' }, 'AI'], duration: 30, play: 4,
    } })
    expect(inspected).toMatchObject({
      video: { bvid: 'BV1xx411c7mD', canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      description: 'public description', tags: ['AI', 'Agent'],
    })
    const inspectOutput = {
      schemaVersion: 1, provider: 'bilibili', profile: 'default', operation: 'inspect', status: 'succeeded',
      video: inspected.video, description: inspected.description, tags: inspected.tags,
    }
    expect(validateInternetOutputSemantics(BILIBILI_INSPECT_CAPABILITY, inspectInput(), inspectOutput)).toBe(true)
    expect(validateInternetOutputSemantics(BILIBILI_INSPECT_CAPABILITY, inspectInput(), {
      ...inspectOutput, video: { ...inspected.video, canonicalUrl: 'https://evil.example/video/BV1xx411c7mD' },
    })).toBe(false)

    const searchOutput = {
      schemaVersion: 1, provider: 'bilibili', profile: 'default', operation: 'search', query: 'Hermes AI',
      status: 'partial', videos: [inspected.video], totalCount: 3, omittedCount: 2,
    }
    expect(validateInternetOutputSemantics(BILIBILI_SEARCH_CAPABILITY, searchInput(), searchOutput)).toBe(true)
    expect(validateInternetOutputSemantics(BILIBILI_SEARCH_CAPABILITY, searchInput(), {
      ...searchOutput, omittedCount: 1,
    })).toBe(false)
    expect(validateInternetOutputSemantics(BILIBILI_SEARCH_CAPABILITY, searchInput(), {
      ...searchOutput, videos: [inspected.video, inspected.video], totalCount: 4,
    })).toBe(false)
  })

  it('allows only discovery-shaped tool bindings and rejects mutation-shaped tools', () => {
    expect(isBilibiliReadOnlyToolName(BILIBILI_SEARCH_CAPABILITY, 'search_videos')).toBe(true)
    expect(isBilibiliReadOnlyToolName(BILIBILI_INSPECT_CAPABILITY, 'get_video_info')).toBe(true)
    for (const name of ['publish_video', 'like_video', 'add_favorite', 'comment_search_result', 'login_account',
      'search_videos\npublish_video', 'search_videos; delete_account']) {
      expect(isBilibiliReadOnlyToolName(BILIBILI_SEARCH_CAPABILITY, name)).toBe(false)
      expect(isBilibiliReadOnlyToolName(BILIBILI_INSPECT_CAPABILITY, name)).toBe(false)
    }
    expect(isBilibiliReadOnlyToolName('bilibili.video.like', 'search_videos')).toBe(false)
  })
})

function searchInput() {
  return { schemaVersion: 1, provider: 'bilibili', profile: 'default', query: 'Hermes AI', limit: 5,
    page: 1, order: 'relevance' }
}

function inspectInput() {
  return { schemaVersion: 1, provider: 'bilibili', profile: 'default', bvid: 'BV1xx411c7mD' }
}
