import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PRODUCTION_TABLES = [
  'workflows',
  'workflow_runs',
  'workflow_run_node_sessions',
  'workflow_run_edge_evaluations',
  'workflow_run_loop_epochs',
]

function productionWorkflowSnapshot(path: string): Record<string, { count: number; sha256: string } | { missing: true }> {
  if (!existsSync(path)) return Object.fromEntries(PRODUCTION_TABLES.map(table => [table, { missing: true }]))
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Object.fromEntries(PRODUCTION_TABLES.map(table => {
      try {
        const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
        return [table, {
          count: rows.length,
          sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        }]
      } catch (error) {
        if (String(error).includes('no such table')) return [table, { missing: true }]
        throw error
      }
    }))
  } finally {
    db.close()
  }
}

function stringifyInput(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return JSON.stringify(value)
  return value.map(item => {
    if (!item || typeof item !== 'object') return String(item)
    const record = item as Record<string, unknown>
    return String(record.text ?? record.content ?? '')
  }).join('\n')
}

function agent(id: string, input = id): Record<string, unknown> {
  return { id, type: 'agent', position: { x: 0, y: 0 }, data: { title: id, agent: 'hermes', input, skills: [], approvalRequired: false } }
}

function feedback(id: string, source: string, target: string, maxIterations?: number, loopId?: string): Record<string, unknown> {
  const value = maxIterations === undefined && loopId === undefined
    ? true
    : { ...(maxIterations === undefined ? {} : { maxIterations }), ...(loopId ? { loopId } : {}) }
  return { id, source, target, data: { orchestration: { route: 'success', feedback: value } } }
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) return
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function main(): Promise<void> {
  const originalCwd = process.cwd()
  const productionDb = process.env.WORKFLOW_LIVE_PRODUCTION_DB || join(homedir(), '.hermes-web-ui', 'hermes-web-ui.db')
  const productionBefore = productionWorkflowSnapshot(productionDb)
  const tempRoot = mkdtempSync(join(tmpdir(), 'hermes-studio-workflow-live-'))
  const cleanupTempRoot = () => rmSync(tempRoot, { recursive: true, force: true })
  process.once('exit', cleanupTempRoot)
  const evidencePath = process.env.WORKFLOW_LIVE_EVIDENCE || '/tmp/hermes-studio-workflow-live-evidence.json'
  const prefix = `live-${Date.now()}-${randomUUID().slice(0, 8)}`
  let server: Server | null = null
  let baseUrl = ''
  const createdWorkflowIds: string[] = []
  const requests: Array<{ sessionId: string; input: string }> = []
  const aborted: Array<{ sessionId: string; reason: string }> = []
  const held = new Map<string, (result: { ok: true; output: string }) => void>()
  const scenarios: Record<string, unknown> = {}

  process.env.NODE_ENV = 'test'
  process.env.VITEST = 'true'
  process.env.HERMES_WEB_UI_HOME = join(tempRoot, 'webui')
  process.env.HERMES_WEBUI_STATE_DIR = process.env.HERMES_WEB_UI_HOME
  process.env.HERMES_HOME = join(tempRoot, 'hermes')
  process.env.PROFILE = 'default'
  process.chdir(tempRoot)

  const [{ default: Koa }, bodyParserModule, routesModule, chatRunModule, initModule, managerModule, runStoreModule, dbModule] = await Promise.all([
    import('koa'),
    import('@koa/bodyparser'),
    import('../packages/server/src/routes/hermes/workflows'),
    import('../packages/server/src/routes/hermes/chat-run'),
    import('../packages/server/src/db/hermes/init'),
    import('../packages/server/src/services/workflow-manager'),
    import('../packages/server/src/db/hermes/workflow-run-store'),
    import('../packages/server/src/db'),
  ])
  const bodyParser = bodyParserModule.default
  const manager = managerModule.getWorkflowManager()
  const runner = {
    runAndWait: async (request: any, options?: { timeoutMs?: number }) => {
      const input = stringifyInput(request.input)
      requests.push({ sessionId: request.session_id, input })
      if (input.includes('HOLD_SOURCE')) {
        return await new Promise<{ ok: true; output: string }>(resolve => held.set(request.session_id, resolve))
      }
      if (input.includes('TIMEOUT_SOURCE')) return { ok: false, error: `chat-run timed out after ${options?.timeoutMs}ms` }
      if (input.includes('FAIL_SOURCE')) return { ok: false, error: 'deterministic source failure' }
      if (input.includes('PASS_SOURCE')) return { ok: true, output: 'PASS' }
      return { ok: true, output: 'continue' }
    },
    abortSession: async (sessionId: string, reason: string) => {
      aborted.push({ sessionId, reason })
    },
  }
  chatRunModule.setChatRunServer(runner as any)
  initModule.initAllStores()

  const app = new Koa()
  app.use(async (ctx: any, next: any) => {
    try { await next() } catch (error) {
      ctx.status = Number((error as any)?.status) || 500
      ctx.body = { error: error instanceof Error ? error.message : String(error) }
    }
  })
  app.use(bodyParser())
  app.use(async (ctx: any, next: any) => {
    ctx.state.user = { id: 'workflow-live-acceptance', role: 'super_admin' }
    ctx.state.profile = { name: 'default' }
    await next()
  })
  app.use(routesModule.workflowRoutes.routes())
  app.use(routesModule.workflowRoutes.allowedMethods())
  server = createServer(app.callback())
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('disposable HTTP server has no TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`

  async function api(method: string, path: string, body?: unknown, expected?: number): Promise<any> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const payload = text ? JSON.parse(text) : null
    if (expected !== undefined) assert.equal(response.status, expected, `${method} ${path}: ${text}`)
    return { status: response.status, body: payload }
  }

  async function createWorkflow(name: string, nodes: unknown[], edges: unknown[]): Promise<any> {
    const response = await api('POST', '/api/hermes/workflows', { name: `${prefix}-${name}`, profile: 'default', workspace: null, nodes, edges, viewport: null }, 201)
    createdWorkflowIds.push(response.body.workflow.id)
    return response.body.workflow
  }

  async function listRuns(workflowId: string): Promise<any[]> {
    return (await api('GET', `/api/hermes/workflows/${workflowId}/runs`, undefined, 200)).body.runs
  }

  async function waitForRun(workflowId: string, runId?: string, terminal = true): Promise<any> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const runs = await listRuns(workflowId)
      const run = runId ? runs.find(item => item.id === runId) : runs[0]
      if (run && (!terminal || !['queued', 'running'].includes(run.status))) return run
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for workflow ${workflowId} run ${runId || '<latest>'}`)
  }

  async function startAndWait(workflowId: string, body: Record<string, unknown> = {}): Promise<any> {
    await api('POST', `/api/hermes/workflows/${workflowId}/run`, body, 202)
    return waitForRun(workflowId)
  }

  try {
    // Real persisted branch decisions, true skipped state, and append-only evidence.
    const branch = await createWorkflow('branch', [
      agent('source', 'PASS_SOURCE'), agent('matched'), agent('unmatched'), agent('always'),
    ], [
      { id: 'yes', source: 'source', target: 'matched', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'PASS' } } } },
      { id: 'no', source: 'source', target: 'unmatched', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'RETRY' } } } },
      { id: 'always', source: 'source', target: 'always', data: { orchestration: { route: 'always' } } },
    ])
    const branchRun = await startAndWait(branch.id)
    assert.equal(branchRun.status, 'completed')
    assert.deepEqual(branchRun.node_sessions.map((item: any) => item.node_id).sort(), ['always', 'matched', 'source'])
    assert.deepEqual(Object.fromEntries(branchRun.edge_evaluations.map((item: any) => [item.edge_id, item.status])), { yes: 'taken', no: 'not_taken', always: 'taken' })
    assert.equal(manager.getRuntimeStatus(branch.id).nodeStatuses.unmatched, 'skipped')
    scenarios.branch = { runStatus: branchRun.status, nodes: manager.getRuntimeStatus(branch.id).nodeStatuses, edges: branchRun.edge_evaluations.map((item: any) => [item.edge_id, item.status]) }

    // Failure and always continue, while success is truly skipped and the Run remains failed.
    const failure = await createWorkflow('failure', [agent('source', 'FAIL_SOURCE'), agent('success'), agent('failure'), agent('always')], [
      { id: 'success-edge', source: 'source', target: 'success', data: { orchestration: { route: 'success' } } },
      { id: 'failure-edge', source: 'source', target: 'failure', data: { orchestration: { route: 'failure' } } },
      { id: 'always-edge', source: 'source', target: 'always', data: { orchestration: { route: 'always' } } },
    ])
    const failureRun = await startAndWait(failure.id)
    assert.equal(failureRun.status, 'failed')
    assert.deepEqual(failureRun.node_sessions.map((item: any) => item.node_id).sort(), ['always', 'failure', 'source'])
    assert.equal(manager.getRuntimeStatus(failure.id).nodeStatuses.success, 'skipped')
    scenarios.failure = { runStatus: failureRun.status, nodes: manager.getRuntimeStatus(failure.id).nodeStatuses }

    // Default three iterations and custom two iterations.
    const defaultLoop = await createWorkflow('loop-default', [agent('header'), agent('latch')], [
      { id: 'forward', source: 'header', target: 'latch' }, feedback('retry', 'latch', 'header'),
    ])
    const defaultRun = await startAndWait(defaultLoop.id)
    assert.equal(defaultRun.node_sessions.length, 6)
    assert.equal(defaultRun.loop_epochs.length, 3)
    assert.equal(defaultRun.edge_evaluations.filter((item: any) => item.edge_id === 'retry').at(-1).reason, 'iteration_limit_reached')

    const customLoop = await createWorkflow('loop-custom', [agent('header'), agent('latch')], [
      { id: 'forward', source: 'header', target: 'latch' }, feedback('retry', 'latch', 'header', 2, 'custom-loop'),
    ])
    const customRun = await startAndWait(customLoop.id)
    assert.equal(customRun.node_sessions.length, 4)
    assert.equal(customRun.loop_epochs.length, 2)
    scenarios.loops = { defaultExecutions: defaultRun.node_sessions.length, defaultEpochs: defaultRun.loop_epochs.length, customExecutions: customRun.node_sessions.length, customEpochs: customRun.loop_epochs.length }

    // Rerun appends a separate execution scope to the same Run instead of overwriting history.
    await api('POST', `/api/hermes/workflows/${customLoop.id}/runs/${customRun.id}/rerun-from-node`, { node_id: 'header' }, 202)
    const rerun = await waitForRun(customLoop.id, customRun.id)
    assert.equal(rerun.status, 'completed')
    const rerunSessions = rerun.node_sessions.filter((item: any) => item.execution_id.includes('@rerun:'))
    assert.equal(rerunSessions.length, 4)
    assert.equal(rerun.node_sessions.length, 8)
    assert.equal(new Set(rerun.node_sessions.map((item: any) => item.execution_id)).size, 8)
    scenarios.rerun = { totalExecutions: rerun.node_sessions.length, scopedExecutions: rerunSessions.length, scope: rerunSessions[0].iteration_path[0].executionScope }

    // Nested 2x2 loop preserves canonical outer/inner iteration history.
    const nested = await createWorkflow('nested', ['outer-h', 'inner-h', 'inner-l', 'outer-l'].map(id => agent(id)), [
      { id: 'outer-inner', source: 'outer-h', target: 'inner-h' },
      { id: 'inner-forward', source: 'inner-h', target: 'inner-l' },
      { id: 'inner-outer', source: 'inner-l', target: 'outer-l' },
      feedback('inner-retry', 'inner-l', 'inner-h', 2, 'inner-loop'),
      feedback('outer-retry', 'outer-l', 'outer-h', 2, 'outer-loop'),
    ])
    const nestedRun = await startAndWait(nested.id)
    assert.equal(nestedRun.node_sessions.length, 12)
    assert.equal(nestedRun.loop_epochs.length, 6)
    const deepest = nestedRun.node_sessions.find((item: any) => item.node_id === 'inner-h' && item.iteration_path.length === 2 && item.iteration_path[0].iteration === 1 && item.iteration_path[1].iteration === 1)
    assert.ok(deepest)
    const timeline = [...nestedRun.node_sessions, ...nestedRun.edge_evaluations, ...nestedRun.loop_epochs].sort((a: any, b: any) => a.sequence - b.sequence)
    assert.equal(new Set(timeline.map((item: any) => item.sequence)).size, timeline.length)
    scenarios.nested = { executions: nestedRun.node_sessions.length, epochs: nestedRun.loop_epochs.length, deepestPath: deepest.iteration_path, timelineEntries: timeline.length }

    // Static budget rejection occurs before durable Run acceptance/persistence.
    const budgetNodes = Array.from({ length: 11 }, (_, index) => agent(`n${index}`))
    const budgetEdges = Array.from({ length: 10 }, (_, index) => ({ id: `e${index}`, source: `n${index}`, target: `n${index + 1}` }))
    budgetEdges.push(feedback('budget-retry', 'n10', 'n0', 100) as any)
    const budget = await createWorkflow('budget', budgetNodes, budgetEdges)
    const budgetResponse = await api('POST', `/api/hermes/workflows/${budget.id}/run`, {}, 400)
    assert.match(budgetResponse.body.error, /execution bound 1100 exceeds run budget 1000/)
    assert.equal((await listRuns(budget.id)).length, 0)
    scenarios.budget = { status: budgetResponse.status, error: budgetResponse.body.error, persistedRuns: 0 }

    // Exact runner timeout is classified as the Run-level absolute deadline failure.
    const timeout = await createWorkflow('timeout', [agent('source', 'TIMEOUT_SOURCE')], [])
    const timeoutRun = await startAndWait(timeout.id, { timeout_ms: 250 })
    assert.equal(timeoutRun.status, 'failed')
    assert.equal(timeoutRun.error, 'workflow run timed out after 250ms')
    assert.equal(timeoutRun.node_sessions[0].status, 'failed')
    scenarios.timeout = { runStatus: timeoutRun.status, error: timeoutRun.error, nodeStatus: timeoutRun.node_sessions[0].status }

    // Stop persists canceled before abort; a late success cannot overwrite or dispatch target.
    const cancel = await createWorkflow('cancel', [agent('source', 'HOLD_SOURCE'), agent('target')], [{ id: 'next', source: 'source', target: 'target' }])
    await api('POST', `/api/hermes/workflows/${cancel.id}/run`, {}, 202)
    const running = await waitForRun(cancel.id, undefined, false)
    assert.equal(running.status, 'running')
    const stop = await api('POST', `/api/hermes/workflows/${cancel.id}/runs/${running.id}/stop`, {}, 200)
    assert.equal(stop.body.run.status, 'canceled')
    for (const release of held.values()) release({ ok: true, output: 'late success' })
    held.clear()
    await new Promise(resolve => setTimeout(resolve, 30))
    const canceledRun = await waitForRun(cancel.id, running.id)
    assert.equal(canceledRun.status, 'canceled')
    assert.deepEqual(canceledRun.node_sessions.map((item: any) => item.node_id), ['source'])
    assert.equal(canceledRun.edge_evaluations.length, 0)
    assert.ok(aborted.some(item => item.reason === 'Workflow run canceled by user'))
    scenarios.cancel = { runStatus: canceledRun.status, sessions: canceledRun.node_sessions.map((item: any) => item.node_id), edges: canceledRun.edge_evaluations.length, aborts: aborted.length }

    // Restart recovery fails every active execution closed, then HTTP delete removes all evidence.
    const recovery = await createWorkflow('recovery', [agent('node')], [])
    const orphan = runStoreModule.createWorkflowRun({ workflow_id: recovery.id, profile: 'default', status: 'running', snapshot_nodes: recovery.nodes, snapshot_edges: [], compiled_loops: [], started_at: Date.now() })
    runStoreModule.createWorkflowRunNodeSession({ run_id: orphan.id, workflow_id: recovery.id, node_id: 'node', execution_id: 'node@orphan', session_id: `orphan-${randomUUID()}`, profile: 'default', agent: 'hermes', status: 'running', sequence: 0, started_at: Date.now() })
    const recovered = await manager.recoverActiveRuns(recovery.id)
    assert.deepEqual(recovered, { runs: 1, sessions: 1 })
    const recoveredRun = (await api('GET', `/api/hermes/workflows/${recovery.id}/runs/${orphan.id}`, undefined, 200)).body.run
    assert.equal(recoveredRun.status, 'failed')
    assert.equal(recoveredRun.node_sessions[0].status, 'failed')
    await api('DELETE', `/api/hermes/workflows/${recovery.id}/runs/${orphan.id}`, undefined, 200)
    await api('GET', `/api/hermes/workflows/${recovery.id}/runs/${orphan.id}`, undefined, 404)
    assert.equal(runStoreModule.getWorkflowRun(orphan.id), null)
    scenarios.recoveryDelete = { recovered, status: recoveredRun.status, nodeStatus: recoveredRun.node_sessions[0].status, deleted: true }

    // Delete a completed Run and verify Node/Edge/Loop history is removed together.
    await api('DELETE', `/api/hermes/workflows/${nested.id}/runs/${nestedRun.id}`, undefined, 200)
    assert.equal(runStoreModule.getWorkflowRun(nestedRun.id), null)
    assert.deepEqual(runStoreModule.listWorkflowRunNodeSessions(nestedRun.id), [])
    assert.deepEqual(runStoreModule.listWorkflowRunEdgeEvaluations(nestedRun.id), [])
    assert.deepEqual(runStoreModule.listWorkflowRunLoopEpochs(nestedRun.id), [])
    scenarios.deleteCleanup = { run: 0, node: 0, edge: 0, loop: 0 }
  } finally {
    for (const release of held.values()) release({ ok: true, output: 'cleanup' })
    held.clear()
    for (const workflowId of [...createdWorkflowIds].reverse()) {
      try { await api('DELETE', `/api/hermes/workflows/${workflowId}`, undefined) } catch {}
    }
    await closeServer(server)
    chatRunModule.setChatRunServer(null as any)
    dbModule.closeDb()
    process.chdir(originalCwd)
  }

  const productionAfter = productionWorkflowSnapshot(productionDb)
  assert.deepEqual(productionAfter, productionBefore, `production Workflow tables changed during disposable acceptance: ${productionDb}`)
  const evidence = {
    ok: true,
    prefix,
    isolatedRoot: tempRoot,
    isolatedDatabase: join(tempRoot, 'packages/server/data/test-runtime/hermes-web-ui.db'),
    productionDatabase: productionDb,
    productionWorkflowTablesUnchanged: true,
    productionSnapshot: productionAfter,
    deterministicRunnerRequests: requests.length,
    scenarios,
  }
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2))
  cleanupTempRoot()
  process.removeListener('exit', cleanupTempRoot)
  console.log(JSON.stringify({ ...evidence, isolatedRoot: '<removed>', isolatedDatabase: '<removed>' }, null, 2))
  console.log(`Evidence: ${evidencePath}`)
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error)
    process.exit(1)
  },
)
