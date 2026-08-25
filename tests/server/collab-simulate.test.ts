/**
 * Zero-token 群协作模拟：叙事文案 + 内存看板，不调用 Kanban/LLM。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    CollabOrchestrator,
    type CollabSessionRow,
    type CollabSessionSnapshot,
} from '../../packages/server/src/services/hermes/group-chat/collab-orchestrator'
import {
    buildSimulatePlan,
    formatThinkingMessage,
    isCollabSimulateEnabled,
    readHermesEnvValue,
    SIMULATE_PACE_MS,
} from '../../packages/server/src/services/hermes/group-chat/collab-simulate'
import type { KanbanTask } from '../../packages/server/src/services/hermes/hermes-kanban'

describe('collab-simulate helpers', () => {
    it('defaults simulate ON unless explicitly disabled', () => {
        vi.stubEnv('HERMES_COLLAB_SIMULATE', '1')
        expect(isCollabSimulateEnabled()).toBe(true)
        vi.stubEnv('HERMES_COLLAB_SIMULATE', '0')
        expect(isCollabSimulateEnabled()).toBe(false)
        expect(isCollabSimulateEnabled(true)).toBe(true)
        expect(isCollabSimulateEnabled(false)).toBe(false)
    })

    it('honours HERMES_COLLAB_SIMULATE from Hermes .env when process env is unset', () => {
        const fs = require('fs') as typeof import('fs')
        const os = require('os') as typeof import('os')
        const path = require('path') as typeof import('path')
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-sim-env-'))
        fs.writeFileSync(path.join(dir, '.env'), 'HERMES_COLLAB_SIMULATE=0\n')
        vi.stubEnv('HERMES_HOME', dir)
        vi.stubEnv('HOME', dir)
        delete process.env.HERMES_COLLAB_SIMULATE
        expect(isCollabSimulateEnabled()).toBe(false)
        fs.writeFileSync(path.join(dir, '.env'), 'HERMES_COLLAB_SIMULATE=1\n')
        expect(isCollabSimulateEnabled()).toBe(true)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('reads the container Hermes .env at /opt/data when HOME points there', () => {
        const fs = require('fs') as typeof import('fs')
        if (!fs.existsSync('/opt/data/.env')) return
        delete process.env.HERMES_COLLAB_SIMULATE
        delete process.env.HERMES_HOME
        vi.stubEnv('HOME', '/opt/data')
        const raw = readHermesEnvValue('HERMES_COLLAB_SIMULATE')
        expect(raw).toBeDefined()
        expect(isCollabSimulateEnabled()).toBe(
            !(['0', 'false', 'off', 'live'].includes(String(raw).trim().toLowerCase())),
        )
    })

    it('builds a 研发团队 fan-out with a coordination chain', () => {
        const plan = buildSimulatePlan(
            '开发登录与权限',
            'mia',
            [],
        )
        expect(plan.children.length).toBeGreaterThanOrEqual(4)
        expect(plan.chain.length).toBeGreaterThan(plan.children.length)
        expect(formatThinkingMessage('mia', '开发登录与权限', plan)).toContain('零 Token')
        expect(formatThinkingMessage('mia', '开发登录与权限', plan)).toContain('@')
    })
})

describe('CollabOrchestrator simulate pipeline', () => {
    let storage: {
        rows: Map<string, CollabSessionRow>
        createCollabSession: (row: CollabSessionRow) => void
        updateCollabSession: (id: string, patch: Partial<CollabSessionRow>) => void
        getCollabSession: (id: string) => CollabSessionRow | null
        getCollabSessionByAnchor: () => null
        listCollabSessionsByRoom: () => CollabSessionRow[]
        listUnfinishedCollabSessions: () => CollabSessionRow[]
    }
    let narratives: Array<{ profile: string; content: string }>
    let snapshots: CollabSessionSnapshot[]
    let createCalls: number
    let anchorAtNarrativeCount: number
    let orchestrator: CollabOrchestrator

    beforeEach(() => {
        vi.useFakeTimers()
        vi.stubEnv('HERMES_COLLAB_SIMULATE', '1')
        narratives = []
        snapshots = []
        createCalls = 0
        anchorAtNarrativeCount = -1
        const rows = new Map<string, CollabSessionRow>()
        storage = {
            rows,
            createCollabSession: (row) => { rows.set(row.id, { ...row }) },
            updateCollabSession: (id, patch) => {
                const row = rows.get(id)
                if (row) Object.assign(row, patch)
            },
            getCollabSession: (id) => rows.get(id) || null,
            getCollabSessionByAnchor: () => null,
            listCollabSessionsByRoom: () => [...rows.values()],
            listUnfinishedCollabSessions: () => [...rows.values()].filter(
                row => row.status !== 'done' && row.status !== 'failed',
            ),
        }
        orchestrator = new CollabOrchestrator({
            storage,
            kanban: {
                createTask: async () => {
                    createCalls += 1
                    throw new Error('simulate must not call createTask')
                },
                decomposeTask: async () => {
                    throw new Error('simulate must not call decomposeTask')
                },
                listTasks: async () => [] as KanbanTask[],
                getTask: async () => null,
                getTaskLog: async () => ({ taskId: '', content: '', truncated: false, exists: false }),
                dispatch: async () => ({}),
                reclaimTask: async () => ({}),
                blockTask: async () => {},
            },
            postAnchorMessage: () => {
                anchorAtNarrativeCount = narratives.length
                return { id: 'anchor-sim' }
            },
            postAgentMessage: ({ profile, content }) => {
                narratives.push({ profile, content })
                return { id: `msg-${narratives.length}` }
            },
            listRoomAgents: () => [
                { profile: 'mia', name: 'mia', description: '产品经理' },
                { profile: 'leo', name: 'leo', description: '项目经理' },
                { profile: 'kai', name: 'kai', description: '后端' },
                { profile: 'nina', name: 'nina', description: '前端' },
                { profile: 'sam', name: 'sam', description: '测试' },
            ],
            emitToRoom: (_roomId, event, payload) => {
                if (event === 'collab_session_updated') {
                    const session = (payload as { session?: CollabSessionSnapshot }).session
                    if (session) snapshots.push(session)
                }
            },
            pollIntervalMs: 50,
        })
    })

    afterEach(() => {
        orchestrator.shutdown()
        vi.useRealTimers()
        vi.unstubAllEnvs()
    })

    it('posts thinking before the task-board anchor', async () => {
        orchestrator.start({
            roomId: 'r-sim',
            triggerMessageId: 'm1',
            goal: '开发「用户登录与权限管理」大功能',
            coordinator: 'mia',
            workspace: '/opt/data/dev-team-demo',
            simulate: true,
        })
        expect(narratives).toHaveLength(1)
        expect(narratives[0]?.content).toContain('零 Token')
        expect(anchorAtNarrativeCount).toBe(-1)

        await vi.advanceTimersByTimeAsync(SIMULATE_PACE_MS.thinking)
        expect(anchorAtNarrativeCount).toBe(1)
    })

    it('narrates assign/handoff/summary without touching Kanban or LLM', async () => {
        const started = orchestrator.start({
            roomId: 'r-sim',
            triggerMessageId: 'm1',
            goal: '开发「用户登录与权限管理」大功能',
            coordinator: 'mia',
            workspace: '/opt/data/dev-team-demo',
            simulate: true,
        })
        expect(started?.simulate).toBe(true)
        expect(String(started?.tenant)).toMatch(/^collab-sim-/)

        // Advance through the whole scripted timeline.
        await vi.runAllTimersAsync()

        expect(createCalls).toBe(0)
        expect(narratives.length).toBeGreaterThan(6)
        expect(narratives.some(item => item.content.includes('零 Token'))).toBe(true)
        expect(narratives.some(item => item.content.includes('调用'))).toBe(true)
        expect(narratives.some(item => item.profile === 'kai')).toBe(true)
        expect(narratives.some(item => item.content.includes('汇总'))).toBe(true)

        const [row] = [...storage.rows.values()]
        expect(row.status).toBe('done')
        const last = snapshots.at(-1)
        expect(last?.status).toBe('done')
        expect(last?.totalChildren).toBeGreaterThanOrEqual(4)
        expect(last?.doneChildren).toBe(last?.totalChildren)
        expect(last?.simulate).toBe(true)
    })
})
