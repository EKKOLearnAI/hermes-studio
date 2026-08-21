/**
 * 群协作 (group collaboration) orchestration.
 *
 * A collab room looks and behaves exactly like a group chat, but an @mention
 * does not run an agent turn. Instead it opens a Kanban run:
 *
 *   user @mentions a coordinator
 *     → root task created in the `triage` column, assigned to the coordinator
 *       → `kanban decompose` asks the coordinator to split the goal into child
 *         tasks routed to specialist profiles by their descriptions
 *         → the gateway dispatcher claims every unblocked child and spawns one
 *           `hermes -p <profile>` worker per task, so siblings run in PARALLEL
 *           → children write results back; the root promotes when they finish
 *             and the coordinator wakes up to summarise
 *
 * Two properties of hermes-agent's `decompose_triage_task` are load-bearing
 * here and shape the whole design:
 *
 *  - children inherit the root's `tenant`, so one tenant-scoped `kanban list`
 *    returns the entire run. Polling is O(1) CLI calls per tick rather than
 *    O(tasks).
 *  - children inherit the root's workspace, so pointing the root at a
 *    document directory makes that directory readable by every worker.
 */

import { randomBytes } from 'crypto'
import { logger } from '../../logger'
import type {
  KanbanDecomposeOutcome,
  KanbanTask,
  KanbanTaskDetail,
  KanbanTaskLog,
  KanbanTaskStatus,
} from '../hermes-kanban'

export type CollabSessionStatus = 'creating' | 'decomposing' | 'running' | 'done' | 'failed'

/** Kanban statuses that will never change again without human action. */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(['done', 'archived'])

/** Statuses that mean "this task needs a human before it can progress". */
const STALLED_TASK_STATUSES: ReadonlySet<string> = new Set(['blocked'])

/** Statuses that prove a worker is still moving the board on its own. */
const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set(['ready', 'running'])

/**
 * How long a board must look unable to progress before the run is called.
 * Comfortably longer than the dispatcher's 60s tick, so a poll that lands
 * between two ticks never mistakes the gap for a deadlock.
 */
const STALL_GRACE_MS = 3 * 60 * 1000

export const COLLAB_ANCHOR_TOOL_NAME = 'collab_session'

export interface CollabSessionRow {
  id: string
  roomId: string
  triggerMessageId: string
  anchorMessageId: string
  rootTaskId: string
  tenant: string
  board: string
  coordinator: string
  goal: string
  workspace: string
  status: CollabSessionStatus
  error: string
  createdAt: number
  updatedAt: number
}

