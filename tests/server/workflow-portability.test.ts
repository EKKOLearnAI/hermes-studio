import { describe, expect, it } from 'vitest'
import { compileWorkflowGraphPreflight } from '../../packages/server/src/services/workflow-manager'
import { cancelWorkflowImport, exportWorkflowDefinition, previewWorkflowImport, confirmWorkflowImport } from '../../packages/server/src/services/workflow-portability'

const workflow = {
  id: 'wf-secret-id', name: 'Portable flow', profile: 'private-profile', workspace: '/private/workspace',
  nodes: [
    { id: 'source', type: 'agent', position: { x: 10, y: 20 }, data: { title: 'Source', agent: 'hermes', input: 'go', provider: 'openai', model: 'gpt-test', apiMode: 'chat_completions', token: 'secret' } },
    { id: 'target', type: 'agent', position: { x: 30, y: 40 }, data: { title: 'Target', agent: 'hermes', input: 'finish' } },
  ], edges: [{ id: 'edge-1', source: 'source', target: 'target', data: { orchestration: { route: 'success' } } }],
  viewport: { x: 1, y: 2, zoom: 1 }, created_at: 1, updated_at: 2,
}
const options = (ownerId = 'u1', profile = 'default', now = () => 1000) => ({ ownerId, profile, now, validateGraph: compileWorkflowGraphPreflight })

