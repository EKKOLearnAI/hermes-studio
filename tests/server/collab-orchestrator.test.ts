import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    buildRootTaskBody,
    CollabOrchestrator,
    latestBlockReason,
    settleOutcome,
    splitGoalIntoTitleAndBody,
    type CollabSessionRow,
    type CollabSessionSnapshot,
    type CollabTaskSnapshot,
} from '../../packages/server/src/services/hermes/group-chat/collab-orchestrator'
import type {
    KanbanDecomposeOutcome,
    KanbanTask,
    KanbanTaskDetail,
} from '../../packages/server/src/services/hermes/hermes-kanban'

function task(overrides: Partial<KanbanTask> & { id: string }): KanbanTask {
    return {
        id: overrides.id,
        title: overrides.title ?? overrides.id,
        body: null,
        assignee: overrides.assignee ?? null,
        status: overrides.status ?? 'todo',
        priority: 0,
        tenant: overrides.tenant ?? 'collab-x',
        created_at: overrides.created_at ?? 1000,
        started_at: overrides.started_at ?? null,
        completed_at: overrides.completed_at ?? null,
        result: overrides.result ?? null,
        ...overrides,
    } as KanbanTask
}

/** In-memory stand-in for the sqlite-backed session table. */
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

interface Harness {
    orchestrator: CollabOrchestrator
    storage: ReturnType<typeof makeStorage>
    snapshots: CollabSessionSnapshot[]
    board: Board
    decompose: ReturnType<typeof vi.fn>
    created: Array<{ title: string; opts?: Record<string, unknown> }>
    /** Advance the poll loop deterministically instead of waiting on a timer. */
    poll(): Promise<void>
    /** Same, but through the re-entrancy guard the interval callback uses. */
    tickOnce(): Promise<void>
    /** Mutable clock, so elapsed-time behaviour is asserted without waiting. */
    now: number
}

interface Board {
    tasks: KanbanTask[]
    details: Map<string, KanbanTaskDetail>
    listCalls: number
    /** When set, a poll parks here until the test resolves it. */
    gate: Promise<void> | null
}