export interface CollabTaskSnapshot {
  id: string
  title: string
  assignee: string
  status: KanbanTaskStatus | string
  isRoot: boolean
  summary: string
  /** Why a `blocked` task stopped; empty for every other status. */
  blockedReason: string
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface CollabSessionSnapshot {
  id: string
  roomId: string
  anchorMessageId: string
  rootTaskId: string
  tenant: string
  board: string
  coordinator: string
  goal: string
  /**
   * Directory every worker is cwd'd into. Surfaced because a run pointed at the
   * wrong workspace does not fail loudly — specialists that cannot find the
   * documents will invent their own instead of stopping.
   */
  workspace: string
  status: CollabSessionStatus
  error: string
  createdAt: number
  updatedAt: number
  tasks: CollabTaskSnapshot[]
  counts: Record<string, number>
  /** Children only — the root is the coordinator's own summarising task. */
  totalChildren: number
  doneChildren: number
}

export interface CollabSessionStorage {
  createCollabSession(row: CollabSessionRow): void
  updateCollabSession(id: string, patch: Partial<CollabSessionRow>): void
  getCollabSession(id: string): CollabSessionRow | null
  getCollabSessionByAnchor(anchorMessageId: string): CollabSessionRow | null
  listCollabSessionsByRoom(roomId: string): CollabSessionRow[]
  listUnfinishedCollabSessions(): CollabSessionRow[]
}

/**
 * The slice of the kanban CLI wrapper the orchestrator needs. Injected so the
 * orchestration state machine can be tested without a hermes install.
 */
export interface CollabKanbanGateway {
  createTask(
    title: string,
    opts?: {
      board?: string
      body?: string
      assignee?: string
      tenant?: string
      workspace?: string
      triage?: boolean
      maxRuntime?: string
    },
  ): Promise<KanbanTask>
  decomposeTask(
    taskId: string,
    opts?: { board?: string; author?: string; timeoutMs?: number },
  ): Promise<KanbanDecomposeOutcome>
  listTasks(opts?: {
    board?: string
    tenant?: string
    includeArchived?: boolean
  }): Promise<KanbanTask[]>
  getTask(taskId: string, opts?: { board?: string }): Promise<KanbanTaskDetail | null>
  getTaskLog(taskId: string, opts?: { board?: string; tail?: number }): Promise<KanbanTaskLog>
  dispatch(opts?: { board?: string }): Promise<unknown>
  /** Kill a running worker and put the task back to `ready`. */
  reclaimTask(taskId: string, opts?: { board?: string; reason?: string }): Promise<unknown>
  /** Park a task so the dispatcher will not claim it again. */
  blockTask(taskId: string, reason: string, opts?: { board?: string }): Promise<void>
}

export interface CollabOrchestratorDeps {
  storage: CollabSessionStorage
  kanban: CollabKanbanGateway
  /** Persist + broadcast the anchor message that renders the task board. */
  postAnchorMessage(input: {
    roomId: string
    sessionId: string
    coordinator: string
    goal: string
  }): { id: string } | null
  /** Broadcast an event to everyone in the room. */
  emitToRoom(roomId: string, event: string, payload: unknown): void
  now?(): number
  /** Poll cadence while a run is in flight. */
  pollIntervalMs?: number
  /** Hard stop so a stalled board cannot leak a timer forever. */
  maxRunMs?: number
}

export interface StartCollabRunInput {
  roomId: string
  triggerMessageId: string
  goal: string
  coordinator: string
  workspace?: string
  board?: string
}

const DEFAULT_POLL_INTERVAL_MS = 3000
const DEFAULT_MAX_RUN_MS = 6 * 60 * 60 * 1000
const MAX_GOAL_TITLE_LENGTH = 180
const COLLAB_TENANT_PREFIX = 'collab-'

/** Kanban titles are capped; keep the readable head and move the rest to body. */
export function splitGoalIntoTitleAndBody(goal: string): { title: string; body: string } {
  const normalized = goal.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_GOAL_TITLE_LENGTH) {
    return { title: normalized, body: '' }
  }
  // Prefer breaking on a sentence/clause boundary so the title reads naturally.
  const window = normalized.slice(0, MAX_GOAL_TITLE_LENGTH)
  const boundary = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('，'),
    window.lastIndexOf('. '),
    window.lastIndexOf(', '),
    window.lastIndexOf(' '),
  )
  const cut = boundary > MAX_GOAL_TITLE_LENGTH * 0.5 ? boundary : MAX_GOAL_TITLE_LENGTH
  return { title: normalized.slice(0, cut).trim(), body: normalized.trim() }
}

export function isCollabTenant(tenant: string | null | undefined): boolean {
  return typeof tenant === 'string' && tenant.startsWith(COLLAB_TENANT_PREFIX)
}

/**
 * Build the root task body.
 *
 * The body is the only channel we have into `kanban decompose` — its system
 * prompt is fixed in hermes-agent and only sees the root's title + body. Two
 * failure modes observed on real runs are addressed here:
 *
 *  - the decomposer emitted a "dispatch the work to each architect" child and
 *    routed it back to the coordinator. That child is a real worker run, so it
 *    fanned the work out a SECOND time via `kanban_create` — every specialist
 *    ended up holding two near-duplicate tasks.
 *  - child bodies were written without the source path, so a worker searched
 *    its workspace for material named after its own slice, found nothing, and
 *    blocked on `needs_input` while its siblings completed off the same file.
 */
