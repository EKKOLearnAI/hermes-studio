/**
 * 群协作 · 研发团队场景（零 LLM / 零外部 API）
 *
 * 模拟一次「产品经理发起大功能 → 拆解给项目经理 / 研发 / 测试 → 并行推进 → 汇总完成」
 * 的完整 Studio 群协作链路。Kanban CLI 与模型全部由内存 mock 代替，因此：
 *
 *  - 不消耗 token
 *  - 不依赖 gateway / dashscope / 真实 profile 目录
 *  - 覆盖：建卡、拆解、并行泳道、summary 回填、停止、最终 settle
 *
 * 角色（与 demo-dev-team-dryrun.sh / 容器 profiles 同名，便于对照 UI）：
 *  - mia  产品经理（协调者，@ 她发起协作）
 *  - leo  项目经理
 *  - kai  后端研发
 *  - nina 前端研发
 *  - sam  测试工程师
 *
 * 运行（在 xiaozhiv2-ccc 容器内）：
 *   cd /opt/studio && npx vitest run tests/server/collab-dev-team-scenario.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    CollabOrchestrator,
    type CollabSessionRow,
    type CollabSessionSnapshot,
} from '../../packages/server/src/services/hermes/group-chat/collab-orchestrator'
import type {
    KanbanDecomposeOutcome,
    KanbanTask,
    KanbanTaskDetail,
} from '../../packages/server/src/services/hermes/hermes-kanban'

beforeEach(() => {
    vi.stubEnv('HERMES_COLLAB_SIMULATE', '0')
})

/** Fixed roster — mirrors the profiles created by demo-dev-team-dryrun.sh. */
export const DEV_TEAM = {
    mia: { name: 'mia', role: '产品经理', duty: '发起需求、拆解验收标准、终审汇总' },
    leo: { name: 'leo', role: '项目经理', duty: '排期、风险与跨角色依赖' },
    kai: { name: 'kai', role: '后端研发', duty: 'API / 数据模型 / 权限服务' },
    nina: { name: 'nina', role: '前端研发', duty: '登录页与权限管理 UI' },
    sam: { name: 'sam', role: '测试工程师', duty: '用例、回归与验收报告' },
} as const

const FEATURE_GOAL =
    '开发「用户登录与权限管理」大功能：支持账号密码登录、角色权限配置、审计日志；' +
    '请按产品 / 项目 / 后端 / 前端 / 测试拆解并并行推进，最后由产品经理汇总验收。'

const WORKSPACE = '/opt/data/dev-team-demo'

/** What `kanban decompose` would return for this feature — no LLM involved. */
const FANOUT_PLAN: Array<{
    id: string
    title: string
    assignee: keyof typeof DEV_TEAM
    summary: string
}> = [
    {
        id: 't_prd',
        title: '撰写 PRD 与验收标准',
        assignee: 'mia',
        summary: 'PRD 完成：登录、角色矩阵、审计三类验收标准已固化。',
    },
    {
        id: 't_plan',
        title: '排期与跨角色依赖梳理',
        assignee: 'leo',
        summary: '排期完成：后端 API → 前端联调 → 测试回归，关键路径 3 天。',
    },
    {
        id: 't_be',
        title: '实现登录与权限 API',
        assignee: 'kai',
        summary: '后端完成：/auth/login、/rbac/roles、审计写入接口已就绪。',
    },
    {
        id: 't_fe',
        title: '实现登录页与权限管理 UI',
        assignee: 'nina',
        summary: '前端完成：登录页、角色配置页、权限开关联调通过。',
    },
    {
        id: 't_qa',
        title: '编写用例并回归验收',
        assignee: 'sam',
        summary: '测试完成：12 条用例全绿，关键路径回归通过，出具验收报告。',
    },
]

function task(overrides: Partial<KanbanTask> & { id: string }): KanbanTask {
    return {
        id: overrides.id,
        title: overrides.title ?? overrides.id,
        body: null,
        assignee: overrides.assignee ?? null,
        status: overrides.status ?? 'todo',
        priority: 0,
        tenant: overrides.tenant ?? 'collab-devteam',
        created_at: overrides.created_at ?? 1000,
        started_at: overrides.started_at ?? null,
        completed_at: overrides.completed_at ?? null,
        result: overrides.result ?? null,
        ...overrides,
    } as KanbanTask
}

