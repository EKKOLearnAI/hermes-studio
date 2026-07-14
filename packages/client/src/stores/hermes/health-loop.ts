import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '@/api/hermes/health-loop'
import type { AnalyzeHealthArtifactInput, CreateHealthArtifactInput, CreateHealthConsentInput,
  HealthActionResponseDto, HealthConnectorDto, HealthConsentGrantDto, HealthFeedbackInput,
  HealthInterventionDto, HealthInterventionQuery,
  HealthLoopOverviewDto, HealthSettingsDto, SyncHealthConnectorInput,
  UpdateHealthLoopSettingsInput } from '@/api/hermes/health-loop'

const REFRESH_FAILED='HEALTH_LOOP_REFRESH_FAILED'
const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause)

interface HealthLoopSecretReloads {
  loadOverview():Promise<HealthLoopOverviewDto>
  loadInterventions(query?:HealthInterventionQuery):Promise<HealthInterventionDto[]>
  loadSettings():Promise<HealthSettingsDto>
}

export async function issueHealthConsent(store:HealthLoopSecretReloads,input:CreateHealthConsentInput):Promise<HealthConsentGrantDto>{
  const grant=await api.createHealthConsent(input)
  await Promise.allSettled([store.loadSettings(),store.loadOverview()])
  return grant
}

export async function requestHealthArtifactAnalysis(store:HealthLoopSecretReloads,artifactId:string,
  input:AnalyzeHealthArtifactInput):Promise<HealthActionResponseDto>{
  const result=await api.analyzeHealthArtifact(artifactId,input)
  await Promise.allSettled([store.loadInterventions(),store.loadOverview()])
  return result
}