export function buildRootTaskBody(goal: string, workspace?: string): string {
  const lines = [goal.trim()]
  if (workspace && workspace.trim()) {
    lines.push('', `工作目录：${workspace.trim()}（子任务继承该目录，所有输入材料都在这里）`)
  }
  lines.push(
    '',
    '拆解要求：',
    '- 每个子任务都必须是可直接交付的实质工作。不要创建"分派/派活/协调/跟进/汇总"这类子任务：分派由看板调度器完成，最终汇总由本根任务的负责人在子任务全部结束后完成。',
    '- 不同专业领域的子任务之间不要设置 parents，保持并行执行。',
    '- 每个子任务的 body 必须自带完整上下文：要处理的文件绝对路径、工作目录、交付标准。执行者读不到本任务和其他子任务的内容。',
    '- 全部输入材料仅限工作目录中已有的文件，不存在额外的源码仓库或补充文档。若你负责的方面在材料中信息不足，就基于现有内容给出结论并明确标注缺口，不要因为缺少材料而阻塞任务。',
  )
  return lines.join('\n')
}

export class CollabOrchestrator {
  private readonly storage: CollabSessionStorage
  private readonly kanban: CollabKanbanGateway
  private readonly deps: CollabOrchestratorDeps
  private readonly pollIntervalMs: number
  private readonly maxRunMs: number
  /** sessionId → timer, so a room never accumulates duplicate watchers. */
  private readonly watchers = new Map<string, NodeJS.Timeout>()
  /** sessionId → digest of the last broadcast snapshot (change detection). */
  private readonly lastDigest = new Map<string, string>()
  /**
   * sessionId → taskId → finished worker's output.
   *
   * `kanban list` reports `tasks.result`, which workers leave NULL — they hand
   * their output off through `task_runs.summary`, exposed only as
   * `latest_summary` on `kanban show`. Rather than pay an O(tasks) `show` per
   * poll, each task is fetched once when it reaches a terminal status and then
   * cached, so a steady-state tick costs one `list` call.
   */
  private readonly summaries = new Map<string, Map<string, string>>()
  /**
   * sessionId → taskId → why the worker gave up.
   *
   * A blocked task is the one state a run cannot leave on its own, so the
   * reason is the single most useful thing to put on the card — without it the
   * operator has to go read the board from a shell. It lives in the newest
   * `blocked` event's payload, so it costs the same `show` call as a summary.
   * Entries are dropped when a task leaves `blocked`, so a later block episode
   * re-fetches instead of showing a stale reason.
   */
  private readonly blockReasons = new Map<string, Map<string, string>>()
  /** sessionIds whose poll is still shelling out; see `tickOnce`. */
  private readonly inFlight = new Set<string>()
  /** sessionId → when the board last changed shape; see `stalledForMs`. */
  private readonly progressMarks = new Map<string, { digest: string; since: number }>()
  private stopped = false

