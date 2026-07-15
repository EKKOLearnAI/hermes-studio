import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { openapi } from '../../packages/server/src/controllers/api-docs'

describe('home OpenAPI', () => {
  it('publishes seventeen authenticated Home operations with strict semantic command bodies', async () => {
    const ctx: any = { set: () => undefined, body: null }
    await openapi(ctx)
    const paths = {
      '/api/hermes/home/overview': ['get'],
      '/api/hermes/home/map': ['get'],
      '/api/hermes/home/layout': ['get'],
      '/api/hermes/home/spaces': ['get', 'post'],
      '/api/hermes/home/inventory': ['get'],
      '/api/hermes/home/inventory/{id}': ['put'],
      '/api/hermes/home/inventory/{id}/adjust': ['post'],
      '/api/hermes/home/imports/legacy': ['post'],
      '/api/hermes/home/devices': ['get'],
      '/api/hermes/home/bindings': ['get'],
      '/api/hermes/home/provider': ['get'],
      '/api/hermes/home/devices/{id}/refresh': ['post'],
      '/api/hermes/home/devices/{id}/commands': ['post'],
      '/api/hermes/home/scenes/{id}/activate': ['post'],
      '/api/hermes/home/workflows/{id}': ['get'],
      '/api/hermes/home/workflows/{id}/review': ['post'],
    } as const
    const operations = Object.entries(paths).flatMap(([path, methods]) => methods.map(method => ctx.body.paths[path]?.[method]))
    expect(operations).toHaveLength(17)
    expect(operations.every(operation => operation?.tags?.[0] === 'Home')).toBe(true)
    expect(operations.every(operation => Array.isArray(operation?.security?.[0]?.BearerAuth))).toBe(true)

    const commands = ctx.body.paths['/api/hermes/home/devices/{id}/commands'].post
      .requestBody.content['application/json'].schema
    expect(commands.oneOf.map((item: any) => item.properties.command.enum[0]))
      .toEqual(['set_power', 'set_level', 'set_temperature'])
    for (const item of commands.oneOf) {
      expect(item.additionalProperties).toBe(false)
      expect(item.properties).not.toHaveProperty('service')
      expect(item.properties).not.toHaveProperty('service_data')
      expect(item.required).toContain('idempotencyKey')
    }
    expect(ctx.body.paths['/api/hermes/home/workflows/{id}/review'].post.requestBody.content['application/json']
      .schema.oneOf).toEqual([
      expect.objectContaining({ additionalProperties: false, required: ['action'],
        properties: { action: { type: 'string', enum: ['approve'] } } }),
      expect.objectContaining({ additionalProperties: false, required: ['action', 'reason'],
        properties: expect.objectContaining({ action: { type: 'string', enum: ['reject'] } }) }),
    ])
    expect(ctx.body.paths['/api/hermes/home/devices/{id}/commands'].post.responses['202']).toBeTruthy()
    expect(ctx.body.paths['/api/hermes/home/spaces'].post.responses['201']).toBeTruthy()
    const legacyImport = ctx.body.paths['/api/hermes/home/imports/legacy'].post.requestBody
      .content['application/json'].schema
    expect(legacyImport).toMatchObject({ additionalProperties: false,
      properties: { profiles: { minItems: 1, maxItems: 50, uniqueItems: true } } })
    expect(ctx.body.paths['/api/hermes/home/overview'].get.parameters)
      .toContainEqual(expect.objectContaining({ name: 'profile', in: 'query', required: false }))
    expect(ctx.body.components.schemas.HomeApiError.properties.code.pattern).toBe('^HOME_[A-Z0-9_]+$')
  })

  it('keeps public Home DTOs credential-free and bounded', async () => {
    const ctx: any = { set: () => undefined, body: null }
    await openapi(ctx)
    const names = ['HomeOverviewResponse', 'HomeProviderResponse', 'HomeSpaceListResponse', 'HomeSpaceResponse',
      'HomeInventoryListResponse', 'HomeInventoryResponse', 'HomeInventoryAdjustmentResponse',
      'HomeDeviceListResponse', 'HomeBindingListResponse', 'HomeActionResponse', 'HomeWorkflowResponse',
      'HomeLegacyOverviewDto', 'HomeLegacyMapDto', 'HomeLegacyImportResponse']
    for (const name of names) {
      const encoded = JSON.stringify(ctx.body.components.schemas[name])
      expect(encoded).not.toMatch(/token|password|secret|credential|service_data/i)
    }
    expect(ctx.body.components.schemas.HomeProviderDto.properties).not.toHaveProperty('credentialFingerprint')
    expect(ctx.body.components.schemas.HomeLegacyMapDto.properties.placements.items.properties.targetType).toEqual({
      type: 'string', pattern: '^(object|inventory_batch|asset|device)$', maxLength: 15,
    })
    expect(ctx.body.components.schemas.HomeDeviceListResponse.properties.devices.maxItems).toBe(200)
    expect(ctx.body.components.schemas.HomeDeviceDto.properties.bindings.maxItems).toBe(50)
    expect(ctx.body.components.schemas.HomeWorkflowDetailDto.properties.steps.maxItems).toBe(16)
  })

  it('regenerates deterministically', () => {
    const before = readFileSync('docs/openapi.json', 'utf8')
    const generated = spawnSync(process.execPath, ['scripts/generate-openapi.mjs'], { encoding: 'utf8' })
    expect(generated.status, generated.stderr).toBe(0)
    expect(readFileSync('docs/openapi.json', 'utf8')).toBe(before)
  }, 15_000)
})
