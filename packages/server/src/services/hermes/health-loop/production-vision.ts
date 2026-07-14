import { readConfigYamlForProfile } from '../../config-helpers'
import { createHealthArtifactVault } from './artifacts'
import { createAuxiliaryVisionAnalyzer, type AuxiliaryVisionClientInput,
  type ResolvedAuxiliaryVisionConfig } from './analyzers/auxiliary-vision'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

export interface ProductionVisionAdapter {
  processorId: string
  analyzer: ReturnType<typeof createAuxiliaryVisionAnalyzer>
}

export async function createProductionVisionAdapter(profile: string): Promise<ProductionVisionAdapter | null> {
  const config = await resolveProductionVisionConfig(profile)
  if (!config) return null
  const analyzer = createAuxiliaryVisionAnalyzer({
    resolver: async () => config.analysis,
    client: { analyze: (input, options) => requestOpenAiCompatibleVision(config, input, options.signal) },
    vault: createHealthArtifactVault(),
  })
  return { processorId: config.analysis.provider, analyzer }
}

interface ProductionVisionConfig {
  analysis: ResolvedAuxiliaryVisionConfig
  baseUrl: string
  apiKey: string
  extraBody: Record<string, unknown>
}

async function resolveProductionVisionConfig(profile: string): Promise<ProductionVisionConfig | null> {
  let root: Record<string, unknown>
  try { root = await readConfigYamlForProfile(profile) }
  catch { return null }
  const auxiliary = plain(root.auxiliary) ? root.auxiliary : null
  const vision = auxiliary && plain(auxiliary.vision) ? auxiliary.vision : null
  if (!vision) return null
  const provider = text(vision.provider)
  const model = text(vision.model)
  const baseUrl = text(vision.base_url)
  const apiKey = text(vision.api_key)
  if (!provider || !model || !baseUrl || !apiKey || !ID.test(provider) || !ID.test(model)) return null
  let url: URL
  try { url = new URL(baseUrl) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
  const timeoutSeconds = Number(vision.timeout ?? 120)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 300) return null
  let extraBody:Record<string,unknown>={}
  try { if(vision.extra_body!==undefined){if(!plain(vision.extra_body))return null;extraBody=jsonObject(vision.extra_body)} }
  catch{return null}
  return { analysis: { provider, model, locality: 'remote', timeoutMs: Math.floor(timeoutSeconds * 1000) },
    baseUrl: url.toString().replace(/\/$/, ''), apiKey, extraBody }
}

async function requestOpenAiCompatibleVision(config: ProductionVisionConfig, input: AuxiliaryVisionClientInput,
  signal: AbortSignal): Promise<{output:string;providerReceiptId:string}> {
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: instruction(input) }]
  for (const artifact of input.artifacts) {
    const encoded = artifact.content.toString('base64')
    content.push(artifact.mediaType === 'application/pdf'
      ? { type: 'input_file', filename: `${artifact.artifactId}.pdf`, file_data: `data:application/pdf;base64,${encoded}` }
      : { type: 'input_image', image_url: `data:${artifact.mediaType};base64,${encoded}` })
  }
  const response = await fetch(responsesUrl(config.baseUrl), { method: 'POST', signal,
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...config.extraBody, model: input.model,
      input: [{ role: 'user', content }], text: { format: { type: 'json_object' } } }) })
  if (!response.ok) throw new Error('HEALTH_VISION_PROVIDER_FAILED')
  const raw = await boundedResponseText(response,2*1024*1024)
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('HEALTH_VISION_PROVIDER_FAILED') }
  const output = responseOutputText(value)
  const receipt = plain(value) && typeof value.id === 'string' && ID.test(value.id) ? value.id : null
  if (!output || !receipt) throw new Error('HEALTH_VISION_PROVIDER_FAILED')
  return { output, providerReceiptId: receipt }
}

function responsesUrl(baseUrl:string):string {
  const normalized=baseUrl.replace(/\/+$/,'')
  return normalized.endsWith('/responses')?normalized:normalized.endsWith('/v1')?`${normalized}/responses`:`${normalized}/v1/responses`
}
async function boundedResponseText(response:Response,limit:number):Promise<string>{
  if(!response.body)return ''
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0
  try{while(true){const {done,value}=await reader.read();if(done)break;if(!value)continue;size+=value.byteLength
      if(size>limit){await reader.cancel().catch(()=>undefined);throw new Error('HEALTH_VISION_PROVIDER_FAILED')}chunks.push(value)}}finally{reader.releaseLock()}
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),size))
}

function responseOutputText(value: unknown): string | null {
  if (!plain(value)) return null
  if (typeof value.output_text === 'string' && value.output_text.trim()) return value.output_text
  if (!Array.isArray(value.output)) return null
  const texts: string[] = []
  for (const item of value.output) {
    if (!plain(item) || !Array.isArray(item.content)) continue
    for (const part of item.content) if (plain(part) && part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
  }
  return texts.length === 1 && texts[0].trim() ? texts[0] : null
}

function instruction(input: AuxiliaryVisionClientInput): string {
  return `Return one strict JSON health-analysis result. Purpose: ${input.purpose}. Requested fields: ${input.requestedFields.join(', ')}. Selected regions: ${input.selectedRegions.join(', ')}. Set modelVersion to ${input.model} and parserVersion to vision-json-v1.`
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function jsonObject(value: Record<string, unknown>): Record<string, unknown> {
  let nodes=0
  const visit=(item:unknown,depth:number):unknown=>{nodes+=1;if(nodes>512||depth>8)throw new Error('invalid')
    if(item===null||typeof item==='string'||typeof item==='boolean'||(typeof item==='number'&&Number.isFinite(item)))return item
    if(Array.isArray(item)){if(item.length>128)throw new Error('invalid');return item.map(child=>visit(child,depth+1))}
    if(!plain(item))throw new Error('invalid');const output:Record<string,unknown>={}
    for(const [key,child] of Object.entries(item)){if(['__proto__','prototype','constructor'].includes(key)||key.length>100)throw new Error('invalid');output[key]=visit(child,depth+1)}return output}
  const output=visit(value,0) as Record<string,unknown>
  if(Buffer.byteLength(JSON.stringify(output),'utf8')>32*1024)throw new Error('invalid')
  return output
}
