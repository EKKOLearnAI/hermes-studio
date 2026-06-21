import {
  getPostureIssueOverlayDefinitions,
  type PostureIssueOverlayDefinition,
} from './body-3d-model-mapping'

export type BodyRegionId =
  | 'chest'
  | 'shoulders'
  | 'biceps'
  | 'forearms'
  | 'abs'
  | 'lats'
  | 'glutes'
  | 'quads'
  | 'hamstrings'
  | 'calves'

export type BodyRegionStatusTone = 'empty' | 'good' | 'medium' | 'high'

export interface MuscleGroupAssessment {
  development_level?: number
  activation_level?: number
  posture_constraint_level?: number
  priority?: string
}

export type HealthBodyMap = Record<string, MuscleGroupAssessment | undefined>

export interface HealthWorkoutLike {
  id: string
  title?: string
  exerciseType?: string
  exercise_type?: string
  durationMinutes?: number
  duration?: number
  intensity?: string | null
  startedAt?: string
  workout_at?: string
  notes?: string | null
}

export interface BodyRegionDefinition {
  id: BodyRegionId
  label: string
  sourceKeys: string[]
  workoutKeywords: string[]
  position: 'front' | 'back' | 'both'
}

export interface BodyRegionSummary {
  id: BodyRegionId
  label: string
  sourceKeys: string[]
  hasData: boolean
  developmentLevel: number | null
  activationLevel: number | null
  postureConstraintLevel: number | null
  priority: string | null
  statusTone: BodyRegionStatusTone
}

export interface RelatedWorkoutSummary {
  id: string
  title: string
  durationMinutes: number | null
  intensity: string | null
  startedAt: string | null
  notes: string | null
  matchedKeyword: string
}

export interface HealthPostureProfile {
  issues?: Array<{ id?: string; [key: string]: unknown }>
  compensation_chain?: string[]
  [key: string]: unknown
}

export const BODY_REGION_DEFINITIONS: BodyRegionDefinition[] = [
  { id: 'chest', label: '胸部', sourceKeys: ['upper_chest'], workoutKeywords: ['chest', 'bench', 'press', 'fly'], position: 'front' },
  { id: 'shoulders', label: '肩部', sourceKeys: ['rear_delts'], workoutKeywords: ['shoulder', 'delt', 'raise', 'press'], position: 'both' },
  { id: 'biceps', label: '肱二头', sourceKeys: ['biceps'], workoutKeywords: ['biceps', 'curl'], position: 'front' },
  { id: 'forearms', label: '前臂', sourceKeys: ['forearms'], workoutKeywords: ['forearm', 'grip', 'wrist'], position: 'front' },
  { id: 'abs', label: '核心', sourceKeys: ['abs', 'core'], workoutKeywords: ['abs', 'core', 'crunch', 'plank'], position: 'front' },
  { id: 'lats', label: '背阔肌', sourceKeys: ['lats'], workoutKeywords: ['lat', 'row', 'pulldown', 'pull-up'], position: 'back' },
  { id: 'glutes', label: '臀部', sourceKeys: ['glutes'], workoutKeywords: ['glute', 'hip thrust', 'bridge', 'split squat'], position: 'back' },
  { id: 'quads', label: '股四头', sourceKeys: ['quads'], workoutKeywords: ['quad', 'squat', 'leg press', 'lunge'], position: 'front' },
  { id: 'hamstrings', label: '腘绳肌', sourceKeys: ['hamstrings'], workoutKeywords: ['hamstring', 'romanian', 'deadlift', 'leg curl'], position: 'back' },
  { id: 'calves', label: '小腿', sourceKeys: ['calves'], workoutKeywords: ['calf', 'raise'], position: 'back' },
]

const BODY_REGION_INDEX = new Map(BODY_REGION_DEFINITIONS.map(region => [region.id, region]))

export function getBodyRegionSummary(regionId: BodyRegionId, bodyMap: HealthBodyMap): BodyRegionSummary {
  const region = getBodyRegionDefinition(regionId)
  const assessments = region.sourceKeys
    .map(key => ({ key, assessment: bodyMap[key] }))
    .filter((entry): entry is { key: string; assessment: MuscleGroupAssessment } => Boolean(entry.assessment))
  const priorities = assessments.map(entry => normalizePriority(entry.assessment.priority)).filter(Boolean) as string[]
  const priority = priorities.sort(comparePriority)[0] ?? null
  const developmentLevel = aggregateNumericField(assessments.map(entry => entry.assessment.development_level))
  const activationLevel = aggregateNumericField(assessments.map(entry => entry.assessment.activation_level))
  const postureConstraintLevel = aggregateNumericField(assessments.map(entry => entry.assessment.posture_constraint_level))

  return {
    id: region.id,
    label: region.label,
    sourceKeys: assessments.map(entry => entry.key),
    hasData: assessments.length > 0,
    developmentLevel,
    activationLevel,
    postureConstraintLevel,
    priority,
    statusTone: getBodyRegionStatusTone(regionId, bodyMap),
  }
}

