// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const fetchSkillUsageStatsMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/skills', () => ({
  fetchSkillUsageStats: fetchSkillUsageStatsMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'skillsUsage.periodLabel') return `${params?.days}d`
      if (key === 'skillsUsage.periodSummary') return `Last ${params?.days} days`
      return key
    },
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    NButton: {
      props: ['loading', 'type', 'size', 'quaternary', 'secondary'],
      inheritAttrs: false,
      template: '<button :data-type="type" :aria-pressed="$attrs[\'aria-pressed\']" @click="$emit(\'click\')"><slot /></button>',
    },
  }
})

import SkillsUsageView from '@/views/hermes/SkillsUsageView.vue'

const sevenDayStats = {
  period_days: 7,
  summary: {
    total_skill_loads: 3,
    total_skill_edits: 1,
    total_skill_actions: 4,
    distinct_skills_used: 2,
  },
  by_day: [
    {
      date: '2026-05-10',
      view_count: 1,
      manage_count: 0,
      total_count: 1,
      skills: [
        { skill: 'github-pr-workflow', view_count: 1, manage_count: 0, total_count: 1 },
      ],
    },
    {
      date: '2026-05-11',
      view_count: 2,
      manage_count: 1,
      total_count: 3,
      skills: [
        { skill: 'hermes-agent', view_count: 2, manage_count: 1, total_count: 3 },
      ],
    },
  ],
  top_skills: [
    { skill: 'hermes-agent', view_count: 2, manage_count: 1, total_count: 3, percentage: 75, last_used_at: 1_700_000_000 },
    { skill: 'github-pr-workflow', view_count: 1, manage_count: 0, total_count: 1, percentage: 25, last_used_at: null },
  ],
}