describe('workflow portability', () => {
  it('exports portable workflow logic without source-environment runtime bindings', () => {
    const exported = exportWorkflowDefinition({
      id: 'wf', name: 'Portable identity', profile: 'private', workspace: '/private/path',
      nodes: [{ id: 'n', type: 'agent', position: { x: 0, y: 0 }, data: {
        title: 'N', agent: 'hermes', provider: 'custom:test', model: 'model-a', apiMode: 'chat_completions',
        reasoningEffort: 'high', executionPolicy: { allowedToolsets: [], allowedTools: ['browser_click'], skipMemory: true },
        token: 'secret', session_id: 'runtime',
      } }], edges: [], viewport: null,
    } as any)
    expect(exported.definition.nodes[0].data).toEqual({ title: 'N', agent: 'hermes' })
    expect(exported.definition.nodes[0].data).not.toHaveProperty('provider')
    expect(exported.definition.nodes[0].data).not.toHaveProperty('model')
    expect(exported.definition.nodes[0].data).not.toHaveProperty('apiMode')
    expect(exported.definition.nodes[0].data).not.toHaveProperty('reasoningEffort')
    expect(exported.definition.nodes[0].data).not.toHaveProperty('executionPolicy')
    expect(JSON.stringify(exported)).not.toContain('secret')
    expect(JSON.stringify(exported)).not.toContain('/private/path')
    expect(JSON.stringify(exported)).not.toContain('custom:test')
  })

  it('sanitizes source-environment bindings from legacy v1 documents before import', () => {
    const legacy = {
      format: 'hermes-studio.workflow', version: 1, definition: {
        name: 'Cross environment',
        nodes: [{ id: 'agent-1', type: 'agent', position: { x: 0, y: 0 }, data: {
          title: 'Portable node', agent: 'hermes', provider: 'custom:source-only', model: 'source-model',
          apiMode: 'chat_completions', reasoningEffort: 'max', input: 'work', skills: ['portable-skill'],
          approvalRequired: false, orchestration: { join: 'all' },
        } }],
        edges: [], viewport: { x: 0, y: 0, zoom: 1 },
      },
    }
    const preview = previewWorkflowImport(JSON.stringify(legacy), options('cross-owner', 'target-profile'))
    const imported = confirmWorkflowImport(preview.token, options('cross-owner', 'target-profile'))
    expect(imported.nodes[0].data).toEqual({
      title: 'Portable node', agent: 'hermes', input: 'work', skills: ['portable-skill'],
      approvalRequired: false, orchestration: { join: 'all' },
    })
  })

  it('accepts legacy imports with removed execution-policy fields and strips them from the imported definition', () => {
    const legacy = exportWorkflowDefinition(workflow as any) as any
    legacy.definition.nodes[0].data.executionPolicy = {
      allowedToolsets: [], allowedTools: [], skipMemory: true, skipContextFiles: true,
    }
    const preview = previewWorkflowImport(JSON.stringify(legacy), options('legacy-owner', 'default'))
    const imported = confirmWorkflowImport(preview.token, options('legacy-owner', 'default'))
    expect(imported.nodes[0].data).not.toHaveProperty('executionPolicy')
  })

  it('exports a versioned credential-free definition without runtime or machine state', () => {
    const envelope = exportWorkflowDefinition(workflow as any)
    expect(envelope).toEqual({ format: 'hermes-studio.workflow', version: 1, definition: {
      name: 'Portable flow', nodes: [
        { id: 'source', type: 'agent', position: { x: 10, y: 20 }, data: { title: 'Source', agent: 'hermes', input: 'go' } },
        { id: 'target', type: 'agent', position: { x: 30, y: 40 }, data: { title: 'Target', agent: 'hermes', input: 'finish' } },
      ], edges: [{ id: 'edge-1', source: 'source', target: 'target', data: { orchestration: { route: 'success' } } }], viewport: { x: 1, y: 2, zoom: 1 },
    } })
    expect(JSON.stringify(envelope)).not.toMatch(/secret|workspace|private-profile|wf-secret-id|created_at|updated_at/i)
  })
  it('rejects oversized, unsupported, credential-bearing, and non-agent imports', () => {
    const valid = exportWorkflowDefinition(workflow as any)
    expect(() => previewWorkflowImport(JSON.stringify(valid), options())).not.toThrow()
    expect(() => previewWorkflowImport('x'.repeat(1024 * 1024 + 1), options())).toThrow('exceeds 1048576 bytes')
    expect(() => previewWorkflowImport(JSON.stringify({ ...valid, version: 2 }), options())).toThrow('unsupported workflow import version')
    const credential = structuredClone(valid) as any; credential.definition.nodes[0].data.apiKey = 'secret'
    expect(() => previewWorkflowImport(JSON.stringify(credential), options())).toThrow('credential field')
    const shell = structuredClone(valid) as any; shell.definition.nodes[0].type = 'shell'
    expect(() => previewWorkflowImport(JSON.stringify(shell), options())).toThrow('Agent-only')
  })

  it('rejects malformed top-level fields and preserves legacy missing orchestration without materializing it', () => {
    const valid = exportWorkflowDefinition(workflow as any) as any
    const unknown = structuredClone(valid); unknown.definition.workspace = '/forbidden'
    expect(() => previewWorkflowImport(JSON.stringify(unknown), options())).toThrow('unsupported definition field: workspace')
    const runtime = structuredClone(valid); runtime.definition.nodes[0].data.status = 'completed'
    expect(() => previewWorkflowImport(JSON.stringify(runtime), options())).toThrow('unsupported node data field: status')
    const nestedNode = structuredClone(valid); nestedNode.definition.nodes[0].data.orchestration = { join: 'all', hidden: true }
    expect(() => previewWorkflowImport(JSON.stringify(nestedNode), options())).toThrow('unsupported node orchestration field: hidden')
    const nestedPolicy = structuredClone(valid); nestedPolicy.definition.nodes[0].data.executionPolicy = { allowedTools: [], apiKey: 'secret' }
    expect(() => previewWorkflowImport(JSON.stringify(nestedPolicy), options())).toThrow('credential field')
    const nestedEdge = structuredClone(valid); nestedEdge.definition.edges[0].data.orchestration.condition = { path: 'output', operator: 'exists', script: 'evil' }
    expect(() => previewWorkflowImport(JSON.stringify(nestedEdge), options())).toThrow('unsupported edge condition field: script')

    const legacy = structuredClone(valid)
    delete legacy.definition.edges[0].data
    const preview = previewWorkflowImport(JSON.stringify(legacy), options('legacy-owner'))
    const imported = confirmWorkflowImport(preview.token, options('legacy-owner')) as any
    expect(imported.edges[0]).not.toHaveProperty('data')
  })


  it('invalidates a preview when the target environment revision changes', () => {
    const raw = JSON.stringify(exportWorkflowDefinition(workflow as any))
    const preview = previewWorkflowImport(raw, { ...options('u1', 'default'), environmentRevision: 'rev-1' })
    expect(() => confirmWorkflowImport(preview.token, { ...options('u1', 'default'), environmentRevision: 'rev-2' })).toThrow('environment changed')
  })


  it('consumes the preview token before final validation so failed confirmations cannot be replayed', () => {
    const raw = JSON.stringify(exportWorkflowDefinition(workflow as any))
    const preview = previewWorkflowImport(raw, options('consume-owner'))
    const failing = { ...options('consume-owner'), validateGraph: () => { throw new Error('capability unavailable') } }
    expect(() => confirmWorkflowImport(preview.token, failing)).toThrow('capability unavailable')
    expect(() => confirmWorkflowImport(preview.token, options('consume-owner'))).toThrow('not available')
  })

  it('binds confirmation and remaps all identities', () => {
    let now = 1000
    const preview = previewWorkflowImport(JSON.stringify(exportWorkflowDefinition(workflow as any)), options('u1', 'default', () => now))
    expect(() => confirmWorkflowImport(preview.token, options('u2', 'default', () => now))).toThrow('not available')
    expect(() => confirmWorkflowImport(preview.token, options('u1', 'other', () => now))).toThrow('not available')
    const imported = confirmWorkflowImport(preview.token, options('u1', 'default', () => now))
    expect(imported.nodes.map((node: any) => node.id)).not.toContain('source')
    expect(imported.edges[0].source).toBe(imported.nodes[0].id)
    expect(imported.edges[0].target).toBe(imported.nodes[1].id)
    expect(imported.edges[0].id).not.toBe('edge-1')
    expect(() => confirmWorkflowImport(preview.token, options('u1', 'default', () => now))).toThrow('not available')
    const expired = previewWorkflowImport(JSON.stringify(exportWorkflowDefinition(workflow as any)), options('u1', 'default', () => now))
    now += 5 * 60 * 1000 + 1
    expect(() => confirmWorkflowImport(expired.token, options('u1', 'default', () => now))).toThrow('expired')
  })

  it('sanitizes nested definition objects and never exports credential-shaped condition data', () => {
    const nested = {
      id: 'wf', name: 'Nested allowlist', profile: 'default', workspace: null,
      nodes: [{ id: 'n', type: 'agent', position: { x: 0, y: 0 }, data: {
        title: 'N', agent: 'hermes', executionPolicy: { allowedTools: ['terminal'], token: 'drop-me' },
        orchestration: { join: 'all', runtimeState: 'drop-me' },
      } }],
      edges: [], viewport: null, created_at: 1, updated_at: 1,
    }
    const exported = exportWorkflowDefinition(nested as any)
    expect(exported.definition.nodes[0].data).toMatchObject({ orchestration: { join: 'all' } })
    expect(exported.definition.nodes[0].data).not.toHaveProperty('executionPolicy')
    expect(JSON.stringify(exported)).not.toContain('drop-me')

    const unsafeCondition = structuredClone(nested) as any
    unsafeCondition.edges = [{ id: 'e', source: 'n', target: 'n', data: { orchestration: {
      route: 'success', condition: { path: 'output', operator: 'equals', value: { token: 'secret' } },
    } } }]
    expect(() => exportWorkflowDefinition(unsafeCondition)).toThrow('credential field: token')
  })

  it('cancel consumes a matching preview and cannot invalidate another owner or profile preview', () => {
    const raw = JSON.stringify(exportWorkflowDefinition(workflow as any))
    const preview = previewWorkflowImport(raw, options('cancel-owner', 'default'))
    expect(cancelWorkflowImport(preview.token, 'other-owner', 'default')).toBe(false)
    expect(cancelWorkflowImport(preview.token, 'cancel-owner', 'other')).toBe(false)
    expect(cancelWorkflowImport(preview.token, 'cancel-owner', 'default')).toBe(true)
    expect(cancelWorkflowImport(preview.token, 'cancel-owner', 'default')).toBe(false)
    expect(() => confirmWorkflowImport(preview.token, options('cancel-owner', 'default'))).toThrow('not available')
  })

})
