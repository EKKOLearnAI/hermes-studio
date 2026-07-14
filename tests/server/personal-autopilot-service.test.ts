import { describe, expect, it } from 'vitest'
import { buildPersonalAutopilotSnapshot, classifyQuickLog, reminderMessageCodeForAction } from '../../packages/server/src/services/hermes/personal-autopilot'

describe('personal autopilot service', () => {
  it('selects the next scheduled task as the next best action', () => {
    const snapshot = buildPersonalAutopilotSnapshot({
      now: new Date('2026-07-04T09:00:00+08:00'),
      personal: {
        planningContext: {
          todayTasks: [
            {
              id: 'task-breakfast',
              title: '吃高蛋白早餐',
              summary: '鸡蛋和酸奶',
              notes: '鸡蛋和酸奶',
              status: 'open',
              priority: 'high',
              dueAt: null,
              scheduledStart: '2026-07-04T09:15:00+08:00',
              scheduledEnd: null,
              projectId: null,
              tags: ['diet'],
            },
          ],
          activeProjects: [],
          upcomingEvents: [],
          inboxItems: [],
          plans: [],
          pendingProposals: [],
          overdueTasks: [],
        },
      },
      health: {
        digitalTwinSummary: {
          currentWeightKg: 80,
          targetWeightKg: 75,
          externalConcernCount: 1,
          internalMarkerCount: 0,
          micronutrientGapCount: 0,
        },
        nutritionSummary: { consumed: {}, targets: {}, remaining: {} },
        recentWorkouts: [],
        foodLogs: [],
        internalMarkers: [],
      },
    } as any)

    expect(snapshot.mode).toBe('nudge')
    expect(snapshot.nextAction).toMatchObject({
      domain: 'diet',
      sourceId: 'task-breakfast',
      title: '吃高蛋白早餐',
    })
  })

  it('switches to takeover mode when execution is collapsing', () => {
    const snapshot = buildPersonalAutopilotSnapshot({
      now: new Date('2026-07-04T22:30:00+08:00'),
      personal: {
        planningContext: {
          todayTasks: [
            {
              id: 'task-workout',
              title: '训练',
              summary: '',
              notes: '',
              status: 'open',
              priority: 'high',
              scheduledStart: '2026-07-04T18:00:00+08:00',
              scheduledEnd: null,
              dueAt: null,
              projectId: null,
              tags: ['workout'],
            },
            {
              id: 'task-skincare',
              title: '护肤',
              summary: '',
              notes: '',
              status: 'open',
              priority: 'medium',
              scheduledStart: '2026-07-04T22:00:00+08:00',
              scheduledEnd: null,
              dueAt: null,
              projectId: null,
              tags: ['skin'],
            },
          ],
          activeProjects: [],
          upcomingEvents: [],
          inboxItems: [],
          plans: [],
          pendingProposals: [],
          overdueTasks: [],
        },
      },
      health: {
        digitalTwinSummary: {
          currentWeightKg: 80,
          targetWeightKg: 75,
          externalConcernCount: 0,
          internalMarkerCount: 0,
          micronutrientGapCount: 0,
        },
        nutritionSummary: { consumed: {}, targets: {}, remaining: {} },
        recentWorkouts: [],
        foodLogs: [],
        internalMarkers: [],
      },
    } as any)

    expect(snapshot.mode).toBe('takeover')
    expect(snapshot.nextAction.fallbackTitle).toContain('5')
  })

  it('falls back to the legacy task list when planning context is not available', () => {
    const snapshot = buildPersonalAutopilotSnapshot({
      now: new Date('2026-07-04T15:00:00+08:00'),
      personal: {
        tasks: [
          {
            id: 'legacy-task',
            title: '下午训练',
            summary: '推训练',
            notes: '推训练',
            status: 'open',
            sourceProposalId: null,
            provenance: {},
          },
        ],
      },
      health: {
        digitalTwinSummary: {
          currentWeightKg: 80,
          targetWeightKg: 75,
          externalConcernCount: 0,
          internalMarkerCount: 0,
          micronutrientGapCount: 0,
        },
        nutritionSummary: { consumed: {}, targets: {}, remaining: {} },
        recentWorkouts: [],
        foodLogs: [],
        internalMarkers: [],
      },
    } as any)

    expect(snapshot.nextAction).toMatchObject({
      domain: 'body',
      sourceId: 'legacy-task',
      title: '下午训练',
    })
  })

  it('classifies quick logs into body transformation domains', () => {
    expect(classifyQuickLog('午饭吃了鸡腿饭，加奶茶')).toBe('diet')
    expect(classifyQuickLog('脸出油，鼻翼有点红')).toBe('skin')
    expect(classifyQuickLog('胸肩练了40分钟')).toBe('body')
    expect(classifyQuickLog('今天状态崩了，想早点睡')).toBe('recovery')
  })

  it('maps action domains to the bounded health reminder template vocabulary', () => {
    expect(reminderMessageCodeForAction({ domain: 'diet' })).toBe('meal_due')
    expect(reminderMessageCodeForAction({ domain: 'body' })).toBe('training_adjustment')
    expect(reminderMessageCodeForAction({ domain: 'recovery' })).toBe('recovery_check')
    expect(reminderMessageCodeForAction({ domain: 'planning' })).toBe('recovery_check')
  })
})