  constructor(deps: CollabOrchestratorDeps) {
    this.deps = deps
    this.storage = deps.storage
    this.kanban = deps.kanban
    this.pollIntervalMs = Math.max(500, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this.maxRunMs = Math.max(60000, deps.maxRunMs ?? DEFAULT_MAX_RUN_MS)
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /**
   * Open a collaboration run. Returns as soon as the anchor message exists so
   * the socket handler is never blocked on the decomposer LLM; the rest of the
   * pipeline advances in the background and streams snapshots to the room.
   */
  start(input: StartCollabRunInput): CollabSessionSnapshot | null {
    const goal = String(input.goal || '').trim()
    const coordinator = String(input.coordinator || '').trim()
    if (!goal || !coordinator) return null

    const sessionId = randomBytes(8).toString('hex')
    const anchor = this.deps.postAnchorMessage({
      roomId: input.roomId,
      sessionId,
      coordinator,
      goal,
    })
    if (!anchor?.id) {
      logger.error('[Collab] failed to post anchor message; aborting run')
      return null
    }

    const now = this.now()
    const row: CollabSessionRow = {
      id: sessionId,
      roomId: input.roomId,
      triggerMessageId: input.triggerMessageId || '',
      anchorMessageId: anchor.id,
      rootTaskId: '',
      tenant: `${COLLAB_TENANT_PREFIX}${sessionId}`,
      board: input.board || 'default',
      coordinator,
      goal,
      workspace: input.workspace || '',
      status: 'creating',
      error: '',
      createdAt: now,
      updatedAt: now,
    }
    this.storage.createCollabSession(row)
    this.broadcast(this.buildSnapshot(row, []))

    void this.runPipeline(row)
    return this.buildSnapshot(row, [])
  }

  /** Create the root task, fan it out, then hand over to the poll loop. */
  private async runPipeline(row: CollabSessionRow): Promise<void> {
    const { title } = splitGoalIntoTitleAndBody(row.goal)
    let rootTaskId = ''

    try {
      const created = await this.kanban.createTask(title, {
        board: row.board,
        body: buildRootTaskBody(row.goal, row.workspace),
        // The mentioned profile owns the goal. `decompose` may re-point the
        // root at `kanban.orchestrator_profile`, which is why the UI always
        // renders assignees read back from the board rather than this value.
        assignee: row.coordinator,
        tenant: row.tenant,
        // Children inherit this workspace, so every specialist worker can read
        // the documents the coordinator was pointed at.
        ...(row.workspace ? { workspace: `dir:${row.workspace}` } : {}),
        triage: true,
      })
      rootTaskId = String(created?.id || '')
      if (!rootTaskId) throw new Error('kanban create returned no task id')
      this.patch(row, { rootTaskId, status: 'decomposing' })
    } catch (err) {
      this.fail(row, `创建协作任务失败：${errorText(err)}`)
      return
    }

    try {
      const outcome = await this.kanban.decomposeTask(rootTaskId, {
        board: row.board,
        author: row.coordinator,
      })
      if (!outcome.ok) {
        // The gateway's dispatcher also auto-decomposes triage tasks on its own
        // tick, so it regularly wins this race and our call is refused with
        // "moved out of triage" — the fan-out happened, just not by us. Any
        // other refusal still leaves a usable single task on the board. Either
        // way the poll loop reports whatever the board actually holds, so the
        // run stays alive.
        logger.info(`[Collab] decompose not performed by us for ${rootTaskId}: ${outcome.reason}`)
      }
      this.patch(row, { status: 'running' })
    } catch (err) {
      this.fail(row, `任务拆解失败：${errorText(err)}`)
      return
    }

    // The dispatcher ticks on its own schedule (60s by default). Nudge it so
    // the board starts moving immediately instead of after a cold wait.
    try {
      await this.kanban.dispatch({ board: row.board })
    } catch (err) {
      logger.warn(`[Collab] dispatch nudge failed: ${errorText(err)}`)
    }

    this.watch(row.id)
  }

  /** Begin (or resume) polling a run's task tree. */
  watch(sessionId: string): void {
    if (this.stopped || this.watchers.has(sessionId)) return
    const timer = setInterval(() => {
      void this.tickOnce(sessionId)
    }, this.pollIntervalMs)
    // Never hold the event loop open on account of a background poll.
    if (typeof timer.unref === 'function') timer.unref()
    this.watchers.set(sessionId, timer)
    void this.tickOnce(sessionId)
  }

  /**
   * Run a tick unless the previous one is still working.
   *
   * Every poll shells out to `hermes kanban`, which is a cold Python process
   * (~60MB, and seconds of startup once a board has a few boards' worth of
   * history). Under load one `list` can outlast the poll interval several times
   * over, so an unguarded `setInterval` stacks ticks, each forking more
   * processes than the last — the container hits its memory cap and the whole
   * server becomes unreachable. Dropping the overlapping tick is always safe:
   * a poll carries no state, and the next one sees the same board.
   */
  private async tickOnce(sessionId: string): Promise<void> {
    if (this.inFlight.has(sessionId)) return
    this.inFlight.add(sessionId)
    try {
      await this.tick(sessionId)
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  private stopWatching(sessionId: string): void {
    const timer = this.watchers.get(sessionId)
    if (timer) clearInterval(timer)
    this.watchers.delete(sessionId)
    this.lastDigest.delete(sessionId)
    this.progressMarks.delete(sessionId)
  }

  /**
   * Pull the output of tasks that have just finished and the reason behind ones
   * that just blocked.
   *
   * A successful fetch is cached even when the field came back empty. Caching
   * only non-empty values looks harmless but means a task that never recorded a
   * summary (or blocked without a reason) is fetched again on every single tick
   * for as long as the run is open — one more Python process per poll, forever.
   * Only a failed CLI call is left uncached, so a transient error still retries.
   */
  private async hydrateTaskDetails(row: CollabSessionRow, tasks: KanbanTask[]): Promise<void> {
    const summaries = mapFor(this.summaries, row.id)
    const blocks = mapFor(this.blockReasons, row.id)

    // A task that leaves `blocked` may block again later for a different
    // reason, so drop the cached one rather than show a stale explanation.
    for (const task of tasks) {
      if (!STALLED_TASK_STATUSES.has(task.status)) blocks.delete(task.id)
    }

    const pending = tasks.filter(task =>
      (TERMINAL_TASK_STATUSES.has(task.status) && !summaries.has(task.id))
      || (STALLED_TASK_STATUSES.has(task.status) && !blocks.has(task.id)))
    if (pending.length === 0) return

    await Promise.all(pending.map(async (task) => {
      try {
        const detail = await this.kanban.getTask(task.id, { board: row.board })
        // Only a terminal task's output is final. Caching it for a blocked one
        // would keep the empty value after a human unblocks it and it finishes.
        if (TERMINAL_TASK_STATUSES.has(task.status)) {
          summaries.set(task.id, String(detail?.latest_summary || detail?.task?.result || ''))
        }
        if (STALLED_TASK_STATUSES.has(task.status)) {
          blocks.set(task.id, latestBlockReason(detail))
        }
      } catch (err) {
        logger.warn(`[Collab] detail fetch failed for ${task.id}: ${errorText(err)}`)
      }
    }))
  }

  /**
   * How long the board has looked the same. Any status change restarts the
   * clock, so the deadlock check only fires on a board that is genuinely inert
   * rather than one that is merely slow.
   */
  private stalledForMs(sessionId: string, snapshot: CollabSessionSnapshot): number {
    const digest = snapshot.tasks.map(task => `${task.id}:${task.status}`).join(',')
    const previous = this.progressMarks.get(sessionId)
    if (!previous || previous.digest !== digest) {
      this.progressMarks.set(sessionId, { digest, since: this.now() })
      return 0
    }
    return this.now() - previous.since
  }

  private async tick(sessionId: string): Promise<void> {
    const row = this.storage.getCollabSession(sessionId)
    if (!row) {
      this.stopWatching(sessionId)
      return
    }
    // A concurrent stop may have already closed this run; do not overwrite it.
    if (row.status === 'done' || row.status === 'failed') {
      this.stopWatching(sessionId)
      return
    }

    let tasks: KanbanTask[] = []
    try {
      tasks = await this.kanban.listTasks({
        board: row.board,
        tenant: row.tenant,
        includeArchived: true,
      })
    } catch (err) {
      logger.warn(`[Collab] poll failed for ${sessionId}: ${errorText(err)}`)
      return
    }

    await this.hydrateTaskDetails(row, tasks)

    const snapshot = this.buildSnapshot(row, tasks)
    const outcome = settleOutcome(snapshot, this.stalledForMs(sessionId, snapshot))

    if (outcome && row.status === 'running') {
      this.patch(row, outcome, tasks)
      this.stopWatching(sessionId)
      return
    }

    if (this.now() - row.createdAt > this.maxRunMs) {
      this.patch(row, { status: 'failed', error: '协作运行超时' }, tasks)
      this.stopWatching(sessionId)
      return
    }

    this.broadcast(snapshot)
  }

  private patch(
    row: CollabSessionRow,
    patch: Partial<CollabSessionRow>,
    tasks: KanbanTask[] = [],
  ): void {
    Object.assign(row, patch, { updatedAt: this.now() })
    this.storage.updateCollabSession(row.id, { ...patch, updatedAt: row.updatedAt })
    this.broadcast(this.buildSnapshot(row, tasks), true)
  }

  private fail(row: CollabSessionRow, message: string): void {
    logger.error(`[Collab] ${row.id} failed: ${message}`)
    this.patch(row, { status: 'failed', error: message })
    this.stopWatching(row.id)
  }

  private broadcast(snapshot: CollabSessionSnapshot, force = false): void {
    const digest = JSON.stringify(snapshot)
    if (!force && this.lastDigest.get(snapshot.id) === digest) return
    this.lastDigest.set(snapshot.id, digest)
    this.deps.emitToRoom(snapshot.roomId, 'collab_session_updated', {
      roomId: snapshot.roomId,
      session: snapshot,
    })
  }

  private buildSnapshot(row: CollabSessionRow, tasks: KanbanTask[]): CollabSessionSnapshot {
    const cache = this.summaries.get(row.id)
    const blocks = this.blockReasons.get(row.id)
    const mapped: CollabTaskSnapshot[] = tasks.map(task => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee || '',
      status: task.status,
      isRoot: task.id === row.rootTaskId,
      summary: cache?.get(task.id) || task.result || '',
      blockedReason: blocks?.get(task.id) || '',
      createdAt: task.created_at,
      startedAt: task.started_at,
      completedAt: task.completed_at,
    }))
    // Root first, then children oldest-first so the fan-out reads top to bottom.
    mapped.sort((a, b) => {
      if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1
      return a.createdAt - b.createdAt
    })

    const counts: Record<string, number> = {}
    for (const task of mapped) {
      counts[task.status] = (counts[task.status] || 0) + 1
    }
    const children = mapped.filter(task => !task.isRoot)

    return {
      id: row.id,
      roomId: row.roomId,
      anchorMessageId: row.anchorMessageId,
      rootTaskId: row.rootTaskId,
      tenant: row.tenant,
      board: row.board,
      coordinator: row.coordinator,
      goal: row.goal,
      workspace: row.workspace,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      tasks: mapped,
      counts,
      totalChildren: children.length,
      doneChildren: children.filter(task => TERMINAL_TASK_STATUSES.has(task.status)).length,
    }
  }

  /** Snapshot for a REST read (page load / reconnect). */
  async snapshot(sessionId: string): Promise<CollabSessionSnapshot | null> {
    const row = this.storage.getCollabSession(sessionId)
    if (!row) return null
    if (!row.rootTaskId) return this.buildSnapshot(row, [])
    try {
      const tasks = await this.kanban.listTasks({
        board: row.board,
        tenant: row.tenant,
        includeArchived: true,
      })
      // A page load may land on a finished run whose watcher is long gone, so
      // this path has to fill the summary cache itself.
      await this.hydrateTaskDetails(row, tasks)
      return this.buildSnapshot(row, tasks)
    } catch (err) {
      logger.warn(`[Collab] snapshot failed for ${sessionId}: ${errorText(err)}`)
      return this.buildSnapshot(row, [])
    }
  }

  snapshotByAnchor(anchorMessageId: string): Promise<CollabSessionSnapshot | null> {
    const row = this.storage.getCollabSessionByAnchor(anchorMessageId)
    if (!row) return Promise.resolve(null)
    return this.snapshot(row.id)
  }

  /**
   * Worker execution log for one task in a run. Scoped through the session so a
   * caller cannot read arbitrary board tasks through this endpoint.
   */
  async taskLog(
    sessionId: string,
    taskId: string,
    tail?: number,
  ): Promise<{ taskId: string; content: string; truncated: boolean; exists: boolean } | null> {
    const row = this.storage.getCollabSession(sessionId)
    if (!row) return null

    const tasks = await this.kanban.listTasks({
      board: row.board,
      tenant: row.tenant,
      includeArchived: true,
    })
    if (!tasks.some(task => task.id === taskId)) return null

    const log = await this.kanban.getTaskLog(taskId, { board: row.board, tail })
    return {
      taskId,
      content: String(log?.content || ''),
      truncated: Boolean(log?.truncated),
      exists: Boolean(log?.exists),
    }
  }

  /** Task detail (runs, comments, summary) for the drawer view. */
  async taskDetail(sessionId: string, taskId: string): Promise<KanbanTaskDetail | null> {
    const row = this.storage.getCollabSession(sessionId)
    if (!row) return null
    const tasks = await this.kanban.listTasks({
      board: row.board,
      tenant: row.tenant,
      includeArchived: true,
    })
    if (!tasks.some(task => task.id === taskId)) return null
    return this.kanban.getTask(taskId, { board: row.board })
  }

  listRoomSessions(roomId: string): CollabSessionRow[] {
    return this.storage.listCollabSessionsByRoom(roomId)
  }

  /**
   * Abort a collaboration run from the UI's stop button.
   *
   * The board keeps its own workers, so stopping the Studio poller alone would
   * leave specialists still writing. Reclaim kills any running worker; block
   * parks everything that has not finished so the dispatcher cannot pick them
   * up on the next tick.
   */
  async stop(sessionId: string, reason = '用户已停止'): Promise<CollabSessionSnapshot | null> {
    const row = this.storage.getCollabSession(sessionId)
    if (!row) return null
    if (row.status === 'done' || row.status === 'failed') {
      return this.snapshot(sessionId)
    }

    this.stopWatching(sessionId)

    let tasks: KanbanTask[] = []
    if (row.rootTaskId) {
      try {
        tasks = await this.kanban.listTasks({
          board: row.board,
          tenant: row.tenant,
          includeArchived: true,
        })
        await this.haltTasks(row, tasks, reason)
        tasks = await this.kanban.listTasks({
          board: row.board,
          tenant: row.tenant,
          includeArchived: true,
        })
      } catch (err) {
        logger.warn(`[Collab] halt during stop failed for ${sessionId}: ${errorText(err)}`)
      }
    }

    this.patch(row, { status: 'failed', error: reason }, tasks)
    return this.buildSnapshot(row, tasks)
  }

  /** Stop every unfinished run in a room (the composer stop button's target). */
  async stopRoom(roomId: string, reason = '用户已停止'): Promise<CollabSessionSnapshot[]> {
    const unfinished = this.storage.listCollabSessionsByRoom(roomId)
      .filter(row => row.status !== 'done' && row.status !== 'failed')
    const stopped: CollabSessionSnapshot[] = []
    for (const row of unfinished) {
      const snapshot = await this.stop(row.id, reason)
      if (snapshot) stopped.push(snapshot)
    }
    return stopped
  }

  /**
   * Tear down workers and park unfinished tasks. Failures on individual tasks
   * are tolerated so a stuck reclaim cannot leave the session marked running.
   */
  private async haltTasks(
    row: CollabSessionRow,
    tasks: KanbanTask[],
    reason: string,
  ): Promise<void> {
    const unfinished = tasks.filter(task =>
      !TERMINAL_TASK_STATUSES.has(task.status) && !STALLED_TASK_STATUSES.has(task.status))
    await Promise.all(unfinished.map(async (task) => {
      try {
        if (task.status === 'running') {
          await this.kanban.reclaimTask(task.id, { board: row.board, reason })
        }
        await this.kanban.blockTask(task.id, reason, { board: row.board })
      } catch (err) {
        logger.warn(`[Collab] failed to halt ${task.id}: ${errorText(err)}`)
      }
    }))
  }

  /**
   * Re-attach watchers to runs that were still in flight when the process
   * restarted — the Kanban board keeps running regardless of Studio's uptime,
   * so without this a restart would silently freeze the UI mid-run.
   */
  resumeUnfinished(): void {
    let resumed = 0
    for (const row of this.storage.listUnfinishedCollabSessions()) {
      if (!row.rootTaskId) continue
      this.watch(row.id)
      resumed += 1
    }
    if (resumed > 0) logger.info(`[Collab] resumed ${resumed} unfinished collaboration run(s)`)
  }

  shutdown(): void {
    this.stopped = true
    for (const timer of this.watchers.values()) clearInterval(timer)
    this.watchers.clear()
    this.lastDigest.clear()
    this.summaries.clear()
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Decide whether a run is over, and how. `null` means "still in flight".
 *
 * The rule has to be written in terms of the CHILDREN, not of every task. When
 * a child blocks, Kanban never promotes the root — it only wakes once all of
 * its children complete — so the root sits in `todo` forever. A rule that
 * waited for every task to reach a terminal state therefore never fired on the
 * one case that most needs reporting, and the run polled the CLI every few
 * seconds until the 6h cap, spawning a Python process each time.
 */
export function settleOutcome(
  snapshot: CollabSessionSnapshot,
  stalledForMs = 0,
): { status: CollabSessionStatus; error: string } | null {
  const isSettled = (status: string) =>
    TERMINAL_TASK_STATUSES.has(status) || STALLED_TASK_STATUSES.has(status)

  const root = snapshot.tasks.find(task => task.isRoot)
  const children = snapshot.tasks.filter(task => !task.isRoot)

  // Nothing on the board yet: decompose may still be running.
  if (snapshot.tasks.length === 0) return null

  // `fanout: false` — the goal stayed a single task, so the root IS the work.
  if (children.length === 0) {
    if (!root || !isSettled(root.status)) return null
    return STALLED_TASK_STATUSES.has(root.status)
      ? { status: 'failed', error: '任务被阻塞，需要人工介入' }
      : { status: 'done', error: '' }
  }

  if (!children.every(task => isSettled(task.status))) {
    // A child that depends on a blocked sibling is never claimed, so the board
    // holds unsettled tasks that no worker will ever pick up. Nothing running
    // plus something blocked means only a human can move this forward — but
    // only conclude that after the state has held long enough to rule out
    // simply having polled between two dispatcher ticks.
    const stuck = snapshot.tasks.some(task => STALLED_TASK_STATUSES.has(task.status))
      && !snapshot.tasks.some(task => ACTIVE_TASK_STATUSES.has(task.status))
    if (stuck && stalledForMs >= STALL_GRACE_MS) {
      return { status: 'failed', error: '有任务被阻塞，其余任务因依赖无法继续，需要人工介入' }
    }
    return null
  }

  const blocked = [...children, ...(root ? [root] : [])]
    .filter(task => STALLED_TASK_STATUSES.has(task.status))
  if (blocked.length > 0) {
    const detail = blocked.find(task => task.blockedReason)?.blockedReason || ''
    return {
      status: 'failed',
      error: detail
        ? `有 ${blocked.length} 个任务被阻塞，需要人工介入：${detail}`
        : `有 ${blocked.length} 个任务被阻塞，需要人工介入`,
    }
  }

  // Every child succeeded, so the root is free to wake and write the summary.
  // Give it that chance rather than declaring the run done without one.
  if (root && !TERMINAL_TASK_STATUSES.has(root.status)) return null
  return { status: 'done', error: '' }
}

/** Get (creating on demand) the per-session slot of a two-level cache. */
function mapFor(outer: Map<string, Map<string, string>>, key: string): Map<string, string> {
  let inner = outer.get(key)
  if (!inner) {
    inner = new Map<string, string>()
    outer.set(key, inner)
  }
  return inner
}

/**
 * The reason a task is blocked, from the newest `blocked` event. Kanban has no
 * column for it; a worker calling `kanban_block` records it as event payload.
 */
export function latestBlockReason(detail: KanbanTaskDetail | null | undefined): string {
  const events = detail?.events
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.kind !== 'blocked') continue
    const reason = event.payload?.reason
    if (typeof reason === 'string' && reason.trim()) return reason.trim()
  }
  return ''
}
