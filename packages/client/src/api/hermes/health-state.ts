import { request } from '@/api/client'

export interface HealthProfile {
  displayName: string | null
  birthDate: string | null
  sex: string | null
  heightCm: number | null
  weightKg: number | null
  weightTargetKg: number | null
  activityLevel: string | null
  goals: string[]
  conditions: string[]
  allergies: string[]
  nutritionTargets: Record<string, number>
}

export interface HealthDigitalTwinSummary {
  currentWeightKg: number | null
  targetWeightKg: number | null
  externalConcernCount: number
  internalMarkerCount: number
  micronutrientGapCount: number
}

export interface HealthExternalSummary {
  currentWeightKg: number | null
  targetWeightKg: number | null
  topRegions: Array<Record<string, unknown>>
  recentWorkoutCount: number
}

export interface HealthInternalMarker {
  id: string
  key: string
  label: string
  value: number | string | null
  unit: string | null
  status: string
  source: string
  recordedAt: string
  referenceRange: string | null
  notes: string
}

export interface HealthMicronutrientSummary {
  items: Array<{
    key: string
    consumed: number
    target: number
    remaining: number
    status: 'low' | 'ok' | 'high' | 'unknown'
  }>
}

export interface HealthBodyProfile {
  latestMeasurements: {
    id: string
    title: string
    source: string
    notes: string
    recordedAt: string
    measurements: Record<string, number>
    weightKg: number | null
    bodyFatPercent: number | null
  } | null
  posture: {
    id: string
    title: string
    source: string
    notes: string
    recordedAt: string
    priority: string
    issues: string[]
    compensationChain: string[]
    pain: Array<Record<string, unknown>>
  } | null
  skin: {
    id: string
    title: string
    source: string
    notes: string
    recordedAt: string
    concerns: string[]
    routine: Record<string, unknown>
  } | null
  nextDataNeeded: string[]
}

export interface HealthScaleReading {
  measuredAt: string
  sourceDevice: string
  sourceModel: string | null
  weightKg: number
  bmi: number | null
  bodyFatPercent: number | null
  bodyScore: number | null
  bodyWaterKg: number | null
  bodyWaterPercent: number | null
  fatMassKg: number | null
  boneSaltKg: number | null
  boneSaltPercent: number | null
  proteinMassKg: number | null
  proteinPercent: number | null
  muscleMassKg: number | null
  musclePercent: number | null
  skeletalMuscleMassKg: number | null
  visceralFatLevel: number | null
  basalMetabolismKcal: number | null
  waistHipRatio: number | null
  bodyAge: number | null
  leanBodyMassKg: number | null
}

export interface ScaleSyncSettings {
  enabled: boolean
  source: 'mifitness' | 'xiaomihome'
  username: string
  hasPassword: boolean
  passwordMasked: string
  region: string
  scaleModel: string
  scaleconnectPath: string
  configured: boolean
}

export interface ScaleSyncResult {
  status: 'synced' | 'skipped' | 'failed'
  reason?: string
  command?: string
  importedCount: number
  readings: Array<Record<string, unknown>>
  stderr?: string
  verificationUrl?: string
}

export interface HealthScaleReadingsSummary {
  latest: HealthScaleReading | null
  readings: Array<Record<string, unknown>>
  total: number
}

export interface HealthOverview {
  generatedAt: string
  profile: string
  healthProfile: HealthProfile
  weightSummary: Record<string, unknown>
  nutritionSummary: {
    targets: Record<string, number>
    consumed: Record<string, number>
    remaining: Record<string, number>
  }
  recentWorkouts: Array<Record<string, unknown>>
  topBodyConcerns: Array<Record<string, unknown>>
  digitalTwinSummary: HealthDigitalTwinSummary
  externalSummary: HealthExternalSummary
  internalMarkers: HealthInternalMarker[]
  micronutrientSummary: HealthMicronutrientSummary
  bodyProfile: HealthBodyProfile
  latestPlan: Record<string, unknown> | null
  latestScaleReading: HealthScaleReading | null
  supplementSummary: Record<string, unknown>
  bodyMap: Array<Record<string, unknown>>
  records: Array<Record<string, unknown>>
  workouts: Array<Record<string, unknown>>
  foodItems: Array<Record<string, unknown>>
  foodLogs: Array<Record<string, unknown>>
  foodTemplates: Array<Record<string, unknown>>
  supplements: Array<Record<string, unknown>>
  supplementLogs: Array<Record<string, unknown>>
  dailyPlans: Array<Record<string, unknown>>
  dailyCheckins: Array<Record<string, unknown>>
}

function withProfile(path: string, profile?: string | null): string {
  if (!profile) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}profile=${encodeURIComponent(profile)}`
}

function appendQuery(path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  let result = path
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    const separator = result.includes('?') ? '&' : '?'
    result = `${result}${separator}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
  }
  return result
}

export async function fetchHealthOverview(options: { profile?: string | null; includeRecords?: boolean } = {}): Promise<HealthOverview> {
  const path = appendQuery(withProfile('/api/hermes/health/overview', options.profile), {
    includeRecords: options.includeRecords === false ? false : undefined,
  })
  const res = await request<{ overview: HealthOverview }>(path)
  return res.overview
}