export function getBodyRegionStatusTone(regionId: BodyRegionId, bodyMap: HealthBodyMap): BodyRegionStatusTone {
  const summary = summarizeValues(getBodyRegionDefinition(regionId), bodyMap)
  if (!summary.count) return 'empty'
  if (summary.priority === 'high' || summary.developmentLevel <= 1.5 || summary.activationLevel <= 1.5 || summary.postureConstraintLevel >= 4) {
    return 'high'
  }
  if (summary.priority === 'medium' || summary.developmentLevel <= 2.5 || summary.activationLevel <= 2.5 || summary.postureConstraintLevel >= 2.5) {
    return 'medium'
  }
  return 'good'
}

export function getVisiblePostureIssueOverlays(postureProfile?: HealthPostureProfile | null): PostureIssueOverlayDefinition[] {
  const issueIds = new Set(
    (postureProfile?.issues || [])
      .map(issue => issue.id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  )
  if (!issueIds.size) return []
  return getPostureIssueOverlayDefinitions().filter(overlay => issueIds.has(overlay.id))
}

export function getCompensationChainRegions(chain: string[] = []): BodyRegionId[] {
  const regions = new Set<BodyRegionId>()
  if (chain.includes('pelvis')) regions.add('glutes')
  if (chain.includes('lumbar')) regions.add('abs')
  if (chain.includes('ribcage')) regions.add('chest')
  if (chain.includes('head_neck')) regions.add('shoulders')
  return Array.from(regions)
}

export function getRelatedWorkoutSummary(regionId: BodyRegionId, workouts: HealthWorkoutLike[]): RelatedWorkoutSummary | null {
  const region = getBodyRegionDefinition(regionId)
  const sorted = workouts
    .slice()
    .sort((left, right) => new Date(workoutTime(right)).getTime() - new Date(workoutTime(left)).getTime())
  for (const workout of sorted) {
    const title = workout.title || workout.exerciseType || workout.exercise_type || ''
    const haystack = `${title} ${workout.notes || ''}`.toLowerCase()
    const matchedKeyword = region.workoutKeywords.find(keyword => haystack.includes(keyword.toLowerCase()))
    if (!matchedKeyword) continue
    return {
      id: workout.id,
      title,
      durationMinutes: workout.durationMinutes ?? workout.duration ?? null,
      intensity: workout.intensity ?? null,
      startedAt: workoutTime(workout) || null,
      notes: workout.notes ?? null,
      matchedKeyword,
    }
  }
  return null
}

function getBodyRegionDefinition(regionId: BodyRegionId): BodyRegionDefinition {
  const region = BODY_REGION_INDEX.get(regionId)
  if (!region) throw new Error(`Unknown body region: ${regionId}`)
  return region
}

function summarizeValues(region: BodyRegionDefinition, bodyMap: HealthBodyMap) {
  const assessments = region.sourceKeys
    .map(key => bodyMap[key])
    .filter((assessment): assessment is MuscleGroupAssessment => Boolean(assessment))
  const priorities = assessments.map(assessment => normalizePriority(assessment.priority)).filter(Boolean) as string[]
  return {
    count: assessments.length,
    priority: priorities.sort(comparePriority)[0] ?? null,
    developmentLevel: aggregateNumericField(assessments.map(assessment => assessment.development_level)) ?? 0,
    activationLevel: aggregateNumericField(assessments.map(assessment => assessment.activation_level)) ?? 0,
    postureConstraintLevel: aggregateNumericField(assessments.map(assessment => assessment.posture_constraint_level)) ?? 0,
  }
}

function aggregateNumericField(values: Array<number | undefined>): number | null {
  const numericValues = values.filter((value): value is number => typeof value === 'number' && !Number.isNaN(value))
  if (!numericValues.length) return null
  return roundToSingleDecimal(numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length)
}

function comparePriority(left: string, right: string): number {
  return getPriorityRank(left) - getPriorityRank(right)
}

function getPriorityRank(value: string): number {
  if (value === 'high') return 0
  if (value === 'medium') return 1
  if (value === 'low') return 2
  return 3
}

function normalizePriority(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.toLowerCase()
  return normalized === 'high' || normalized === 'medium' || normalized === 'low' ? normalized : null
}

function workoutTime(workout: HealthWorkoutLike): string {
  return workout.startedAt || workout.workout_at || ''
}

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10
}
