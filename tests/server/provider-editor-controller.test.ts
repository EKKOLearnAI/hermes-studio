import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  MockProviderEditorError,
  mockGetEditor,
  mockPatchEditor,
  mockPatchContexts,
  mockTestDraft,
  mockAppendAudit,
} = vi.hoisted(() => {
  class ProviderEditorError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
      readonly current?: any,
    ) {
      super(message)
    }
  }
  return {
    MockProviderEditorError: ProviderEditorError,
    mockGetEditor: vi.fn(),
    mockPatchEditor: vi.fn(),
    mockPatchContexts: vi.fn(),
    mockTestDraft: vi.fn(),
    mockAppendAudit: vi.fn(),
  }
})

vi.mock('../../packages/server/src/services/hermes/provider-editor', () => ({
  ProviderEditorError: MockProviderEditorError,
  getProviderEditorDetail: mockGetEditor,
  updateProviderEditorDetail: mockPatchEditor,
  updateProviderContextLengths: mockPatchContexts,
  testProviderEditorDraft: mockTestDraft,
}))

vi.mock('../../packages/server/src/db/hermes/provider-audit-store', () => ({
  appendProviderAuditEvent: mockAppendAudit,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'default',
  getProfileDir: (profile: string) => `/profiles/${profile}`,
}))

import {
  getEditor,
  patchEditor,
  patchEditorContexts,
  testEditor,
} from '../../packages/server/src/controllers/hermes/providers'

const detail = {
  id: 'custom:test-provider',
  label: 'Test Provider',
  builtin: false,
  source: 'custom_providers',
  base_url: 'https://models.example/v1',
  preferred_model: 'model-a',
  credential_configured: true,
  editable: true,
  editable_fields: ['label', 'base_url', 'api_key'],
  context_lengths: {},
  connection_test_supported: true,
  revision: 'revision-2',
}

function makeCtx(body: Record<string, unknown> = {}, ifMatch = ''): any {
  const headers: Record<string, string> = {}
  return {
    params: { poolKey: 'custom%3Atest-provider' },
    request: { body },
    headers: ifMatch ? { 'if-match': ifMatch } : {},
    state: {
      profile: { name: 'research' },
      user: { id: 7, username: 'admin', role: 'admin' },
    },
    body: undefined,
    status: 200,
    get: (name: string) => name.toLowerCase() === 'if-match' ? ifMatch : '',
    set: (name: string, value: string) => { headers[name] = value },
    responseHeaders: headers,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetEditor.mockResolvedValue(detail)
  mockPatchEditor.mockResolvedValue({ before: { ...detail, revision: 'revision-1' }, detail, changed: ['label'] })
  mockPatchContexts.mockResolvedValue({ before: { ...detail, revision: 'revision-1' }, detail, changed: ['context_lengths.model-a'] })
  mockTestDraft.mockResolvedValue({ models: ['model-a'], model_count: 1 })
})

describe('provider editor controllers', () => {
  it('returns redacted editor metadata with an ETag for the request-scoped profile', async () => {
    const ctx = makeCtx()
    await getEditor(ctx)

    expect(mockGetEditor).toHaveBeenCalledWith('research', 'custom:test-provider')
    expect(ctx.responseHeaders.ETag).toBe('"revision-2"')
    expect(ctx.body).toEqual({ provider: detail })
    expect(ctx.body.provider).not.toHaveProperty('api_key')
  })

  it('forwards If-Match and records a redacted successful update audit event', async () => {
    const ctx = makeCtx({ label: 'Renamed', credential_action: 'keep' }, '"revision-1"')
    await patchEditor(ctx)

    expect(mockPatchEditor).toHaveBeenCalledWith(
      'research',
      'custom:test-provider',
      { label: 'Renamed', credential_action: 'keep' },
      '"revision-1"',
    )
    expect(ctx.responseHeaders.ETag).toBe('"revision-2"')
    expect(mockAppendAudit).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'research',
      providerId: 'custom:test-provider',
      action: 'provider.editor.update',
      fields: ['label'],
      details: { credential_configured: true },
    }))
    expect(JSON.stringify(mockAppendAudit.mock.calls)).not.toContain('api_key')
  })

  it('returns HTTP 412 with current redacted state and audits the conflict', async () => {
    mockPatchEditor.mockRejectedValueOnce(new MockProviderEditorError(
      'Provider configuration changed; reload before saving',
      412,
      'REVISION_CONFLICT',
      detail,
    ))
    const ctx = makeCtx({ label: 'Stale' }, '"revision-1"')
    await patchEditor(ctx)

    expect(ctx.status).toBe(412)
    expect(ctx.body).toMatchObject({ code: 'REVISION_CONFLICT', current: detail })
    expect(mockAppendAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'provider.editor.update',
      result: 'conflict',
      details: { code: 'REVISION_CONFLICT', status: 412 },
    }))
  })

  it('chains context revisions and reports supported draft-test failures without a transport error', async () => {
    const contextCtx = makeCtx({ context_lengths: { 'model-a': 128000 } }, '"revision-1"')
    await patchEditorContexts(contextCtx)
    expect(mockPatchContexts).toHaveBeenCalledWith(
      'research',
      'custom:test-provider',
      { 'model-a': 128000 },
      '"revision-1"',
    )

    mockTestDraft.mockRejectedValueOnce(new MockProviderEditorError('Empty catalog', 422, 'PROVIDER_EMPTY_CATALOG'))
    const testCtx = makeCtx({ base_url: 'https://draft.example/v1' })
    await testEditor(testCtx)
    expect(testCtx.status).toBe(200)
    expect(testCtx.body).toEqual({ success: false, error: 'Empty catalog', code: 'PROVIDER_EMPTY_CATALOG' })
  })
})