describe('SkillsUsageView', () => {
  beforeEach(() => {
    fetchSkillUsageStatsMock.mockReset()
    fetchSkillUsageStatsMock.mockResolvedValue(sevenDayStats)
  })

  it('loads rolling 7 day skill usage and renders statistics beside a skill-colored visual trend', async () => {
    const wrapper = mount(SkillsUsageView)
    await flushPromises()

    expect(fetchSkillUsageStatsMock).toHaveBeenCalledWith(7)
    expect(wrapper.text()).toContain('skillsUsage.title')
    expect(wrapper.find('[data-testid="skills-usage-chart"]').exists()).toBe(true)
    expect(wrapper.findAll('.skill-bar-col')).toHaveLength(2)
    expect(wrapper.findAll('.skill-bar-segment[data-skill="hermes-agent"]')).toHaveLength(1)
    expect(wrapper.findAll('.skill-bar-segment[data-skill="github-pr-workflow"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="skills-usage-legend"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="skills-usage-stats"]').text()).toContain('4')
    expect(wrapper.text()).toContain('hermes-agent')
    expect(wrapper.text()).toContain('github-pr-workflow')
    expect(wrapper.text()).toContain('75.0%')
  })

  it('reloads the selected period when the period button changes', async () => {
    const wrapper = mount(SkillsUsageView)
    await flushPromises()
    fetchSkillUsageStatsMock.mockClear()

    const thirtyDayButton = wrapper.findAll('button').find(button => button.text() === '30d')
    expect(thirtyDayButton).toBeTruthy()

    await thirtyDayButton!.trigger('click')
    await flushPromises()

    expect(fetchSkillUsageStatsMock).toHaveBeenCalledWith(30)
    expect(thirtyDayButton!.attributes('aria-pressed')).toBe('true')
  })

  it('flips the chart tooltip away from the hovered side of the bars', async () => {
    const wrapper = mount(SkillsUsageView)
    await flushPromises()

    const bars = wrapper.findAll('.skill-bar-col')
    expect(bars).toHaveLength(2)

    await bars[1].trigger('mouseenter')
    expect(wrapper.find('.floating-tooltip.align-left').exists()).toBe(true)
    expect(wrapper.find('.floating-tooltip').text()).toContain('2026-05-11')

    await bars[0].trigger('mouseenter')
    expect(wrapper.find('.floating-tooltip.align-right').exists()).toBe(true)
    expect(wrapper.find('.floating-tooltip').text()).toContain('2026-05-10')
  })

  it('keeps stale data visible while refreshing an already loaded period', async () => {
    const wrapper = mount(SkillsUsageView)
    await flushPromises()

    let resolveRefresh!: (value: unknown) => void
    fetchSkillUsageStatsMock.mockReturnValueOnce(new Promise(resolve => {
      resolveRefresh = resolve
    }))

    const refreshButton = wrapper.findAll('button').find(button => button.text() === 'skillsUsage.refresh')
    expect(refreshButton).toBeTruthy()

    await refreshButton!.trigger('click')

    expect(fetchSkillUsageStatsMock).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="skills-usage-chart"]').exists()).toBe(true)
    expect(wrapper.find('.usage-panel.is-refreshing').exists()).toBe(true)

    resolveRefresh({
      period_days: 7,
      summary: { total_skill_loads: 1, total_skill_edits: 0, total_skill_actions: 1, distinct_skills_used: 1 },
      by_day: [
        {
          date: '2026-05-12',
          view_count: 1,
          manage_count: 0,
          total_count: 1,
          skills: [{ skill: 'test-driven-development', view_count: 1, manage_count: 0, total_count: 1 }],
        },
      ],
      top_skills: [
        { skill: 'test-driven-development', view_count: 1, manage_count: 0, total_count: 1, percentage: 100, last_used_at: null },
      ],
    })
    await flushPromises()

    expect(wrapper.text()).toContain('test-driven-development')
  })

  it('does not let an older refresh overwrite newer stats for the same period', async () => {
    const wrapper = mount(SkillsUsageView)
    await flushPromises()

    let resolveOlder!: (value: unknown) => void
    let resolveNewer!: (value: unknown) => void
    fetchSkillUsageStatsMock
      .mockReturnValueOnce(new Promise(resolve => { resolveOlder = resolve }))
      .mockReturnValueOnce(new Promise(resolve => { resolveNewer = resolve }))

    const refreshButton = wrapper.findAll('button').find(button => button.text() === 'skillsUsage.refresh')
    expect(refreshButton).toBeTruthy()

    await refreshButton!.trigger('click')
    await refreshButton!.trigger('click')

    resolveNewer({
      period_days: 7,
      summary: { total_skill_loads: 2, total_skill_edits: 0, total_skill_actions: 2, distinct_skills_used: 1 },
      by_day: [
        {
          date: '2026-05-13',
          view_count: 2,
          manage_count: 0,
          total_count: 2,
          skills: [{ skill: 'newer-skill', view_count: 2, manage_count: 0, total_count: 2 }],
        },
      ],
      top_skills: [
        { skill: 'newer-skill', view_count: 2, manage_count: 0, total_count: 2, percentage: 100, last_used_at: null },
      ],
    })
    await flushPromises()

    expect(wrapper.text()).toContain('newer-skill')

    resolveOlder({
      period_days: 7,
      summary: { total_skill_loads: 1, total_skill_edits: 0, total_skill_actions: 1, distinct_skills_used: 1 },
      by_day: [
        {
          date: '2026-05-12',
          view_count: 1,
          manage_count: 0,
          total_count: 1,
          skills: [{ skill: 'older-skill', view_count: 1, manage_count: 0, total_count: 1 }],
        },
      ],
      top_skills: [
        { skill: 'older-skill', view_count: 1, manage_count: 0, total_count: 1, percentage: 100, last_used_at: null },
      ],
    })
    await flushPromises()

    expect(wrapper.text()).toContain('newer-skill')
    expect(wrapper.text()).not.toContain('older-skill')
  })
})
