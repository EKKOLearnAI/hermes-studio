import { describe, expect, it } from 'vitest'
import { openapi } from '../../packages/server/src/controllers/api-docs'

describe('health loop OpenAPI',()=>{
  it('publishes eleven authenticated operations with strict bodies and exact enums',async()=>{
    const ctx:any={set:()=>undefined,body:null};await openapi(ctx)
    const paths={'/api/hermes/health-loop/overview':['get'],'/api/hermes/health-loop/connectors':['get'],
      '/api/hermes/health-loop/connectors/{id}/sync':['post'],'/api/hermes/health-loop/artifacts':['post'],
      '/api/hermes/health-loop/artifacts/{id}/analyze':['post'],'/api/hermes/health-loop/consents':['post'],
      '/api/hermes/health-loop/consents/{id}/revoke':['post'],'/api/hermes/health-loop/interventions':['get'],
      '/api/hermes/health-loop/interventions/{id}/feedback':['post'],'/api/hermes/health-loop/settings':['get','put']} as const
    const operations=Object.entries(paths).flatMap(([path,methods])=>methods.map(method=>ctx.body.paths[path]?.[method]))
    expect(operations).toHaveLength(11);expect(operations.every(operation=>operation?.tags?.[0]==='Health Loop')).toBe(true)
    expect(operations.every(operation=>Array.isArray(operation?.security?.[0]?.BearerAuth))).toBe(true)
    expect(ctx.body.paths['/api/hermes/health-loop/interventions'].get.parameters[1].schema.enum).toEqual(['active','completed','superseded'])
    expect(ctx.body.paths['/api/hermes/health-loop/artifacts/{id}/analyze'].post.requestBody.content['application/json'].schema.oneOf.map((item:any)=>item.properties.mode.enum[0])).toEqual(['local','remote'])
    expect(ctx.body.paths['/api/hermes/health-loop/interventions/{id}/feedback'].post.requestBody.content['application/json'].schema.properties.outcome.enum).toEqual(['completed','partial','skipped','deferred','adverse_feedback','unsuitable','data_incorrect','expired'])
    expect(ctx.body.paths['/api/hermes/health-loop/settings'].put.requestBody.content['application/json'].schema).toEqual(expect.objectContaining({additionalProperties:false,required:['expectedVersion','liveDeliveryEnabled','recipient'],properties:expect.not.objectContaining({profile:expect.anything()})}))
    expect(ctx.body.paths['/api/hermes/health-loop/artifacts'].post.requestBody.content['multipart/form-data'].schema.properties.file).toEqual({type:'string',format:'binary'})
    expect(ctx.body.paths['/api/hermes/health-loop/connectors/{id}/sync'].post.responses['202']).toBeTruthy()
    expect(ctx.body.paths['/api/hermes/health-loop/consents'].post.responses['201']).toBeTruthy()
    expect(ctx.body.components.schemas.HealthLoopError.properties.code.pattern).toBe('^HEALTH_[A-Z0-9_]+$')
  })

  it('uses mutually exclusive local/remote analysis requests and exact response DTOs',async()=>{
    const ctx:any={set:()=>undefined,body:null};await openapi(ctx)
    const schema=ctx.body.paths['/api/hermes/health-loop/artifacts/{id}/analyze'].post.requestBody.content['application/json'].schema
    expect(schema).toEqual({oneOf:[
      expect.objectContaining({additionalProperties:false,required:['mode','manifestDigest'],properties:expect.objectContaining({mode:{type:'string',enum:['local']},manifestDigest:expect.any(Object)})}),
      expect.objectContaining({additionalProperties:false,required:['mode','manifestDigest','processorId','consentToken','manifest'],properties:expect.objectContaining({mode:{type:'string',enum:['remote']},processorId:expect.any(Object),consentToken:expect.objectContaining({writeOnly:true}),manifest:expect.any(Object)})}),
    ]})
    const responseNames=['HealthLoopOverviewResponse','HealthConnectorListResponse','HealthActionResponse','HealthArtifactResponse',
      'HealthConsentGrantResponse','HealthConsentRevocationResponse','HealthInterventionListResponse','HealthFeedbackResponse','HealthSettingsResponse']
    const seen=new Set<string>();const assertExact=(value:any):void=>{expect(value).toBeTruthy();if(value.$ref){const name=value.$ref.split('/').at(-1);if(seen.has(name))return;seen.add(name);assertExact(ctx.body.components.schemas[name]);return}if(value.type==='object'){expect(value.additionalProperties).toBe(false);for(const child of Object.values(value.properties??{}))assertExact(child)}else if(value.type==='array')assertExact(value.items);else if(value.oneOf)for(const child of value.oneOf)assertExact(child)}
    for(const name of responseNames)assertExact(ctx.body.components.schemas[name])
    expect(ctx.body.components.schemas.HealthConsentGrantDto.properties).toHaveProperty('token')
    for(const name of responseNames.filter(name=>name!=='HealthConsentGrantResponse'))expect(JSON.stringify(ctx.body.components.schemas[name])).not.toMatch(/token/i)
  })
})
