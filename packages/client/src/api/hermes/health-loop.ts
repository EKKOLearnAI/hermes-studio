import { request } from '@/api/client'

export type HealthDomain = 'body_composition' | 'measurements' | 'posture' | 'skin' | 'diet' | 'fitness' | 'sleep' | 'internal_health'
export type HealthPurpose = 'measurement' | 'posture' | 'skin' | 'diet' | 'internal_health'
export type HealthInterventionStatus = 'active' | 'completed' | 'superseded'
export type HealthFeedbackOutcome = 'completed' | 'partial' | 'skipped' | 'deferred' | 'adverse_feedback' | 'unsuitable' | 'data_incorrect' | 'expired'

export interface HealthSettingsDto { subjectId:string; liveDeliveryEnabled:boolean; profile:string; recipient:'configured-self'; configuredConnectors:string[]; configuredProcessors:string[]; version:number; updatedAt:string }
export interface HealthConnectorDto { id:string; configured:boolean; configurationState:'configured'|'not_configured'|'invalid'; authorizationState:'authorized'|'not_required'|'required'|'expired'|'unknown'; health:'healthy'|'degraded'|'unhealthy'|'unavailable'; lastAttemptAt?:string; lastSuccessAt?:string; domains:HealthDomain[]; freshnessByDomain:Partial<Record<HealthDomain,string>>; capabilities:{read:HealthDomain[];write:HealthDomain[]}; errorCode?:string }
export interface HealthOverviewSummaryDto { interventionCount:number; activeInterventionCount:number; projectionCount:number }
export interface HealthLoopOverviewDto { settings:HealthSettingsDto; connectors:HealthConnectorDto[]; summary:HealthOverviewSummaryDto }
export interface HealthActionResponseDto { intent:{id:string;capabilityId:string}; policyDecision:{id:string;outcome:'allow'|'deny'|'waiting_user';reasonCodes:string[]}; workflow:{id:string;state:'draft'|'policy_check'|'preparing'|'executing'|'verifying'|'waiting_user'|'retrying'|'compensating'|'succeeded'|'denied'|'cancelled'|'failed'|'dead_letter'|'compensated';version:number;availableActions:{approve:boolean;reject:boolean;cancel:boolean;retry:boolean;compensate:boolean}} }
export interface HealthAnalysisMetadataDto { purpose?:HealthPurpose; selectedRegions?:string[]; requestedFields?:string[]; format?:'json'|'csv'|'report_text' }
export interface HealthPublicMetadataDto { healthAnalysis?:HealthAnalysisMetadataDto; notes?:string[] }
export interface HealthArtifactDto { id:string; mediaType:string; sizeBytes:number; manifestDigest:string; metadata:HealthPublicMetadataDto; createdAt:string }
export interface HealthConsentManifestDto { artifactIds:string[]; processor:string; purpose:HealthPurpose; selectedRegions:string[]; requestedFields:string[]; retention:'no_retention'|'session'|'24_hours' }
export interface HealthConsentGrantDto { consentId:string; manifestDigest:string; manifest:HealthConsentManifestDto; issuedAt:string; expiresAt:string; token:string }
export interface HealthConsentRevocationDto { consentId:string; revokedAt:string }
export interface HealthInterventionDto { actionId:string; interventionId:string; workflowId:string; capabilityId:string; category:'training'|'recovery'|'nutrition'|'posture'|'skin'|'internal_health'; priority:number; risk:'none'|'low'|'medium'|'high'|'critical'; authority:'auto'|'approval'|'inform_only'; status:HealthInterventionStatus; effectiveDate:string; createdAt:string; supersededAt:string|null }
export interface HealthFeedbackDto { feedbackId:string; outcome:HealthFeedbackOutcome; actionId:string; interventionId:string; occurredAt:string; reviewRequired:boolean; supersededActionIds:string[] }