function makeStorage() {
    const rows = new Map<string, CollabSessionRow>()
    return {
        rows,
        createCollabSession: (row: CollabSessionRow) => void rows.set(row.id, { ...row }),
        updateCollabSession: (id: string, patch: Partial<CollabSessionRow>) => {
            const existing = rows.get(id)
            if (existing) rows.set(id, { ...existing, ...patch })
        },
        getCollabSession: (id: string) => rows.get(id) ?? null,
        getCollabSessionByAnchor: (anchorMessageId: string) =>
            [...rows.values()].find(row => row.anchorMessageId === anchorMessageId) ?? null,
        listCollabSessionsByRoom: (roomId: string) => [...rows.values()].filter(row => row.roomId === roomId),
        listUnfinishedCollabSessions: () =>
            [...rows.values()].filter(row => row.status !== 'done' && row.status !== 'failed'),
    }
}

interface Board {
    tasks: KanbanTask[]
    details: Map<string, KanbanTaskDetail>
    listCalls: number
    gate: Promise<void> | null
}

interface ScenarioHarness {
    orchestrator: CollabOrchestrator
    storage: ReturnType<typeof makeStorage>
    snapshots: CollabSessionSnapshot[]
    board: Board
    created: Array<{ title: string; opts?: Record<string, unknown> }>
    decompose: ReturnType<typeof vi.fn>
    now: number
    poll(): Promise<void>
    /** Plant the fan-out children the decomposer "would" have created. */
    plantFanout(rootId: string, tenant: string): void
    /** Advance every non-root child one status step (ready→running→done). */
    advanceWorkers(step: 'start' | 'finish'): void
}

function makeScenarioHarness(): ScenarioHarness {
    const storage = makeStorage()
    const snapshots: CollabSessionSnapshot[] = []
    const board: Board = {
        tasks: [],
        details: new Map(),
        listCalls: 0,
        gate: null,
    }
    const created: Array<{ title: string; opts?: Record<string, unknown> }> = []
    const clock = { value: 0 }

    const decompose = vi.fn(async (rootId: string): Promise<KanbanDecomposeOutcome> => ({
        task_id: rootId,
        ok: true,
        reason: '',
        fanout: true,
        child_ids: FANOUT_PLAN.map(item => item.id),
        new_title: null,
    }))

    const plantFanout = (rootId: string, tenant: string) => {
        const root = board.tasks.find(item => item.id === rootId)
        if (root) root.status = 'todo'
        let t = 1001
        for (const item of FANOUT_PLAN) {
            board.tasks.push(task({
                id: item.id,
                title: item.title,
                assignee: item.assignee,
                status: 'ready',
                tenant,
                created_at: t,
            }))
            t += 1
        }
    }

    const advanceWorkers = (step: 'start' | 'finish') => {
        for (const item of FANOUT_PLAN) {
            const child = board.tasks.find(candidate => candidate.id === item.id)
            if (!child) continue
            if (step === 'start' && (child.status === 'ready' || child.status === 'todo')) {
                child.status = 'running'
                child.started_at = Math.floor(clock.value / 1000) || 1
            }
            if (step === 'finish' && child.status === 'running') {
                child.status = 'done'
                child.completed_at = (child.started_at || 1) + 30
                board.details.set(child.id, {
                    task: { ...child },
                    comments: [],
                    events: [],
                    runs: [],
                    latest_summary: FANOUT_PLAN.find(plan => plan.id === child.id)?.summary || '完成',
                })
            }
        }
    }

    const orchestrator = new CollabOrchestrator({
        storage,
        kanban: {
            createTask: async (title, opts) => {
                created.push({ title, opts: opts as Record<string, unknown> })
                const root = task({
                    id: 't_root',
                    title,
                    assignee: opts?.assignee ?? DEV_TEAM.mia.name,
                    status: 'triage',
                    tenant: String(opts?.tenant || 'collab-devteam'),
                })
                board.tasks = [root]
                return root
            },
            decomposeTask: async (taskId, opts) => {
                const outcome = await decompose(taskId, opts)
                // Mimic real decompose: children appear on the board immediately.
                const row = [...storage.rows.values()].find(item => item.rootTaskId === taskId)
                if (row) plantFanout(taskId, row.tenant)
                return outcome
            },
            listTasks: async () => {
                board.listCalls += 1
                if (board.gate) await board.gate
                return board.tasks
            },
            getTask: async (taskId) => board.details.get(taskId) ?? null,
            getTaskLog: async (taskId) => ({
                taskId,
                content: `[dry-run] ${taskId} worker log — no LLM called`,
                truncated: false,
                exists: true,
            } as never),
            dispatch: async () => ({}),
            reclaimTask: async (taskId) => {
                const existing = board.tasks.find(candidate => candidate.id === taskId)
                if (existing && existing.status === 'running') existing.status = 'ready'
                return { ok: true, output: '' }
            },
            blockTask: async (taskId, reason) => {
                const existing = board.tasks.find(candidate => candidate.id === taskId)
                if (existing && existing.status !== 'done' && existing.status !== 'archived') {
                    existing.status = 'blocked'
                    board.details.set(taskId, {
                        task: { ...existing, status: 'blocked' },
                        comments: [],
                        events: [{
                            id: 1, task_id: taskId, kind: 'blocked',
                            payload: { reason }, created_at: 1, run_id: null,
                        }],
                        runs: [],
                    })
                }
            },
        },
        postAnchorMessage: () => ({ id: 'anchor-devteam' }),
        emitToRoom: (_roomId, event, payload) => {
            if (event !== 'collab_session_updated') return
            snapshots.push((payload as { session: CollabSessionSnapshot }).session)
        },
        pollIntervalMs: 60_000,
        now: () => clock.value,
    })

    return {
        orchestrator,
        storage,
        snapshots,
        board,
        created,
        decompose,
        get now() { return clock.value },
        set now(value: number) { clock.value = value },
        poll: async () => {
            const [id] = [...storage.rows.keys()]
            await (orchestrator as unknown as { tick(sessionId: string): Promise<void> }).tick(id)
        },
        plantFanout,
        advanceWorkers,
    }
}

