import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReaddir = vi.hoisted(() => vi.fn())
const mockStat = vi.hoisted(() => vi.fn())
const mockReadFile = vi.hoisted(() => vi.fn())
const mockListAIMembers = vi.hoisted(() => vi.fn())
const mockListTasks = vi.hoisted(() => vi.fn())
const mockGetStats = vi.hoisted(() => vi.fn())
const mockCreateTask = vi.hoisted(() => vi.fn())
const mockGetTask = vi.hoisted(() => vi.fn())

vi.mock('fs/promises', () => ({
  readdir: mockReaddir,
  stat: mockStat,
  readFile: mockReadFile,
}))

vi.mock('../../packages/server/src/db/hermes/ai-members-store', () => ({
  listAIMembers: mockListAIMembers,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-kanban', () => ({
  listTasks: mockListTasks,
  getStats: mockGetStats,
  createTask: mockCreateTask,
  getTask: mockGetTask,
  assignTask: vi.fn(),
  blockTask: vi.fn(),
  completeTasks: vi.fn(),
}))

import * as service from '../../packages/server/src/services/hermes/war-room'

function dirent(name: string, isFile = true) {
  return { name, isFile: () => isFile }
}

describe('war-room service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReaddir.mockReset()
    mockStat.mockReset()
    mockReadFile.mockReset()
    mockListAIMembers.mockReset()
    mockListTasks.mockReset()
    mockGetStats.mockReset()
    mockCreateTask.mockReset()
    mockGetTask.mockReset()
  })

  it('collects matching reports from generated directories ordered by mtime with summaries', async () => {
    mockReaddir
      .mockResolvedValueOnce([
        dirent('warroom_audit.md'),
        dirent('release_gate_20260522.txt'),
        dirent('ignore.txt'),
        dirent('nested', false),
      ])
      .mockResolvedValueOnce([
        dirent('pm_100_acceptance.md'),
        dirent('stability_run_summary.json'),
      ])
    mockStat
      .mockResolvedValueOnce({ mtimeMs: 10, size: 100 })
      .mockResolvedValueOnce({ mtimeMs: 40, size: 400 })
      .mockResolvedValueOnce({ mtimeMs: 30, size: 300 })
      .mockResolvedValueOnce({ mtimeMs: 20, size: 200 })
    mockReadFile
      .mockResolvedValueOnce('release gate\nPASS\nextra\nlines\nignored')
      .mockResolvedValueOnce('pm\n100')
      .mockResolvedValueOnce('stability\nPASS')

    const reports = await service.collectWarRoomReports(3)

    expect(reports.map(report => report.name)).toEqual([
      'release_gate_20260522.txt',
      'pm_100_acceptance.md',
      'stability_run_summary.json',
    ])
    expect(reports[0].kind).toBe('发布门禁')
    expect(reports[0].summary).toBe('release gate / PASS / extra / lines')
    expect(reports[1].kind).toBe('PM100验收')
    expect(reports[2].kind).toBe('稳定性摘要')
  })

  it('tolerates missing report directories and unreadable summary files', async () => {
    mockReaddir
      .mockRejectedValueOnce(new Error('missing repo dir'))
      .mockResolvedValueOnce([dirent('hermes_acceptance_latest.md')])
    mockStat.mockResolvedValueOnce({ mtimeMs: 5, size: 50 })
    mockReadFile.mockRejectedValueOnce(new Error('permission denied'))

    const reports = await service.collectWarRoomReports()

    expect(reports).toHaveLength(1)
    expect(reports[0].kind).toBe('Hermes验收')
    expect(reports[0].summary).toBe('')
  })

  it('loads snapshot with tenant-scoped tasks and falls back when tenant list fails', async () => {
    mockListAIMembers.mockReturnValue([{ id: 'member-1' }])
    mockListTasks
      .mockRejectedValueOnce(new Error('tenant filter unsupported'))
      .mockResolvedValueOnce([{ id: 'task-1' }])
    mockGetStats.mockResolvedValue({ total: 1 })
    mockReaddir.mockRejectedValue(new Error('no reports'))

    const snapshot = await service.getSnapshot('ops')

    expect(mockListAIMembers).toHaveBeenCalledWith('ops')
    expect(mockListTasks.mock.calls[0][0]).toEqual({ tenant: 'war-room' })
    expect(mockListTasks.mock.calls[1][0]).toBeUndefined()
    expect(snapshot.tasks).toEqual([{ id: 'task-1' }])
    expect(snapshot.stats).toEqual({ total: 1 })
    expect(snapshot.reports).toEqual([])
    expect(typeof snapshot.generated_at).toBe('number')
  })

  it('creates war-room tenant tasks by default while preserving explicit tenant', async () => {
    mockCreateTask
      .mockResolvedValueOnce({ id: 'task-default' })
      .mockResolvedValueOnce({ id: 'task-custom' })

    await service.createTask({ title: 'Default tenant', priority: 3 })
    await service.createTask({ title: 'Custom tenant', tenant: 'ops', assignee: 'alice' })

    expect(mockCreateTask.mock.calls[0]).toEqual(['Default tenant', { body: undefined, assignee: undefined, priority: 3, tenant: 'war-room' }])
    expect(mockCreateTask.mock.calls[1]).toEqual(['Custom tenant', { body: undefined, assignee: 'alice', priority: undefined, tenant: 'ops' }])
  })

  it('returns null evidence for missing tasks and merges events/runs chronologically', async () => {
    mockGetTask
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        task: { id: 'task-1' },
        events: [
          { id: 'event-2', kind: 'blocked', created_at: 30, payload: { reason: 'wait' } },
          { id: 'event-1', kind: 'created', created_at: 10, payload: {} },
        ],
        runs: [
          { id: 'run-1', status: 'completed', started_at: 20, summary: 'done', outcome: 'ok', error: null, ended_at: 25, profile: 'ops' },
        ],
      })
    mockReaddir.mockRejectedValue(new Error('no reports'))

    await expect(service.getEvidence('missing')).resolves.toBeNull()

    const evidence = await service.getEvidence('task-1')

    expect(evidence?.task).toEqual({ id: 'task-1' })
    expect(evidence?.timeline.map(item => item.id)).toEqual(['event-1', 'run-1', 'event-2'])
    expect(evidence?.timeline[1]).toMatchObject({ kind: 'run:completed', summary: 'done' })
    expect(evidence?.reports).toEqual([])
    expect(typeof evidence?.generated_at).toBe('number')
  })
})