export interface SyncHealthConnectorInput { cursor?:string; requestedAt?:string; idempotencyKey?:string }
export type AnalyzeHealthArtifactInput = {mode:'local';manifestDigest:string;idempotencyKey?:string;requestedAt?:string} | {mode:'remote';manifestDigest:string;processorId:string;consentToken:string;manifest:HealthConsentManifestDto;idempotencyKey:string;requestedAt?:string}
export interface CreateHealthConsentInput { manifest:HealthConsentManifestDto; ttlMs?:number }
export interface HealthInterventionQuery { status?:HealthInterventionStatus; limit?:number }
export interface HealthFeedbackInput { feedbackId:string; outcome:HealthFeedbackOutcome; occurredAt:string }
export interface UpdateHealthLoopSettingsInput { expectedVersion:number; liveDeliveryEnabled:boolean; recipient:'configured-self'; configuredConnectors?:string[]; configuredProcessors?:string[] }
export interface CreateHealthArtifactInput { file:Blob; filename?:string; sourceId:string; metadata?:HealthPublicMetadataDto }

const BASE='/api/hermes/health-loop'
const id=(value:string)=>encodeURIComponent(value)
const json=(body:unknown):RequestInit=>({method:'POST',body:JSON.stringify(body)})

export function fetchHealthLoopOverview():Promise<HealthLoopOverviewDto>{return request<HealthLoopOverviewDto>(`${BASE}/overview`)}
export async function fetchHealthConnectors():Promise<HealthConnectorDto[]>{return (await request<{connectors:HealthConnectorDto[]}>(`${BASE}/connectors`)).connectors}
export function syncHealthConnector(connectorId:string,input:SyncHealthConnectorInput):Promise<HealthActionResponseDto>{return request(`${BASE}/connectors/${id(connectorId)}/sync`,json(input))}
export async function createHealthArtifact(input:CreateHealthArtifactInput):Promise<HealthArtifactDto>{const body=new FormData();if(input.filename)body.append('file',input.file,input.filename);else body.append('file',input.file);body.append('sourceId',input.sourceId);if(input.metadata)body.append('metadata',JSON.stringify(input.metadata));return (await request<{artifact:HealthArtifactDto}>(`${BASE}/artifacts`,{method:'POST',body})).artifact}
export function analyzeHealthArtifact(artifactId:string,input:AnalyzeHealthArtifactInput):Promise<HealthActionResponseDto>{return request(`${BASE}/artifacts/${id(artifactId)}/analyze`,json(input))}
export async function createHealthConsent(input:CreateHealthConsentInput):Promise<HealthConsentGrantDto>{return (await request<{consent:HealthConsentGrantDto}>(`${BASE}/consents`,json(input))).consent}
export async function revokeHealthConsent(consentId:string):Promise<HealthConsentRevocationDto>{return (await request<{consent:HealthConsentRevocationDto}>(`${BASE}/consents/${id(consentId)}/revoke`,json({}))).consent}
export async function fetchHealthInterventions(query:HealthInterventionQuery={}):Promise<HealthInterventionDto[]>{const params=new URLSearchParams();if(query.status)params.set('status',query.status);if(query.limit!==undefined)params.set('limit',String(query.limit));const suffix=params.size?`?${params}`:'';return (await request<{interventions:HealthInterventionDto[]}>(`${BASE}/interventions${suffix}`)).interventions}
export async function submitHealthInterventionFeedback(interventionId:string,input:HealthFeedbackInput):Promise<HealthFeedbackDto>{return (await request<{feedback:HealthFeedbackDto}>(`${BASE}/interventions/${id(interventionId)}/feedback`,json(input))).feedback}
export async function fetchHealthLoopSettings():Promise<HealthSettingsDto>{return (await request<{settings:HealthSettingsDto}>(`${BASE}/settings`)).settings}
export async function updateHealthLoopSettings(input:UpdateHealthLoopSettingsInput):Promise<HealthSettingsDto>{return (await request<{settings:HealthSettingsDto}>(`${BASE}/settings`,{method:'PUT',body:JSON.stringify(input)})).settings}
