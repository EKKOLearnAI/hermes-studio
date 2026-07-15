import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { openapi } from '../../packages/server/src/controllers/api-docs'

describe('internet execution OpenAPI', () => {
  it('publishes six authenticated operations with strict semantic bodies', async () => {
    const ctx: any = { set: () => undefined, body: null }
    await openapi(ctx)
    const paths = {
      '/api/hermes/internet-execution/overview': ['get'],
      '/api/hermes/internet-execution/bilibili/search': ['post'],
      '/api/hermes/internet-execution/bilibili/inspect': ['post'],
      '/api/hermes/internet-execution/receipts': ['get'],
      '/api/hermes/internet-execution/receipts/{workflowId}': ['get'],
      '/api/hermes/internet-execution/workflows/{workflowId}': ['get'],
    } as const
    const operations = Object.entries(paths).flatMap(([path, methods]) => methods.map(method => ctx.body.paths[path]?.[method]))
    expect(operations).toHaveLength(6)
    expect(operations.every(operation => operation?.tags?.[0] === 'Internet Execution')).toBe(true)
    expect(operations.every(operation => Array.isArray(operation?.security?.[0]?.BearerAuth))).toBe(true)

    const search = ctx.body.paths['/api/hermes/internet-execution/bilibili/search'].post
      .requestBody.content['application/json'].schema
    expect(search).toMatchObject({ additionalProperties: false, required: ['query', 'idempotencyKey'] })
    expect(search.properties.limit).toMatchObject({ minimum: 1, maximum: 20, default: 10 })
    expect(search.properties).not.toHaveProperty('profile')
    expect(search.properties).not.toHaveProperty('provider')
    expect(search.properties).not.toHaveProperty('target')
    expect(search.properties).not.toHaveProperty('tool')
    expect(search.properties).not.toHaveProperty('url')
    expect(search.properties).not.toHaveProperty('browserAction')

    const inspect = ctx.body.paths['/api/hermes/internet-execution/bilibili/inspect'].post
      .requestBody.content['application/json'].schema
    expect(inspect).toMatchObject({ additionalProperties: false, required: ['bvid', 'idempotencyKey'] })
    expect(inspect.properties.bvid.pattern).toBe('^BV[0-9A-Za-z]{10}$')
    expect(ctx.body.paths['/api/hermes/internet-execution/bilibili/search'].post.responses['202']).toBeTruthy()
    expect(ctx.body.paths['/api/hermes/internet-execution/bilibili/inspect'].post.responses['202']).toBeTruthy()
  })

  it('keeps public DTOs bounded and free of raw execution configuration', async () => {
    const ctx: any = { set: () => undefined, body: null }
    await openapi(ctx)
    const names = ['InternetOverviewResponse', 'InternetProviderDto', 'InternetExecutorDto',
      'InternetActionResponse', 'InternetReceiptDto', 'InternetReceiptResponse', 'InternetWorkflowDetailDto']
    for (const name of names) {
      const encoded = JSON.stringify(ctx.body.components.schemas[name])
      expect(encoded).not.toMatch(/serverName|toolName|browserRef|browserAction|providerRequestId|healthDetails|configuration/i)
    }
    const receipt = ctx.body.components.schemas.InternetReceiptDto
    expect(receipt.properties).not.toHaveProperty('executorId')
    expect(receipt.properties).not.toHaveProperty('providerRequestId')
    expect(receipt.properties).not.toHaveProperty('materialDigest')
    expect(ctx.body.components.schemas.InternetReceiptListResponse.properties.receipts.maxItems).toBe(200)
    expect(ctx.body.components.schemas.InternetWorkflowDetailDto.properties.steps.maxItems).toBe(16)
  })

  it('regenerates deterministically', () => {
    const before = readFileSync('docs/openapi.json', 'utf8')
    const generated = spawnSync(process.execPath, ['scripts/generate-openapi.mjs'], { encoding: 'utf8' })
    expect(generated.status, generated.stderr).toBe(0)
    expect(readFileSync('docs/openapi.json', 'utf8')).toBe(before)
  }, 15_000)
})