export const useHealthLoopStore=defineStore('health-loop',()=>{
  const overview=ref<HealthLoopOverviewDto|null>(null)
  const connectors=ref<HealthConnectorDto[]>([])
  const interventions=ref<HealthInterventionDto[]>([])
  const settings=ref<HealthSettingsDto|null>(null)
  const selectedInterventionId=ref<string|null>(null)
  const selectedIntervention=computed(()=>interventions.value.find(item=>item.interventionId===selectedInterventionId.value)??null)
  const activeLoads=ref(0), activeSaves=ref(0)
  const resourceErrors=ref<Record<'overview'|'connectors'|'interventions'|'settings',string|null>>({
    overview:null,connectors:null,interventions:null,settings:null,
  })
  const mutationError=ref<string|null>(null)
  const error=computed(()=>resourceErrors.value.overview??resourceErrors.value.connectors??
    resourceErrors.value.interventions??resourceErrors.value.settings??mutationError.value)
  const loading=computed(()=>activeLoads.value>0), saving=computed(()=>activeSaves.value>0)
  let generation=0, mutationErrorSequence=0, selectionGeneration=0, independentMutationSequence=0
  const sequences={overview:0,connectors:0,interventions:0,settings:0}
  const queues=new Map<string,Promise<unknown>>()

  function beginLoad(resource:keyof typeof sequences){const current={generation,resource,sequence:++sequences[resource]};activeLoads.value++;resourceErrors.value[resource]=null;return current}
  function current(op:ReturnType<typeof beginLoad>){return op.generation===generation&&op.sequence===sequences[op.resource]}
  function finish(op:ReturnType<typeof beginLoad>){if(op.generation===generation)activeLoads.value=Math.max(0,activeLoads.value-1)}
  function fail(op:ReturnType<typeof beginLoad>,cause:unknown){if(current(op))resourceErrors.value[op.resource]=message(cause)}

  async function loadOverview(){const op=beginLoad('overview');try{const value=await api.fetchHealthLoopOverview();if(current(op))overview.value=value;return value}catch(cause){fail(op,cause);throw cause}finally{finish(op)}}
  async function loadConnectors(){const op=beginLoad('connectors');try{const value=await api.fetchHealthConnectors();if(current(op))connectors.value=value.slice();return value}catch(cause){fail(op,cause);throw cause}finally{finish(op)}}
  async function loadInterventions(query:HealthInterventionQuery={}){const op=beginLoad('interventions');const selection=selectionGeneration;try{const value=await api.fetchHealthInterventions(query);if(current(op)){interventions.value=value.slice();if(selection===selectionGeneration&&selectedInterventionId.value&&!value.some(item=>item.interventionId===selectedInterventionId.value))selectedInterventionId.value=null}return value}catch(cause){fail(op,cause);throw cause}finally{finish(op)}}
  async function loadSettings(){const op=beginLoad('settings');try{const value=await api.fetchHealthLoopSettings();if(current(op))settings.value=value;return value}catch(cause){fail(op,cause);throw cause}finally{finish(op)}}
  function selectIntervention(id:string|null){selectionGeneration++;selectedInterventionId.value=id;return selectedIntervention.value}

  async function refresh(tasks:Promise<unknown>[]){if((await Promise.allSettled(tasks)).some(result=>result.status==='rejected'))throw new Error(REFRESH_FAILED)}
  function mutate<T>(key:string,write:()=>Promise<T>,reload:(value:T)=>Promise<void>):Promise<T>{
    const callGeneration=generation, callError=++mutationErrorSequence;activeSaves.value++;mutationError.value=null
    const run=async()=>{try{const value=await write();if(callGeneration===generation){try{await reload(value)}catch{}}return value}catch(cause){if(callGeneration===generation&&callError===mutationErrorSequence)mutationError.value=message(cause);throw cause}finally{if(callGeneration===generation)activeSaves.value=Math.max(0,activeSaves.value-1)}}
    const prior=queues.get(key)
    const task=prior?prior.catch(()=>undefined).then(run):run()
    queues.set(key,task);void task.finally(()=>{if(queues.get(key)===task)queues.delete(key)}).catch(()=>undefined);return task
  }

  function syncConnector(id:string,input:SyncHealthConnectorInput){return mutate(`sync:${id}`,()=>api.syncHealthConnector(id,input),async()=>refresh([loadConnectors(),loadOverview()]))}
  function createArtifact(input:CreateHealthArtifactInput){return mutate(`artifact-upload:${++independentMutationSequence}`,()=>api.createHealthArtifact(input),async()=>undefined)}
  function revokeConsent(id:string){return mutate(`consent:${id}`,()=>api.revokeHealthConsent(id),async()=>refresh([loadSettings(),loadOverview()]))}
  function submitFeedback(id:string,input:HealthFeedbackInput){return mutate(`feedback:${id}`,()=>api.submitHealthInterventionFeedback(id,input),async()=>refresh([loadInterventions(),loadOverview()]))}
  function updateSettings(input:UpdateHealthLoopSettingsInput){return mutate('settings',()=>api.updateHealthLoopSettings(input),async()=>refresh([loadSettings(),loadOverview(),loadConnectors()]))}

  function reset(){generation++;mutationErrorSequence++;selectionGeneration++;for(const key of Object.keys(sequences) as Array<keyof typeof sequences>)sequences[key]++;overview.value=null;connectors.value=[];interventions.value=[];settings.value=null;selectedInterventionId.value=null;activeLoads.value=0;activeSaves.value=0;resourceErrors.value={overview:null,connectors:null,interventions:null,settings:null};mutationError.value=null;queues.clear()}
  onScopeDispose(()=>{generation++;mutationErrorSequence++;selectionGeneration++;for(const key of Object.keys(sequences) as Array<keyof typeof sequences>)sequences[key]++;queues.clear()})
  return {overview,connectors,interventions,settings,selectedInterventionId,selectedIntervention,loading,saving,error,resourceErrors,
    loadOverview,loadConnectors,loadInterventions,loadSettings,selectIntervention,syncConnector,createArtifact,
    revokeConsent,submitFeedback,updateSettings,$reset:reset}
})
