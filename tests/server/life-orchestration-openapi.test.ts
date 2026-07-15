import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { openapi } from '../../packages/server/src/controllers/api-docs'

describe('life orchestration OpenAPI', () => {
  it('documents the complete authenticated surface with minimized exact responses', async () => {
    const spec = await getSpec()
    const paths = Object.keys(spec.paths).filter(path => path.startsWith('/api/hermes/life/'))
    expect(paths).toHaveLength(22)
    for (const path of paths) for (const operation of Object.values(spec.paths[path]) as any[]) {
      expect(operation.security).toEqual([{ BearerAuth: [] }])
      for (const response of Object.values(operation.responses) as any[]) {
        const schema = response.content?.['application/json']?.schema
        if (schema) assertExact(schema, spec, new Set())
      }
    }
    const serialized = JSON.stringify(Object.fromEntries(Object.entries(spec.components.schemas)
      .filter(([name]) => name.startsWith('Life'))))
    expect(serialized).not.toMatch(/provider(?:Request|Hold|Subscription|Receipt|Item)Id/)
    expect(serialized).not.toMatch(/credential|accessToken|refreshToken|cookie/i)
  })

  it('publishes closed action bodies and server-owned authority fields', async () => {
    const spec = await getSpec()
    const hold = body(spec, '/api/hermes/life/holds')
    expect(hold).toMatchObject({ additionalProperties: false,
      required: ['accountId', 'planRevisionId', 'optionId', 'providerRequestId', 'idempotencyKey', 'rationale'] })
    expect(hold.properties).not.toHaveProperty('startsAt')
    expect(hold.properties).not.toHaveProperty('endsAt')
    expect(hold.properties).not.toHaveProperty('planDigest')
    expect(hold.properties).not.toHaveProperty('currency')
    expect(hold.properties).not.toHaveProperty('target')
    expect(hold.properties).not.toHaveProperty('requestedByRoleId')
    expect(hold.properties).not.toHaveProperty('requestedByUserId')

    const cancel = body(spec, '/api/hermes/life/subscriptions/cancel')
    expect(cancel).toMatchObject({ additionalProperties: false,
      required: ['subscriptionId', 'providerRequestId', 'reasonCode', 'idempotencyKey', 'rationale'] })
    expect(cancel.properties).not.toHaveProperty('accountId')
    expect(cancel.properties).not.toHaveProperty('subscriptionDigest')
    expect(cancel.properties).not.toHaveProperty('currency')
  })

  it('restricts source authority mutations and uses explicit creation and acceptance statuses', async () => {
    const spec = await getSpec()
    for (const [path, method] of [
      ['/api/hermes/life/sources', 'post'], ['/api/hermes/life/sources/{id}/health', 'put'],
      ['/api/hermes/life/sources/{id}/activate', 'post'], ['/api/hermes/life/sources/{id}/revoke', 'post'],
    ]) expect(spec.paths[path][method]['x-hermes-required-role']).toBe('super_admin')
    for (const path of ['/api/hermes/life/sources', '/api/hermes/life/constraints', '/api/hermes/life/plans']) {
      expect(spec.paths[path].post.responses).toHaveProperty('201')
      expect(spec.paths[path].post.responses).not.toHaveProperty('200')
    }
    for (const path of ['/api/hermes/life/sources/sync', '/api/hermes/life/plans/verify',
      '/api/hermes/life/holds', '/api/hermes/life/holds/cancel', '/api/hermes/life/subscriptions/cancel']) {
      expect(spec.paths[path].post.responses).toHaveProperty('202')
      expect(spec.paths[path].post.responses).not.toHaveProperty('200')
    }
  })

  it('regenerates deterministically', () => {
    const before = readFileSync('docs/openapi.json', 'utf8')
    const generated = spawnSync(process.execPath, ['scripts/generate-openapi.mjs'], { encoding: 'utf8' })
    expect(generated.status, generated.stderr).toBe(0)
    expect(readFileSync('docs/openapi.json', 'utf8')).toBe(before)
  })
})

async function getSpec(): Promise<any> {
  const ctx: any = { set: () => undefined, body: null }
  await openapi(ctx)
  return ctx.body
}

function body(spec: any, path: string): any {
  return spec.paths[path].post.requestBody.content['application/json'].schema
}

function assertExact(value: any, spec: any, seen: Set<string>): void {
  expect(value).toBeTruthy()
  if (value.$ref) {
    const name = value.$ref.split('/').at(-1)
    if (seen.has(name)) return
    seen.add(name)
    assertExact(spec.components.schemas[name], spec, seen)
    return
  }
  if (value.type === 'object') {
    expect(value.additionalProperties).toBe(false)
    for (const child of Object.values(value.properties ?? {})) assertExact(child, spec, seen)
  } else if (value.type === 'array') assertExact(value.items, spec, seen)
  else if (value.oneOf) for (const child of value.oneOf) assertExact(child, spec, seen)
  else if (value.allOf) for (const child of value.allOf) assertExact(child, spec, seen)
}