async function flush(): Promise<void> {
    for (let i = 0; i < 16; i += 1) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
}

describe('群协作 · 研发团队场景（零 LLM）', () => {
    let harness: ScenarioHarness

    beforeEach(() => {
        harness = makeScenarioHarness()
    })

    it('产品经理 @mia 发起需求后，根任务落到独立 tenant 并带上工作目录', async () => {
        const started = harness.orchestrator.start({
            roomId: 'room-devteam',
            triggerMessageId: 'msg-user-1',
            goal: FEATURE_GOAL,
            coordinator: DEV_TEAM.mia.name,
            workspace: WORKSPACE,
        })
        expect(started).not.toBeNull()
        expect(started!.status).toBe('creating')
        expect(started!.coordinator).toBe('mia')

        await flush()

        expect(harness.created).toHaveLength(1)
        const opts = harness.created[0].opts!
        expect(opts.assignee).toBe('mia')
        expect(opts.triage).toBe(true)
        expect(opts.workspace).toBe(`dir:${WORKSPACE}`)
        expect(String(opts.tenant)).toMatch(/^collab-/)
        expect(harness.decompose).toHaveBeenCalledTimes(1)

        const [row] = [...harness.storage.rows.values()]
        expect(row.status).toBe('running')
        expect(row.rootTaskId).toBe('t_root')
    })

    it('拆解后五位角色各领一张卡，泳道按人并行（非串行）', async () => {
        harness.orchestrator.start({
            roomId: 'room-devteam',
            triggerMessageId: 'msg-user-1',
            goal: FEATURE_GOAL,
            coordinator: 'mia',
            workspace: WORKSPACE,
        })
        await flush()
        await harness.poll()

        const latest = harness.snapshots.at(-1)!
        expect(latest.totalChildren).toBe(FANOUT_PLAN.length)
        expect(latest.doneChildren).toBe(0)

        const assignees = latest.tasks.filter(t => !t.isRoot).map(t => t.assignee).sort()
        expect(assignees).toEqual(['kai', 'leo', 'mia', 'nina', 'sam'].sort())

        // Every child is ready at once — that is the parallelism contract.
        const childStatuses = latest.tasks.filter(t => !t.isRoot).map(t => t.status)
        expect(childStatuses.every(status => status === 'ready')).toBe(true)
        expect(latest.status).toBe('running')
    })

    it('各角色并行执行并回写 summary 后，整次协作 settle 为 done', async () => {
        harness.orchestrator.start({
            roomId: 'room-devteam',
            triggerMessageId: 'msg-user-1',
            goal: FEATURE_GOAL,
            coordinator: 'mia',
            workspace: WORKSPACE,
        })
        await flush()

        // Round 1: everyone starts working in parallel.
        harness.advanceWorkers('start')
        await harness.poll()
        let snap = harness.snapshots.at(-1)!
        expect(snap.tasks.filter(t => !t.isRoot).every(t => t.status === 'running')).toBe(true)
        expect(snap.doneChildren).toBe(0)

        // Round 2: everyone finishes; summaries land via latest_summary.
        harness.advanceWorkers('finish')
        // Root still waits to write the final summary (coordinator wake-up).
        await harness.poll()
        snap = harness.snapshots.at(-1)!
        expect(snap.doneChildren).toBe(FANOUT_PLAN.length)
        expect(snap.tasks.find(t => t.id === 't_be')!.summary).toContain('后端完成')
        expect(snap.tasks.find(t => t.id === 't_qa')!.summary).toContain('验收报告')
        // Children done but root still open → run stays alive for the summary.
        expect([...harness.storage.rows.values()][0].status).toBe('running')

        // Round 3: coordinator (mia) finishes the root summary → done.
        const root = harness.board.tasks.find(t => t.id === 't_root')!
        root.status = 'done'
        root.completed_at = 2000
        harness.board.details.set('t_root', {
            task: { ...root },
            comments: [],
            events: [],
            runs: [],
            latest_summary: '产品验收通过：「用户登录与权限管理」已交付，可发布。',
        })
        await harness.poll()

        const [row] = [...harness.storage.rows.values()]
        expect(row.status).toBe('done')
        expect(row.error).toBe('')
        const finalSnap = harness.snapshots.at(-1)!
        expect(finalSnap.status).toBe('done')
        expect(finalSnap.tasks.find(t => t.isRoot)!.summary).toContain('产品验收通过')
    })

    it('执行中途点停止：杀掉进行中的 worker，未完成任务全部阻塞', async () => {
        harness.orchestrator.start({
            roomId: 'room-devteam',
            triggerMessageId: 'msg-user-1',
            goal: FEATURE_GOAL,
            coordinator: 'mia',
            workspace: WORKSPACE,
        })
        await flush()
        harness.advanceWorkers('start')
        // Finish only QA early so we can assert finished work is left alone.
        const qa = harness.board.tasks.find(t => t.id === 't_qa')!
        qa.status = 'done'
        qa.completed_at = 1500
        harness.board.details.set('t_qa', {
            task: { ...qa },
            comments: [], events: [], runs: [],
            latest_summary: '测试中途已产出部分用例。',
        })
        await harness.poll()

        const [row] = [...harness.storage.rows.values()]
        const stopped = await harness.orchestrator.stop(row.id, '用户已停止')
        expect(stopped?.status).toBe('failed')
        expect(stopped?.error).toBe('用户已停止')

        expect(harness.board.tasks.find(t => t.id === 't_qa')!.status).toBe('done')
        expect(harness.board.tasks.find(t => t.id === 't_be')!.status).toBe('blocked')
        expect(harness.board.tasks.find(t => t.id === 't_fe')!.status).toBe('blocked')
        expect(harness.board.tasks.find(t => t.id === 't_root')!.status).toBe('blocked')
    })

    it('DEV_TEAM 花名册覆盖产品 / 项目 / 研发 / 测试四类角色', () => {
        const roles = Object.values(DEV_TEAM).map(member => member.role)
        expect(roles).toContain('产品经理')
        expect(roles).toContain('项目经理')
        expect(roles).toContain('后端研发')
        expect(roles).toContain('前端研发')
        expect(roles).toContain('测试工程师')
        expect(FANOUT_PLAN.map(item => item.assignee).sort()).toEqual(
            ['kai', 'leo', 'mia', 'nina', 'sam'].sort(),
        )
    })
})
