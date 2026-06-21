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
  latestPlan: Record<string, unknown> | null
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

export async function fetchHealthOverview(options: { profile?: string | null } = {}): Promise<HealthOverview> {
  const res = await request<{ overview: HealthOverview }>(withProfile('/api/hermes/health/overview', options.profile))
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

export async function createHealthRecord(payload: Record<string, unknown>, profile?: string | null): Promise<Record<string, unknown>> {
  const res = await request<{ record: Record<string, unknown> }>(
    withProfile('/api/hermes/health/records', profile),
    { method: 'POST', body: JSON.stringify(payload) },
  )
  return res.record
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
