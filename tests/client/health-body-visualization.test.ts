import { describe, expect, it } from 'vitest'
import {
  getBodyRegionStatusTone,
  getBodyRegionSummary,
  getCompensationChainRegions,
  getRelatedWorkoutSummary,
  getVisiblePostureIssueOverlays,
} from '../../packages/client/src/views/hermes/health/body-visualization'
import { getAnatomyRegionDefinition } from '../../packages/client/src/views/hermes/health/body-3d-model-mapping'

describe('health body visualization helpers', () => {
  it('maps anatomy regions to shipped model assets', () => {
    const shoulders = getAnatomyRegionDefinition('shoulders')

    expect(shoulders.label).toBe('肩部')
    expect(shoulders.assets.length).toBeGreaterThan(0)
    expect(shoulders.assets[0].file).toMatch(/^\/models\/health\/bodyparts3d\/.+\.stl$/)
  })

  it('derives region status and summaries from body map values', () => {
    const bodyMap = {
      rear_delts: { priority: 'high', development_level: 4, activation_level: 1, posture_constraint_level: 4 },
      lats: { priority: 'low', development_level: 4, activation_level: 4, posture_constraint_level: 1 },
    }

    expect(getBodyRegionStatusTone('shoulders', bodyMap)).toBe('high')
    expect(getBodyRegionStatusTone('lats', bodyMap)).toBe('good')
    expect(getBodyRegionSummary('shoulders', bodyMap)).toMatchObject({
      id: 'shoulders',
      label: '肩部',
      priority: 'high',
      activationLevel: 1,
      postureConstraintLevel: 4,
      statusTone: 'high',
    })
  })

  it('maps posture issues and compensation chains to overlays', () => {
    const overlays = getVisiblePostureIssueOverlays({
      issues: [{ id: 'pelvic_anterior_tilt' }, { id: 'right_scapular_downward_rotation' }],
    })

    expect(overlays.map(overlay => overlay.id)).toEqual(expect.arrayContaining([
      'pelvic_anterior_tilt',
      'right_scapular_downward_rotation',
    ]))
    expect(getCompensationChainRegions(['pelvis', 'ribcage', 'head_neck'])).toEqual(expect.arrayContaining([
      'glutes',
      'chest',
      'shoulders',
    ]))
  })

  it('finds a related workout for a selected region', () => {
    const workout = getRelatedWorkoutSummary('chest', [
      { id: 'workout-1', title: 'Bench Press', durationMinutes: 45, intensity: 'medium', notes: 'flat press', startedAt: '2026-06-20T18:00:00Z' },
    ])

    expect(workout).toMatchObject({
      id: 'workout-1',
      title: 'Bench Press',
      matchedKeyword: 'bench',
    })
  })
})