function makeHarness(options?: { decomposeOutcome?: KanbanDecomposeOutcome }): Harness {
    const storage = makeStorage()
    const snapshots: CollabSessionSnapshot[] = []
    const board: Board = {
        tasks: [],
        details: new Map<string, KanbanTaskDetail>(),
        listCalls: 0,
        gate: null,
    }
    const created: Array<{ title: string; opts?: Record<string, unknown> }> = []
    const clock = { value: 0 }

    const decompose = vi.fn(async (): Promise<KanbanDecomposeOutcome> =>
        options?.decomposeOutcome ?? {
            task_id: 'root',
            ok: true,
            reason: '',
            fanout: true,
            child_ids: [],
            new_title: null,
        })

    const orchestrator = new CollabOrchestrator({
        storage,
        kanban: {
            createTask: async (title, opts) => {
                created.push({ title, opts: opts as Record<string, unknown> })
                return task({ id: 'root', title, assignee: opts?.assignee ?? null, status: 'triage' })
            },
            decomposeTask: decompose,
            listTasks: async () => {
                board.listCalls += 1
                // Lets a test hold a poll open the way a slow CLI call does.
                if (board.gate) await board.gate
                return board.tasks
            },
            getTask: async (taskId) => board.details.get(taskId) ?? null,
            getTaskLog: async (taskId) => ({ taskId, content: `log:${taskId}`, truncated: false, exists: true } as never),
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
        postAnchorMessage: () => ({ id: 'anchor-1' }),
        emitToRoom: (_roomId, event, payload) => {
            if (event !== 'collab_session_updated') return
            snapshots.push((payload as { session: CollabSessionSnapshot }).session)
        },
        // Long enough that the interval never fires on its own during a test.
        pollIntervalMs: 60_000,
        now: () => clock.value,
    })

    return {
        orchestrator,
        storage,
        snapshots,
        board,
        decompose,
        created,
        get now() { return clock.value },
        set now(value: number) { clock.value = value },
        poll: async () => {
            // `watch()` fires one immediate tick, which is what we drive here.
            const [id] = [...storage.rows.keys()]
            await (orchestrator as unknown as { tick(sessionId: string): Promise<void> }).tick(id)
        },
        tickOnce: async () => {
            const [id] = [...storage.rows.keys()]
            await (orchestrator as unknown as { tickOnce(sessionId: string): Promise<void> }).tickOnce(id)
        },
    }
}

/** Let the fire-and-forget pipeline (create → decompose → dispatch) settle. */
async function flush(): Promise<void> {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
}

describe('splitGoalIntoTitleAndBody', () => {
    it('keeps a short goal entirely in the title', () => {
        const { title, body } = splitGoalIntoTitleAndBody('  组织团队评审白皮书  ')
        expect(title).toBe('组织团队评审白皮书')
        expect(body).toBe('')
    })

    it('moves an over-long goal into the body and keeps a readable title', () => {
        const goal = `${'评审架构文档，'.repeat(40)}结束`
        const { title, body } = splitGoalIntoTitleAndBody(goal)
        expect(title.length).toBeLessThanOrEqual(180)
        expect(title.length).toBeGreaterThan(0)
        // The full goal must survive somewhere, or the workers lose the ask.
        expect(body).toContain('结束')
    })
})

describe('buildRootTaskBody', () => {
    it('keeps the goal and names the workspace the children inherit', () => {
        const body = buildRootTaskBody('评审白皮书', '/opt/data/review-docs')
        expect(body).toContain('评审白皮书')
        expect(body).toContain('/opt/data/review-docs')
    })

    it('omits the workspace declaration when the room has none', () => {
        expect(buildRootTaskBody('评审白皮书', '')).not.toContain('子任务继承该目录')
    })

    it('bans a dispatch child, which would fan the work out twice', () => {
        // A "分派任务" child is itself a worker run, and that worker calls
        // kanban_create — every specialist then holds two duplicate tasks.
        const body = buildRootTaskBody('评审白皮书', '/docs')
        expect(body).toContain('分派')
        expect(body).toMatch(/不要创建/)
    })

    it('tells children to report gaps rather than block on missing material', () => {
        const body = buildRootTaskBody('评审白皮书', '/docs')
        expect(body).toContain('不要因为缺少材料而阻塞任务')
        // A fresh worker sees only its own body, so the path has to be restated.
        expect(body).toContain('绝对路径')
    })
})

describe('latestBlockReason', () => {
    const detail = (events: Array<{ kind: string; payload: Record<string, unknown> | null }>): KanbanTaskDetail => ({
        task: task({ id: 'c1', status: 'blocked' }),
        comments: [],
        events: events.map((event, index) => ({
            id: index,
            task_id: 'c1',
            kind: event.kind,
            payload: event.payload,
            created_at: 1000 + index,
            run_id: null,
        })),
        runs: [],
    })

    it('reads the newest blocked event, ignoring other kinds', () => {
        expect(latestBlockReason(detail([
            { kind: 'blocked', payload: { reason: '第一次缺文档' } },
            { kind: 'heartbeat', payload: null },
            { kind: 'blocked', payload: { reason: '仍然缺文档' } },
            { kind: 'commented', payload: { author: 'ronan' } },
        ]))).toBe('仍然缺文档')
    })

    it('returns empty when there is nothing usable', () => {
        expect(latestBlockReason(null)).toBe('')
        expect(latestBlockReason(detail([{ kind: 'claimed', payload: {} }]))).toBe('')
        expect(latestBlockReason(detail([{ kind: 'blocked', payload: { reason: '   ' } }]))).toBe('')
    })
})

describe('settleOutcome', () => {
    const snap = (tasks: Array<Partial<CollabTaskSnapshot> & { id: string }>): CollabSessionSnapshot => ({
        id: 's1', roomId: 'r1', anchorMessageId: 'a1', rootTaskId: 'root',
        tenant: 'collab-s1', board: 'default', coordinator: 'shyam', goal: '任务',
        workspace: '', status: 'running', error: '', createdAt: 0, updatedAt: 0,
        counts: {}, totalChildren: 0, doneChildren: 0,
        tasks: tasks.map(task => ({
            id: task.id,
            title: task.id,
            assignee: task.assignee ?? '',
            status: task.status ?? 'todo',
            isRoot: task.isRoot ?? false,
            summary: '',
            blockedReason: task.blockedReason ?? '',
            createdAt: 0,
            startedAt: null,
            completedAt: null,
        })),
    })

    it('holds while any child is still working', () => {
        expect(settleOutcome(snap([
            { id: 'root', isRoot: true, status: 'todo' },
            { id: 'c1', status: 'done' },
            { id: 'c2', status: 'running' },
        ]))).toBeNull()
    })

    it('fails a run whose root can never wake because a child blocked', () => {
        // Kanban only promotes the root once every child completes, so a run
        // with a blocked child sits in `todo` forever. Waiting on the root here
        // is what kept old runs polling the CLI for hours.
        const outcome = settleOutcome(snap([
            { id: 'root', isRoot: true, status: 'todo' },
            { id: 'c1', status: 'done' },
            { id: 'c2', status: 'blocked', blockedReason: '工作目录里没有实体解析文档' },
        ]))
        expect(outcome?.status).toBe('failed')
        expect(outcome?.error).toContain('工作目录里没有实体解析文档')
    })

    it('waits for the root to write its summary once every child succeeded', () => {
        expect(settleOutcome(snap([
            { id: 'root', isRoot: true, status: 'running' },
            { id: 'c1', status: 'done' },
        ]))).toBeNull()

        expect(settleOutcome(snap([
            { id: 'root', isRoot: true, status: 'done' },
            { id: 'c1', status: 'done' },
        ]))).toEqual({ status: 'done', error: '' })
    })

    it('treats an un-fanned-out goal as a single task', () => {
        expect(settleOutcome(snap([{ id: 'root', isRoot: true, status: 'running' }]))).toBeNull()
        expect(settleOutcome(snap([{ id: 'root', isRoot: true, status: 'done' }])))
            .toEqual({ status: 'done', error: '' })
        expect(settleOutcome(snap([{ id: 'root', isRoot: true, status: 'blocked' }]))?.status)
            .toBe('failed')
    })

    it('holds on an empty board, where decompose may still be running', () => {
        expect(settleOutcome(snap([]))).toBeNull()
    })

    it('calls a deadlock where a todo child waits on a blocked sibling', () => {
        // The dispatcher will never claim c2: its dependency is blocked. Only a
        // human can move this on, so the run must stop rather than poll for 6h.
        const board = snap([
            { id: 'root', isRoot: true, status: 'todo' },
            { id: 'c1', status: 'blocked' },
            { id: 'c2', status: 'todo' },
        ])
        // Just observed — could simply be between two dispatcher ticks.
        expect(settleOutcome(board, 0)).toBeNull()
        expect(settleOutcome(board, 30_000)).toBeNull()
        expect(settleOutcome(board, 5 * 60_000)?.status).toBe('failed')
    })

    it('never calls a deadlock while a worker is still running', () => {
        const board = snap([
            { id: 'root', isRoot: true, status: 'todo' },
            { id: 'c1', status: 'blocked' },
            { id: 'c2', status: 'running' },
        ])
        expect(settleOutcome(board, 60 * 60_000)).toBeNull()
    })

    it('never calls a deadlock on a board with no blocked task', () => {
        const board = snap([
            { id: 'root', isRoot: true, status: 'todo' },
            { id: 'c1', status: 'todo' },
        ])
        expect(settleOutcome(board, 60 * 60_000)).toBeNull()
    })
})

describe('CollabOrchestrator', () => {
    let harness: Harness

    beforeEach(() => {
        harness = makeHarness()
    })

    it('refuses to start without both a goal and a coordinator', () => {
        expect(harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '', coordinator: 'shyam' })).toBeNull()
        expect(harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: 'x', coordinator: '  ' })).toBeNull()
        expect(harness.storage.rows.size).toBe(0)
    })

    it('creates a tenant-scoped triage root that carries the room workspace', async () => {
        harness.orchestrator.start({
            roomId: 'r1',
            triggerMessageId: 'm1',
            goal: '组织团队评审白皮书',
            coordinator: 'shyam',
            workspace: '/opt/data/review-docs',
        })
        await flush()

        expect(harness.created).toHaveLength(1)
        const opts = harness.created[0].opts!
        expect(opts.assignee).toBe('shyam')
        expect(opts.triage).toBe(true)
        // Children inherit both, which is what scopes polling and lets every
        // specialist read the documents under review.
        expect(String(opts.tenant)).toMatch(/^collab-/)
        expect(opts.workspace).toBe('dir:/opt/data/review-docs')
    })

    it('omits the workspace flag when the room has none', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()
        expect(harness.created[0].opts).not.toHaveProperty('workspace')
    })

    it('reaches running once the fan-out is requested', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()
        const [row] = [...harness.storage.rows.values()]
        expect(row.status).toBe('running')
        expect(row.rootTaskId).toBe('root')
    })

    it('stays alive when the dispatcher decomposed the root first', async () => {
        // The gateway dispatcher auto-decomposes triage tasks on its own tick and
        // regularly wins this race, refusing our call. The fan-out still
        // happened, so the run must not be failed.
        harness = makeHarness({
            decomposeOutcome: {
                task_id: 'root',
                ok: false,
                reason: 'task moved out of triage before decomposition',
                fanout: false,
                child_ids: null,
                new_title: null,
            },
        })
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        const [row] = [...harness.storage.rows.values()]
        expect(row.status).toBe('running')
        expect(row.error).toBe('')
    })

    it('fails the run when the root task cannot be created', async () => {
        const storage = makeStorage()
        const orchestrator = new CollabOrchestrator({
            storage,
            kanban: {
                createTask: async () => { throw new Error('board offline') },
                decomposeTask: async () => ({ task_id: '', ok: false, reason: '', fanout: false, child_ids: null, new_title: null }),
                listTasks: async () => [],
                getTask: async () => null,
                getTaskLog: async () => ({ taskId: '', content: '', truncated: false, exists: false } as never),
                dispatch: async () => ({}),
            },
            postAnchorMessage: () => ({ id: 'anchor-1' }),
            emitToRoom: () => {},
        })
        orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        const [row] = [...storage.rows.values()]
        expect(row.status).toBe('failed')
        expect(row.error).toContain('board offline')
        orchestrator.shutdown()
    })

    it('groups the fan-out and counts only children towards progress', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        harness.board.tasks = [
            task({ id: 'root', status: 'todo', assignee: 'shyam', created_at: 1000 }),
            task({ id: 'c1', status: 'done', assignee: 'akshay', created_at: 1001 }),
            task({ id: 'c2', status: 'running', assignee: 'arjun', created_at: 1002 }),
            task({ id: 'c3', status: 'running', assignee: 'david', created_at: 1003 }),
        ]
        await harness.poll()

        const latest = harness.snapshots.at(-1)!
        expect(latest.tasks[0].isRoot).toBe(true)
        expect(latest.totalChildren).toBe(3)
        expect(latest.doneChildren).toBe(1)
        expect(latest.counts).toMatchObject({ running: 2, done: 1, todo: 1 })
        // Still in flight, so the run must not have settled.
        expect(latest.status).toBe('running')
    })

    it('reads a finished task output from latest_summary, not tasks.result', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        // Workers leave `result` NULL and hand output off through the run
        // summary, so a snapshot built from `list` alone would show nothing.
        harness.board.tasks = [
            task({ id: 'root', status: 'todo', assignee: 'shyam', created_at: 1000 }),
            task({ id: 'c1', status: 'done', assignee: 'akshay', created_at: 1001, result: null }),
        ]
        harness.board.details.set('c1', {
            task: task({ id: 'c1', status: 'done' }),
            comments: [],
            events: [],
            runs: [],
            latest_summary: '本体架构评审完成：17 项改进建议',
        })
        await harness.poll()

        const child = harness.snapshots.at(-1)!.tasks.find(t => t.id === 'c1')!
        expect(child.summary).toBe('本体架构评审完成：17 项改进建议')
    })

    it('fetches each summary once even across repeated polls', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        harness.board.tasks = [
            task({ id: 'root', status: 'todo', created_at: 1000 }),
            task({ id: 'c1', status: 'done', created_at: 1001 }),
        ]
        harness.board.details.set('c1', {
            task: task({ id: 'c1', status: 'done' }),
            comments: [], events: [], runs: [],
            latest_summary: '完成',
        })
        const getTask = vi.spyOn(harness.board.details, 'get')

        await harness.poll()
        await harness.poll()
        await harness.poll()

        // One hydration for c1; the root stays non-terminal so it is never fetched.
        expect(getTask).toHaveBeenCalledTimes(1)
    })

    it('stops re-fetching a task whose detail came back empty', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        // A worker that recorded no summary used to be re-fetched on every
        // tick — one more Python process per poll for the life of the run.
        harness.board.tasks = [
            task({ id: 'root', status: 'todo', created_at: 1000 }),
            task({ id: 'c1', status: 'done', created_at: 1001, result: null }),
        ]
        harness.board.details.set('c1', {
            task: task({ id: 'c1', status: 'done' }),
            comments: [], events: [], runs: [],
            latest_summary: null,
        })
        const getTask = vi.spyOn(harness.board.details, 'get')

        await harness.poll()
        await harness.poll()
        await harness.poll()

        expect(getTask).toHaveBeenCalledTimes(1)
    })

    it('re-reads the output of a task that finishes after being unblocked', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        // A sibling still running keeps the run open: with only one blocked
        // child, settleOutcome would close the session on the first poll.
        const root = task({ id: 'root', status: 'todo', created_at: 1000 })
        const sibling = task({ id: 'c2', status: 'running', created_at: 1002 })
        harness.board.tasks = [root, task({ id: 'c1', status: 'blocked', created_at: 1001 }), sibling]
        harness.board.details.set('c1', {
            task: task({ id: 'c1', status: 'blocked' }),
            comments: [],
            events: [{ id: 1, task_id: 'c1', kind: 'blocked', payload: { reason: '缺少输入' }, created_at: 1002, run_id: null }],
            runs: [],
        })
        await harness.poll()

        harness.board.tasks = [root, task({ id: 'c1', status: 'done', created_at: 1001, result: null }), sibling]
        harness.board.details.set('c1', {
            task: task({ id: 'c1', status: 'done' }),
            comments: [], events: [], runs: [],
            latest_summary: '补齐材料后评审完成',
        })
        await harness.poll()

        const child = harness.snapshots.at(-1)!.tasks.find(t => t.id === 'c1')!
        expect(child.summary).toBe('补齐材料后评审完成')
        expect(child.blockedReason).toBe('')
    })

    it('drops a poll that arrives while the previous one is still shelling out', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        let release: () => void = () => {}
        harness.board.gate = new Promise<void>(resolve => { release = resolve })
        harness.board.listCalls = 0

        const ticks = [harness.tickOnce(), harness.tickOnce(), harness.tickOnce()]
        release()
        await Promise.all(ticks)

        // Two of the three ticks must have been dropped rather than queued.
        expect(harness.board.listCalls).toBe(1)
    })

    it('restarts the stall clock whenever the board changes', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        const deadlocked = [
            task({ id: 'root', status: 'todo', created_at: 1000 }),
            task({ id: 'c1', status: 'blocked', created_at: 1001 }),
            task({ id: 'c2', status: 'todo', created_at: 1002 }),
        ]
        harness.board.tasks = deadlocked
        harness.now = 0
        await harness.poll()
        expect([...harness.storage.rows.values()][0].status).toBe('running')

        // A worker picking c2 up means the board is alive — the clock resets.
        harness.now = 2 * 60_000
        harness.board.tasks = [deadlocked[0], deadlocked[1], task({ id: 'c2', status: 'running', created_at: 1002 })]
        await harness.poll()
        harness.board.tasks = deadlocked
        await harness.poll()
        expect([...harness.storage.rows.values()][0].status).toBe('running')

        harness.now = 10 * 60_000
        await harness.poll()
        const row = [...harness.storage.rows.values()][0]
        expect(row.status).toBe('failed')
        expect(row.error).toContain('依赖')
    })

    it('settles to done when every task is terminal', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        harness.board.tasks = [
            task({ id: 'root', status: 'done', assignee: 'shyam', created_at: 1000 }),
            task({ id: 'c1', status: 'done', assignee: 'akshay', created_at: 1001 }),
            task({ id: 'c2', status: 'archived', assignee: 'arjun', created_at: 1002 }),
        ]
        await harness.poll()

        const [row] = [...harness.storage.rows.values()]
        expect(row.status).toBe('done')
        expect(row.error).toBe('')
    })

    it('puts the block reason on the card so the board explains itself', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        harness.board.tasks = [
            task({ id: 'root', status: 'todo', created_at: 1000 }),
            task({ id: 'c1', status: 'blocked', assignee: 'ronan', created_at: 1001 }),
        ]
        harness.board.details.set('c1', {
            task: task({ id: 'c1', status: 'blocked' }),
            comments: [],
            events: [{
                id: 1, task_id: 'c1', kind: 'blocked',
                payload: { reason: '工作目录中未找到实体解析设计文件', kind: 'needs_input' },
                created_at: 1002, run_id: null,
            }],
            runs: [],
        })
        await harness.poll()

        const child = harness.snapshots.at(-1)!.tasks.find(t => t.id === 'c1')!
        expect(child.blockedReason).toBe('工作目录中未找到实体解析设计文件')
    })

    it('re-reads the reason after a task is unblocked and blocks again', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        const blockedDetail = (reason: string): KanbanTaskDetail => ({
            task: task({ id: 'c1', status: 'blocked' }),
            comments: [],
            events: [{ id: 1, task_id: 'c1', kind: 'blocked', payload: { reason }, created_at: 1002, run_id: null }],
            runs: [],
        })

        // Keep a sibling running so the run is not settled by the first block.
        const root = task({ id: 'root', status: 'todo', created_at: 1000 })
        const sibling = task({ id: 'c2', status: 'running', created_at: 1002 })
        harness.board.tasks = [root, task({ id: 'c1', status: 'blocked', created_at: 1001 }), sibling]
        harness.board.details.set('c1', blockedDetail('缺少输入'))
        await harness.poll()

        // Unblocked by a human: the stale reason must not linger on the card.
        harness.board.tasks = [root, task({ id: 'c1', status: 'running', created_at: 1001 }), sibling]
        await harness.poll()
        expect(harness.snapshots.at(-1)!.tasks.find(t => t.id === 'c1')!.blockedReason).toBe('')

        harness.board.tasks = [root, task({ id: 'c1', status: 'blocked', created_at: 1001 }), sibling]
        harness.board.details.set('c1', blockedDetail('依赖的接口文档仍未提供'))
        await harness.poll()
        expect(harness.snapshots.at(-1)!.tasks.find(t => t.id === 'c1')!.blockedReason)
            .toBe('依赖的接口文档仍未提供')
    })

    it('reports a blocked task as a failed run needing a human', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        harness.board.tasks = [
            task({ id: 'root', status: 'done', created_at: 1000 }),
            task({ id: 'c1', status: 'blocked', created_at: 1001 }),
        ]
        await harness.poll()

        const [row] = [...harness.storage.rows.values()]
        expect(row.status).toBe('failed')
        expect(row.error).toContain('阻塞')
    })

    it('does not settle a run whose board is still empty', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        harness.board.tasks = []
        await harness.poll()

        expect([...harness.storage.rows.values()][0].status).toBe('running')
    })

    it('survives a poll failure and keeps the run open', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        const failing = makeHarness()
        failing.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()
        Object.defineProperty(failing.board, 'tasks', {
            get() { throw new Error('cli exploded') },
        })
        await expect(failing.poll()).resolves.toBeUndefined()
        expect([...failing.storage.rows.values()][0].status).toBe('running')
    })

    it('scopes task logs to the run so foreign tasks are unreachable', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()
        const [row] = [...harness.storage.rows.values()]

        harness.board.tasks = [task({ id: 'c1', status: 'running' })]
        expect(await harness.orchestrator.taskLog(row.id, 'c1')).toMatchObject({ taskId: 'c1', content: 'log:c1' })
        // A task id that is not part of this run must not resolve.
        expect(await harness.orchestrator.taskLog(row.id, 't_other')).toBeNull()
    })

    it('re-attaches watchers to runs left in flight by a restart', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()
        const [row] = [...harness.storage.rows.values()]

        // A fresh orchestrator over the same storage stands in for a restart.
        const revived = makeHarness()
        revived.storage.rows.set(row.id, { ...row })
        revived.orchestrator.resumeUnfinished()
        await flush()

        expect(revived.snapshots.length).toBeGreaterThan(0)
        revived.orchestrator.shutdown()
    })

    it('stops a run by reclaiming workers and blocking unfinished tasks', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()

        harness.board.tasks = [
            task({ id: 'root', status: 'todo', created_at: 1000 }),
            task({ id: 'c1', status: 'running', assignee: 'ronan', created_at: 1001 }),
            task({ id: 'c2', status: 'todo', assignee: 'vikram', created_at: 1002 }),
            task({ id: 'c3', status: 'done', assignee: 'akshay', created_at: 1003 }),
        ]

        const [row] = [...harness.storage.rows.values()]
        const snapshot = await harness.orchestrator.stop(row.id)

        expect(snapshot?.status).toBe('failed')
        expect(snapshot?.error).toBe('用户已停止')
        expect([...harness.storage.rows.values()][0].status).toBe('failed')
        // Finished work is left alone; everything else is parked.
        expect(harness.board.tasks.find(t => t.id === 'c3')!.status).toBe('done')
        expect(harness.board.tasks.find(t => t.id === 'c1')!.status).toBe('blocked')
        expect(harness.board.tasks.find(t => t.id === 'c2')!.status).toBe('blocked')
        expect(harness.board.tasks.find(t => t.id === 'root')!.status).toBe('blocked')
    })

    it('is a no-op when the run has already settled', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务', coordinator: 'shyam' })
        await flush()
        const [row] = [...harness.storage.rows.values()]
        harness.storage.updateCollabSession(row.id, { status: 'done' })
        row.status = 'done'

        harness.board.tasks = [task({ id: 'root', status: 'done', created_at: 1000 })]
        const snapshot = await harness.orchestrator.stop(row.id)
        expect(snapshot?.status).toBe('done')
        expect(harness.board.tasks[0].status).toBe('done')
    })

    it('stopRoom aborts every unfinished run in the room', async () => {
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm1', goal: '任务一', coordinator: 'shyam' })
        await flush()
        harness.orchestrator.start({ roomId: 'r1', triggerMessageId: 'm2', goal: '任务二', coordinator: 'shyam' })
        await flush()
        harness.orchestrator.start({ roomId: 'r2', triggerMessageId: 'm3', goal: '别的房间', coordinator: 'shyam' })
        await flush()

        const stopped = await harness.orchestrator.stopRoom('r1')
        expect(stopped).toHaveLength(2)
        expect(stopped.every(session => session.status === 'failed')).toBe(true)
        expect([...harness.storage.rows.values()].filter(row => row.roomId === 'r2')[0].status).toBe('running')
    })
})