export async function fetchHealthProfile(profile?: string | null): Promise<HealthProfile> {
  const res = await request<{ profile: HealthProfile }>(withProfile('/api/hermes/health/profile', profile))
  return res.profile
}

export async function updateHealthProfile(payload: Record<string, unknown>, profile?: string | null): Promise<HealthProfile> {
  const res = await request<{ profile: HealthProfile }>(
    withProfile('/api/hermes/health/profile', profile),
    { method: 'PUT', body: JSON.stringify(payload) },
  )
  return res.profile
}

export async function fetchHealthBodyMap(profile?: string | null): Promise<Array<Record<string, unknown>>> {
  const res = await request<{ bodyMap: Array<Record<string, unknown>> }>(withProfile('/api/hermes/health/body-map', profile))
  return res.bodyMap
}

export async function updateHealthBodyMap(payload: Array<Record<string, unknown>>, profile?: string | null): Promise<Array<Record<string, unknown>>> {
  const res = await request<{ bodyMap: Array<Record<string, unknown>> }>(
    withProfile('/api/hermes/health/body-map', profile),
    { method: 'PUT', body: JSON.stringify(payload) },
  )
  return res.bodyMap
}

export async function fetchHealthRecords(profile?: string | null): Promise<Array<Record<string, unknown>>> {
  const res = await request<{ records: Array<Record<string, unknown>> }>(withProfile('/api/hermes/health/records', profile))
  return res.records
}

export async function fetchHealthScaleReadings(options: { profile?: string | null; limit?: number } = {}): Promise<HealthScaleReadingsSummary> {
  return request<HealthScaleReadingsSummary>(appendQuery(withProfile('/api/hermes/health/scale-readings', options.profile), {
    limit: options.limit,
  }))
}

export async function createHealthRecord(payload: Record<string, unknown>, profile?: string | null): Promise<Record<string, unknown>> {
  const res = await request<{ record: Record<string, unknown> }>(
    withProfile('/api/hermes/health/records', profile),
    { method: 'POST', body: JSON.stringify(payload) },
  )
  return res.record
}

export async function createHealthScaleReading(payload: Record<string, unknown>, profile?: string | null): Promise<Record<string, unknown>> {
  const res = await request<{ reading: Record<string, unknown> }>(
    withProfile('/api/hermes/health/scale-readings', profile),
    { method: 'POST', body: JSON.stringify(payload) },
  )
  return res.reading
}

export async function fetchScaleSyncSettings(profile?: string | null): Promise<ScaleSyncSettings> {
  const res = await request<{ settings: ScaleSyncSettings }>(withProfile('/api/hermes/health/scale-sync', profile))
  return res.settings
}

export async function updateScaleSyncSettings(payload: Record<string, unknown>, profile?: string | null): Promise<ScaleSyncSettings> {
  const res = await request<{ settings: ScaleSyncSettings }>(
    withProfile('/api/hermes/health/scale-sync', profile),
    { method: 'PUT', body: JSON.stringify(payload) },
  )
  return res.settings
}

export async function runScaleSync(profile?: string | null): Promise<ScaleSyncResult> {
  const res = await request<{ result: ScaleSyncResult }>(
    withProfile('/api/hermes/health/scale-sync/run', profile),
    { method: 'POST', body: JSON.stringify({}) },
  )
  return res.result
}

export async function fetchHealthWorkouts(profile?: string | null): Promise<Array<Record<string, unknown>>> {
  const res = await request<{ workouts: Array<Record<string, unknown>> }>(withProfile('/api/hermes/health/workouts', profile))
  return res.workouts
}

export async function createHealthWorkout(payload: Record<string, unknown>, profile?: string | null): Promise<Record<string, unknown>> {
  const res = await request<{ workout: Record<string, unknown> }>(
    withProfile('/api/hermes/health/workouts', profile),
    { method: 'POST', body: JSON.stringify(payload) },
  )
  return res.workout
}

export async function fetchHealthFoodItems(profile?: string | null): Promise<Array<Record<string, unknown>>> {
  const res = await request<{ items: Array<Record<string, unknown>> }>(withProfile('/api/hermes/health/food/items', profile))
  return res.items
}

export async function fetchHealthFoodLogs(profile?: string | null): Promise<Array<Record<string, unknown>>> {
  const res = await request<{ logs: Array<Record<string, unknown>> }>(withProfile('/api/hermes/health/food/logs', profile))
  return res.logs
}

export async function createHealthFoodLog(payload: Record<string, unknown>, profile?: string | null): Promise<Record<string, unknown>> {
  const res = await request<{ log: Record<string, unknown> }>(
    withProfile('/api/hermes/health/food/logs', profile),
    { method: 'POST', body: JSON.stringify(payload) },
  )
  return res.log
}

export async function fetchHealthTodayPlan(profile?: string | null): Promise<Record<string, unknown> | null> {
  const res = await request<{ plan: Record<string, unknown> | null }>(withProfile('/api/hermes/health/today-plan', profile))
  return res.plan
}

export async function createHealthCheckIn(payload: Record<string, unknown>, profile?: string | null): Promise<Record<string, unknown>> {
  const res = await request<{ checkIn: Record<string, unknown> }>(
    withProfile('/api/hermes/health/check-ins', profile),
    { method: 'POST', body: JSON.stringify(payload) },
  )
  return res.checkIn
}
