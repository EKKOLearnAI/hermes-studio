import { readFile } from 'fs/promises'
import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('workflow canvas exposes orchestration editing and portability controls', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'a', type: 'agent', position: { x: 0, y: 80 }, data: { title: 'Agent A', agent: 'hermes', input: 'Run Agent A', skills: [], images: [], approvalRequired: false } },
    { id: 'b', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Agent B', agent: 'hermes', input: 'Run Agent B', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [{ id: 'a-b', source: 'a', target: 'b', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep' }]
  const legacySnapshotNodes = nodes.map(({ position: _position, ...node }) => node)
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-1', name: 'Loop workflow', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowImportDocument: { name: 'Imported flow', nodes: [{ id: 'imported', type: 'agent', position: { x: 0, y: 0 }, data: { title: 'Imported', agent: 'hermes' } }], edges: [], viewport: null }, workflowRuns: [{
    id: 'run-1', workflow_id: 'wf-1', profile: 'research', workspace: null, start_node_ids: [], status: 'completed',
    snapshot_nodes: legacySnapshotNodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null,
    node_sessions: [{ id: 'node-1', run_id: 'run-1', workflow_id: 'wf-1', node_id: 'a', execution_id: 'rerun:2:a', iteration_path: [{ executionScope: 'rerun:2', loopId: 'loop:a', iteration: 1 }], consumed_edge_evaluation_ids: [], session_id: 'session-a', profile: 'research', agent: 'hermes', agent_mode: '', status: 'completed', sequence: 3, started_at: 1, finished_at: 2, created_at: 1, updated_at: 2, error: null }],
    edge_evaluations: Array.from({ length: 18 }, (_, index) => ({ id: `edge-${index + 1}`, run_id: 'run-1', workflow_id: 'wf-1', edge_id: 'a-b', source_node_id: 'a', source_execution_id: `rerun:2:a:${index + 1}`, iteration_path: [{ executionScope: 'rerun:2', loopId: 'loop:a', iteration: index + 1 }], target_node_id: 'b', source_outcome: 'success', status: 'taken', route: 'success', reason: null, sequence: 4 + index, orchestration: { route: 'success' }, condition_evaluation: null, evaluated_at: 2 })),
    loop_epochs: [{ id: 'loop-1', run_id: 'run-1', workflow_id: 'wf-1', loop_id: 'loop:a', iteration: 18, iteration_path: [{ executionScope: 'rerun:2', loopId: 'loop:a', iteration: 18 }], status: 'completed', exit_reason: 'feedback_not_taken', sequence: 30, started_at: 1, finished_at: 2 }],
  }] })
  await page.goto('/#/hermes/workflow')
  await expect(page.locator('.header-workflow-title')).toHaveText('Loop workflow')
  const firstNode = page.locator('.vue-flow__node[data-id="a"]')
  await expect(firstNode).toHaveAttribute('style', /translate\(0px,\s*80px\)/)
  await expect(firstNode).toHaveCSS('width', '300px')
  await expect(firstNode).toHaveCSS('height', '550px')
  const importButton = page.getByRole('button', { name: 'Import Workflow' })
  await expect(importButton).toBeVisible()
  await expect(importButton).toHaveText('')
  await expect(importButton.locator('svg')).toBeVisible()
  await expect(importButton.locator('svg path').nth(0)).toHaveAttribute('d', 'M12 16V5')
  await expect(importButton.locator('svg path').nth(1)).toHaveAttribute('d', 'm8 9 4-4 4 4')
  const exportButton = page.getByRole('button', { name: 'Export Workflow' })
  await expect(exportButton).toBeVisible()
  await expect(exportButton).toHaveText('')
  await expect(exportButton.locator('svg')).toBeVisible()
  await expect(exportButton.locator('svg path').nth(0)).toHaveAttribute('d', 'M12 3v11')
  await expect(exportButton.locator('svg path').nth(1)).toHaveAttribute('d', 'm8 10 4 4 4-4')
  const toolbarLabels = await page.locator('.header-actions button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
  expect(toolbarLabels.indexOf('Import Workflow')).toBeLessThan(toolbarLabels.indexOf('Export Workflow'))
  const downloadPromise = page.waitForEvent('download')
  await exportButton.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('Loop-workflow.workflow.json')
  const downloadPath = await download.path()
  expect(downloadPath).toBeTruthy()
  const exported = JSON.parse(await readFile(downloadPath!, 'utf8'))
  expect(exported).toMatchObject({ format: 'hermes-studio.workflow', version: 1, definition: { name: 'Loop workflow' } })
  expect(JSON.stringify(exported)).not.toMatch(/workspace|session_id|run_id|token|api[_-]?key/i)
  const chooser = page.waitForEvent('filechooser')
  await importButton.click()
  const fileChooser = await chooser
  await fileChooser.setFiles({ name: 'import.workflow.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
  await expect(page.getByTestId('workflow-import-summary')).toHaveText('Imported flow · 1 nodes · 0 links')
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/confirm')).toHaveLength(0)
  await page.getByTestId('workflow-import-confirm').click()
  await expect(page.locator('.header-workflow-title')).toHaveText('Imported flow')
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/confirm')).toHaveLength(1)
  const cancelChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import Workflow' }).click()
  const cancelChooser = await cancelChooserPromise
  await cancelChooser.setFiles({ name: 'cancel.workflow.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
  await expect(page.getByTestId('workflow-import-summary')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('workflow-import-summary')).toHaveCount(0)
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/cancel')).toHaveLength(1)
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/confirm')).toHaveLength(1)
  await page.locator('.workflow-list-item').filter({ hasText: 'Loop workflow' }).click()
  await expect(page.locator('.header-workflow-title')).toHaveText('Loop workflow')
  await page.locator('.workflow-run-item').click()
  await expect(firstNode).toHaveAttribute('style', /translate\(0px,\s*80px\)/)
  await expect(firstNode).toHaveCSS('width', '300px')
  await expect(firstNode).toHaveCSS('height', '550px')
  const evidence = page.getByLabel('Workflow execution details')
  const evidenceToggle = evidence.getByRole('button', { name: /Path checks/ })
  await expect(evidenceToggle).toContainText('18 used')
  await expect(evidenceToggle).toContainText('0 not used')
  await expect(evidenceToggle).toContainText('1 event')
  await expect(evidenceToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(evidence.getByTestId('workflow-actual-path')).toContainText('Agent A → Agent B')
  await expect(evidence.getByText('a-b', { exact: true })).toHaveCount(0)
  await evidenceToggle.click()
  await expect(evidenceToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(evidence.getByText('Agent A → Agent B', { exact: true }).first()).toBeVisible()
  await expect(evidence.getByText('This path was selected.', { exact: true }).first()).toBeVisible()
  await evidence.getByRole('button', { name: 'Show other details (1)' }).click()
  await expect(evidence.getByText('Loop pass 19', { exact: true })).toBeVisible()
  await expect(evidence.getByText('a-b', { exact: true }).first()).toBeHidden()
  const evidenceList = evidence.locator('.workflow-evidence-list')
  await expect(evidenceList).toHaveCSS('overflow-y', 'auto')
  expect(await evidenceList.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await evidence.locator('.workflow-evidence-row').first().click()
  const evidenceDetailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(evidenceDetailModal).toBeVisible()
  await expect(evidenceDetailModal.getByText('a-b', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(evidenceDetailModal).toBeHidden()
  await page.locator('.workflow-run-item').click()
  const joinHelpIcons = page.getByTestId('workflow-node-join-help')
  const joinHelp = page.getByText('All incoming routes must be taken; if one does not match, this node is skipped. Example: wait for both parallel checks.', { exact: true })
  await expect(joinHelpIcons).toHaveCount(2)
  await expect(joinHelp).toHaveCount(0)
  await joinHelpIcons.first().hover()
  await expect(joinHelp).toBeVisible()
  const edge = page.locator('.vue-flow__edge').first()
  await edge.click({ force: true })
  const edgeDialog = page.locator('.workflow-edge-editor-form').first()
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  const routeHelp = page.getByText('First match the source result. success: source succeeded; failure: source failed; always: either result. A condition, when present, must also match.', { exact: true })
  const routeExample = page.getByText('Example: use success for the normal path, failure for error handling, and always for cleanup.', { exact: true })
  await expect(routeHelp).toHaveCount(0)
  await expect(routeExample).toHaveCount(0)
  await page.getByTestId('workflow-edge-route-help').hover()
  await expect(routeHelp).toBeVisible()
  await expect(routeExample).toBeVisible()
  await edgeDialog.locator('.n-select').first().click()
  for (const route of ['Success only (success)', 'Failure only (failure)', 'Always (always)']) {
    await expect(page.getByText(route, { exact: true }).last()).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workflow-edge-condition-path-preset')).toBeVisible()
  await expect(page.getByTestId('workflow-edge-condition-operator')).toHaveCount(0)
  await page.getByTestId('workflow-edge-condition-path-preset').click()
  await expect(page.getByText('Route only — no condition', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Successful reply text (output, recommended)', { exact: true }).last()).toBeVisible()
  const structuredOutputOption = page.getByText('Structured reply JSON (outputJson.*)', { exact: true }).last()
  await expect(structuredOutputOption).toBeVisible()
  await expect(page.getByText('Failure error text (error)', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Custom path (advanced)', { exact: true }).last()).toBeVisible()
  await structuredOutputOption.click()
  const structuredOutputPath = edgeDialog.getByTestId('workflow-edge-condition-path').locator('input')
  await expect(structuredOutputPath).toHaveValue('outputJson')
  await structuredOutputPath.fill('outputJson.route_token')
  await edgeDialog.getByTestId('workflow-edge-condition-value').locator('input').fill('HSR_RELEASED_OK')
  const structuredOutputHelp = page.getByText('Parses a complete JSON reply or exactly one fenced json block. Missing, malformed, or multiple JSON blocks leave outputJson unavailable, so the condition does not match.', { exact: true })
  await expect(structuredOutputHelp).toHaveCount(0)
  await page.getByTestId('workflow-edge-condition-path-help').hover()
  await expect(structuredOutputHelp).toBeVisible()
  await edgeDialog.getByRole('button', { name: 'Save', exact: true }).click()
  const workflowPatchCount = api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-1').length
  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-1').length).toBe(workflowPatchCount + 1)
  const workflowPatchRequest = api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-1').at(-1)!
  const workflowPatch = JSON.parse(workflowPatchRequest.postData || '{}')
  expect(workflowPatch.edges[0].data.orchestration.condition).toEqual({
    path: 'outputJson.route_token', operator: 'equals', value: 'HSR_RELEASED_OK',
  })
  await edge.click({ force: true })
  await expect(page.getByTestId('workflow-edge-condition-path-preset')).toContainText('Structured reply JSON (outputJson.*)')
  await expect(edgeDialog.getByTestId('workflow-edge-condition-path').locator('input')).toHaveValue('outputJson.route_token')
  await page.getByTestId('workflow-edge-condition-path-preset').click()
  await page.getByText('Successful reply text (output, recommended)', { exact: true }).last().click()
  const conditionHelp = page.getByText('For success, output is recommended. Choose Route only when no content check is needed.', { exact: true })
  const operatorHelp = page.getByText('Exactly equal, including type. Example: output equals "APPROVED".', { exact: true })
  const valueTypeHelp = page.getByText('Choose how Value is parsed and validated. This editing aid is inferred from the saved JSON value and is not stored separately.', { exact: true })
  const valueHelp = page.getByText('Enter a value matching the selected type. Objects and arrays use JSON; strings are entered without JSON quotes.', { exact: true })
  const feedbackHelp = page.getByText('Marks this backward connection as a bounded loop. It repeats only while the route and condition match, and stops at Maximum iterations.', { exact: true })
  for (const help of [conditionHelp, operatorHelp, valueTypeHelp, valueHelp, feedbackHelp]) await expect(help).toHaveCount(0)
  await page.getByTestId('workflow-edge-condition-path-help').hover()
  await expect(conditionHelp).toBeVisible()
  await edgeDialog.getByTestId('workflow-edge-operator-help').hover()
  await expect(operatorHelp).toBeVisible()
  const valueType = edgeDialog.getByTestId('workflow-edge-condition-value-type')
  await expect(valueType).toContainText('String')
  await edgeDialog.getByTestId('workflow-edge-condition-value-type-help').hover()
  await expect(valueTypeHelp).toBeVisible()
  await edgeDialog.getByTestId('workflow-edge-condition-value-help').hover()
  await expect(valueHelp).toBeVisible()
  await edgeDialog.getByTestId('workflow-edge-feedback-help').hover()
  await expect(feedbackHelp).toBeVisible()
  await valueType.click()
  const objectValueTypeOption = page.locator('.n-base-select-option:visible').filter({ hasText: /^Object$/ })
  await expect(objectValueTypeOption).toHaveCount(1)
  await objectValueTypeOption.click()
  await expect(valueType).toContainText('Object')
  await expect(edgeDialog.getByTestId('workflow-edge-condition-value').locator('input')).toHaveAttribute('placeholder', 'JSON object, for example {"status":"ready"}')
  await edgeDialog.getByTestId('workflow-edge-condition-value').locator('input').fill('{')
  await expect(edgeDialog.getByTestId('workflow-edge-condition-value-error')).toHaveText('Value must be a valid object.')
  const edgeSaveButton = edgeDialog.getByRole('button', { name: 'Save', exact: true })
  await expect(edgeSaveButton).toBeDisabled()
  const activeValueInput = edgeDialog.getByTestId('workflow-edge-condition-value').locator('input')
  await activeValueInput.fill('{"status":"ready"}')
  await expect(activeValueInput).toHaveValue('{"status":"ready"}')
  await expect(edgeDialog.getByTestId('workflow-edge-condition-value-error')).toHaveCount(0)
  await expect(edgeSaveButton).toBeEnabled()
  await edgeSaveButton.click()
  await expect(page.getByText('Edit connection', { exact: true })).toHaveCount(0)

  await edge.click({ force: true })
  const reopenedEdgeDialog = page.locator('.workflow-edge-editor-form').first()
  await expect(reopenedEdgeDialog.getByTestId('workflow-edge-condition-value-type')).toContainText('Object')
  await expect(reopenedEdgeDialog.getByTestId('workflow-edge-condition-value').locator('input')).toHaveValue('{"status":"ready"}')
  await reopenedEdgeDialog.getByTestId('workflow-edge-condition-operator').click()
  const greaterThanOption = page.getByText('Greater than (greater_than)', { exact: true }).last()
  await expect(greaterThanOption).toBeVisible()
  await greaterThanOption.click()
  const activeValueType = reopenedEdgeDialog.getByTestId('workflow-edge-condition-value-type')
  await expect(activeValueType).toContainText('Number')
  await expect(activeValueType.locator('.n-base-selection')).toHaveClass(/n-base-selection--disabled/)
  const numberOperatorHelp = page.getByText('Both actual value and Value must be JSON numbers; matches when actual is greater.', { exact: true })
  await expect(numberOperatorHelp).toHaveCount(0)
  await reopenedEdgeDialog.getByTestId('workflow-edge-operator-help').hover()
  await expect(numberOperatorHelp).toBeVisible()
  await reopenedEdgeDialog.getByTestId('workflow-edge-condition-value').locator('input').fill('42')
  await reopenedEdgeDialog.getByText('Feedback loop', { exact: true }).click()
  const maxIterationsHelp = page.getByText('Total loop passes allowed, from 1 to 100. The run also has a global execution safety budget.', { exact: true })
  const loopIdHelp = page.getByText('This only labels the loop in execution history; it does not change when the loop runs. Keep Automatic unless an advanced multi-loop design needs a stable custom ID.', { exact: true })
  await expect(maxIterationsHelp).toHaveCount(0)
  await expect(loopIdHelp).toHaveCount(0)
  await page.getByTestId('workflow-edge-max-iterations-help').hover()
  await expect(maxIterationsHelp).toBeVisible()
  await page.getByTestId('workflow-edge-loop-id-help').hover()
  await expect(loopIdHelp).toBeVisible()
  const loopIdSelect = reopenedEdgeDialog.getByTestId('workflow-edge-loop-id')
  await expect(loopIdSelect).toBeVisible()
  await loopIdSelect.click()
  await expect(page.getByText('Automatic (recommended) · loop:a-b', { exact: true }).last()).toBeVisible()
  await page.keyboard.press('Escape')
  await loopIdSelect.locator('input').fill('review-loop')
  await loopIdSelect.locator('input').press('Enter')
  await reopenedEdgeDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  await edge.click({ force: true })
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByTestId('workflow-edge-condition-path-preset')).toContainText('Successful reply text (output, recommended)')
  await expect(page.getByTestId('workflow-edge-condition-value-type')).toContainText('Number')
  await expect(page.getByTestId('workflow-edge-condition-value').locator('input')).toHaveValue('42')
  await expect(page.getByTestId('workflow-edge-loop-id')).toContainText('review-loop')
  await page.getByTestId('workflow-edge-condition-operator').click({ force: true })
  await page.getByText('Exists (exists)', { exact: true }).last().click()
  await expect(page.getByTestId('workflow-edge-condition-value-type')).toHaveCount(0)
  await expect(page.getByTestId('workflow-edge-condition-value')).toHaveCount(0)
  await edgeDialog.getByRole('button', { name: 'Save', exact: true }).click()

  await edge.dispatchEvent('contextmenu', { clientX: 300, clientY: 180, button: 2 })
  await page.getByText('Edit Connection', { exact: true }).click()
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  const sourceHandle = page.locator('.vue-flow__node[data-id="a"] .vue-flow__handle.source')
  const canvas = page.locator('.vue-flow__pane')
  await page.getByRole('button', { name: 'Hide run records' }).click()
  const handleBox = await sourceHandle.boundingBox()
  const canvasBox = await canvas.boundingBox()
  expect(handleBox).not.toBeNull()
  expect(canvasBox).not.toBeNull()
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(canvasBox!.x + canvasBox!.width * .72, canvasBox!.y + canvasBox!.height * .82, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.vue-flow__node')).toHaveCount(3)
  await expect(page.locator('.vue-flow__node.selected')).toHaveCount(1)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await page.locator('.vue-flow__node.selected input').first().focus()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.vue-flow__node')).toHaveCount(3)
  await canvas.click({ position: { x: 24, y: 24 } })
  await page.keyboard.press('Control+z')
  await expect(page.locator('.vue-flow__node')).toHaveCount(2)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
  expect(api.unexpectedRequests).toEqual([])
})


test('workflow execution details explain an upstream business blocker before raw routing codes', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'publish', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Publish release', agent: 'hermes', input: 'Publish', skills: [], images: [], approvalRequired: false } },
    { id: 'verify', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Verify release', agent: 'hermes', input: 'Verify', skills: [], images: [], approvalRequired: false } },
    { id: 'fallback', type: 'agent', position: { x: 420, y: 260 }, data: { title: 'Notify fallback', agent: 'hermes', input: 'Notify', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [
    { id: 'publish-verify', source: 'publish', target: 'verify', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'PUBLISHED' } } } },
    { id: 'publish-fallback', source: 'publish', target: 'fallback', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'failure' } } },
  ]
  await mockHermesApi(page, { workflows: [{
    id: 'wf-release', name: 'Release workflow', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [{
    id: 'run-blocked', workflow_id: 'wf-release', profile: 'research', workspace: null, start_node_ids: ['publish'], status: 'completed',
    snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null,
    node_sessions: [],
    edge_evaluations: [{
      id: 'evaluation-1', run_id: 'run-blocked', workflow_id: 'wf-release', edge_id: 'publish-verify',
      source_node_id: 'publish', source_execution_id: 'publish', iteration_path: [], target_node_id: 'verify',
      source_outcome: 'success', status: 'not_taken', route: 'success', reason: 'condition_not_matched', sequence: 1,
      orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'PUBLISHED' } },
      condition_evaluation: { status: 'not_matched', reason: 'not_equal', actual: '\n```json\n{"decision":"BLOCKED","route_marker":"BLOCKED","reason":"The release lock was missing before publication."}\n```' },
      evaluated_at: 2,
    }, {
      id: 'evaluation-2', run_id: 'run-blocked', workflow_id: 'wf-release', edge_id: 'publish-fallback',
      source_node_id: 'publish', source_execution_id: 'publish', iteration_path: [], target_node_id: 'fallback',
      source_outcome: 'success', status: 'not_taken', route: 'failure', reason: 'route_not_matched', sequence: 2,
      orchestration: { route: 'failure' },
      condition_evaluation: { actual: JSON.stringify({ decision: 'BLOCKED', reason: 'The release lock was missing before publication.' }) },
      evaluated_at: 2,
    }],
    loop_epochs: [],
  }] })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-run-item').click()
  const evidence = page.getByLabel('Workflow execution details')
  const overview = evidence.getByTestId('workflow-evidence-overview')
  await expect(overview.getByText('Run outcome', { exact: true })).toBeVisible()
  await expect(overview.getByText('BLOCKED', { exact: true })).toBeVisible()
  await expect(overview.getByText('The release lock was missing before publication.', { exact: true })).toBeVisible()
  await evidence.getByRole('button', { name: /Path checks/ }).click()
  await evidence.getByRole('button', { name: 'Show other details (2)' }).click()

  const blockerText = 'Publish release stopped the workflow (BLOCKED): The release lock was missing before publication. Continuing required “PUBLISHED”, but the upstream result was “BLOCKED”, so “Verify release” was not run.'
  await expect(evidence.getByText('Condition did not match', { exact: true })).toBeVisible()
  await expect(evidence.getByText('not_taken', { exact: true })).toHaveCount(0)
  const blockerRow = evidence.locator('.workflow-evidence-row').filter({ hasText: 'Publish release → Verify release' })
  await blockerRow.click()
  const detailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(detailModal).toBeVisible()
  await expect(detailModal.getByText(blockerText, { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Not used (not_taken)', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Continued after success (success)', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Condition did not match (condition_not_matched)', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('PUBLISHED', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('BLOCKED', { exact: true })).toBeVisible()
  await expect(evidence.getByText('The source node returned normally; this path is only used when node execution fails.', { exact: true })).toBeVisible()
})


test('workflow execution details lead with the business outcome, chosen path, and explicit condition comparisons', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'publish', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Build and publish', agent: 'hermes', input: 'Publish', skills: [], images: [], approvalRequired: false } },
    { id: 'verify', type: 'agent', position: { x: 420, y: 40 }, data: { title: 'Verify release', agent: 'hermes', input: 'Verify', skills: [], images: [], approvalRequired: false } },
    { id: 'blocked', type: 'agent', position: { x: 420, y: 240 }, data: { title: 'Blocked outcome', agent: 'hermes', input: 'Explain blocker', skills: [], images: [], approvalRequired: false } },
    { id: 'summary', type: 'agent', position: { x: 760, y: 140 }, data: { title: 'Plain-language summary', agent: 'hermes', input: 'Summarize', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [
    { id: 'publish-verify', source: 'publish', target: 'verify', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'HSR_RELEASED_OK' } } } },
    { id: 'publish-blocked', source: 'publish', target: 'blocked', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'failed_gate' } } } },
    { id: 'publish-summary', source: 'publish', target: 'summary', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'failure', condition: { path: 'error', operator: 'contains', value: 'fatal' } } } },
    { id: 'verify-summary', source: 'verify', target: 'summary', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'always' } } },
    { id: 'blocked-summary', source: 'blocked', target: 'summary', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'always' } } },
  ]
  const blockedOutput = JSON.stringify({
    decision: 'BLOCKED',
    failed_gate: 'quality-container-setup',
    reason: 'The container workdir did not exist before the first command.',
    side_effects_completed: [],
  })
  const evaluation = (input: Record<string, unknown>) => ({
    id: `evaluation-${input.sequence}`, run_id: 'run-blocked-overview', workflow_id: 'wf-release-overview',
    source_execution_id: input.source_node_id, iteration_path: [], evaluated_at: 2,
    condition_evaluation: null, ...input,
  })
  await mockHermesApi(page, { workflows: [{
    id: 'wf-release-overview', name: 'Release workflow', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [{
    id: 'run-blocked-overview', workflow_id: 'wf-release-overview', profile: 'research', workspace: null, start_node_ids: ['publish'], status: 'completed',
    snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null,
    node_sessions: [],
    edge_evaluations: [
      evaluation({ edge_id: 'publish-verify', source_node_id: 'publish', target_node_id: 'verify', source_outcome: 'success', status: 'not_taken', route: 'success', reason: 'condition_not_matched', sequence: 1, orchestration: edges[0].data.orchestration, condition_evaluation: { status: 'not_matched', reason: 'not_equal', actual: blockedOutput } }),
      evaluation({ edge_id: 'publish-blocked', source_node_id: 'publish', target_node_id: 'blocked', source_outcome: 'success', status: 'taken', route: 'success', reason: null, sequence: 2, orchestration: edges[1].data.orchestration, condition_evaluation: { status: 'matched', actual: blockedOutput } }),
      evaluation({ edge_id: 'publish-summary', source_node_id: 'publish', target_node_id: 'summary', source_outcome: 'success', status: 'not_taken', route: 'failure', reason: 'route_not_matched', sequence: 3, orchestration: edges[2].data.orchestration }),
      evaluation({ edge_id: 'verify-summary', source_node_id: 'verify', target_node_id: 'summary', source_outcome: 'skipped', status: 'not_taken', route: 'always', reason: 'route_not_matched', sequence: 4, orchestration: edges[3].data.orchestration }),
      evaluation({ edge_id: 'blocked-summary', source_node_id: 'blocked', target_node_id: 'summary', source_outcome: 'success', status: 'taken', route: 'always', reason: null, sequence: 5, orchestration: edges[4].data.orchestration }),
    ],
    loop_epochs: [],
  }] })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-run-item').click()
  const evidence = page.getByLabel('Workflow execution details')
  const overview = evidence.getByTestId('workflow-evidence-overview')
  await expect(overview.getByText('Run outcome', { exact: true })).toBeVisible()
  await expect(overview.getByText('BLOCKED', { exact: true })).toBeVisible()
  await expect(overview.getByText('Blocked at quality-container-setup', { exact: true })).toBeVisible()
  await expect(overview.getByText('The container workdir did not exist before the first command.', { exact: true })).toBeVisible()
  const actualPath = overview.getByTestId('workflow-actual-path')
  await expect(actualPath).toContainText('Build and publish → Blocked outcome')
  await expect(actualPath).toContainText('Blocked outcome → Plain-language summary')
  await expect(actualPath).not.toContainText('Verify release')

  const detailsToggle = evidence.getByRole('button', { name: /Path checks/ })
  await expect(detailsToggle).toContainText('2 used')
  await expect(detailsToggle).toContainText('3 not used')
  await detailsToggle.click()
  const selectedPaths = evidence.getByTestId('workflow-selected-paths')
  await expect(selectedPaths.locator('.workflow-evidence-row')).toHaveCount(2)
  const blockedPath = selectedPaths.locator('.workflow-evidence-row').filter({ hasText: 'Build and publish → Blocked outcome' })
  await expect(blockedPath.getByTestId('workflow-condition-comparison')).toContainText('output')
  await expect(blockedPath.getByTestId('workflow-condition-comparison')).toContainText('Contains (contains)')
  await expect(blockedPath.getByTestId('workflow-condition-comparison')).toContainText('failed_gate')
  await expect(blockedPath.getByTestId('workflow-condition-comparison')).toContainText('BLOCKED')
  await expect(blockedPath.getByTestId('workflow-condition-comparison')).toContainText('quality-container-setup')
  await expect(blockedPath.getByTestId('workflow-condition-comparison')).toContainText('Matched')
  await expect(selectedPaths).not.toContainText('Continued after success')
  await expect(evidence.getByText('Build and publish → Verify release', { exact: true })).toHaveCount(0)

  const alternativesToggle = evidence.getByRole('button', { name: 'Show other details (3)' })
  await alternativesToggle.click()
  const otherPaths = evidence.getByTestId('workflow-other-paths')
  await expect(otherPaths.locator('.workflow-evidence-row')).toHaveCount(3)
  const verifyPath = otherPaths.locator('.workflow-evidence-row').filter({ hasText: 'Build and publish → Verify release' })
  await expect(verifyPath.getByTestId('workflow-condition-comparison')).toContainText('HSR_RELEASED_OK')
  await expect(verifyPath.getByTestId('workflow-condition-comparison')).toContainText('Did not match')
  const runtimeFailurePath = otherPaths.locator('.workflow-evidence-row').filter({ hasText: 'Build and publish → Plain-language summary' })
  await expect(runtimeFailurePath.getByTestId('workflow-condition-comparison')).toContainText('fatal')
  await expect(runtimeFailurePath.getByTestId('workflow-condition-comparison').locator('.matched, .not-matched')).toHaveCount(0)
  await expect(otherPaths).toContainText('The source node returned normally; this path is only used when node execution fails.')
  await expect(otherPaths).toContainText('The source node did not run, so this path was not part of this run.')

  await blockedPath.click()
  const detailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(detailModal.getByText('Used (taken)', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('success', { exact: false })).toBeVisible()
})


test('workflow canvas animates the active route and preserves the completed route highlight', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'prepare', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Prepare', agent: 'hermes', input: 'Prepare', skills: [], images: [], approvalRequired: false } },
    { id: 'publish', type: 'agent', position: { x: 420, y: 40 }, data: { title: 'Publish', agent: 'hermes', input: 'Publish', skills: [], images: [], approvalRequired: false } },
    { id: 'fallback', type: 'agent', position: { x: 420, y: 260 }, data: { title: 'Fallback', agent: 'hermes', input: 'Fallback', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [
    { id: 'prepare-publish', source: 'prepare', target: 'publish', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep' },
    { id: 'prepare-fallback', source: 'prepare', target: 'fallback', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep' },
  ]
  const edgeEvaluation = (runId: string, edgeId: string, targetNodeId: string, status: 'taken' | 'not_taken', sequence: number) => ({
    id: `${runId}-${edgeId}`, run_id: runId, workflow_id: 'wf-playback', edge_id: edgeId,
    source_node_id: 'prepare', source_execution_id: 'prepare', iteration_path: [], target_node_id: targetNodeId,
    source_outcome: 'success', status, route: 'success', reason: status === 'taken' ? null : 'condition_not_matched',
    sequence, orchestration: { route: 'success' }, condition_evaluation: null, evaluated_at: 2,
  })
  const run = (id: string, status: 'running' | 'completed', targetStatus: 'running' | 'completed') => ({
    id, workflow_id: 'wf-playback', profile: 'research', workspace: null, start_node_ids: ['prepare'], status,
    snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: status === 'completed' ? 2 : null, created_at: 1, error: null,
    node_sessions: [
      { id: `${id}-prepare`, run_id: id, workflow_id: 'wf-playback', node_id: 'prepare', execution_id: 'prepare', iteration_path: [], consumed_edge_evaluation_ids: [], session_id: `${id}-prepare-session`, profile: 'research', agent: 'hermes', agent_mode: '', status: 'completed', sequence: 1, started_at: 1, finished_at: 2, created_at: 1, updated_at: 2, error: null },
      { id: `${id}-publish`, run_id: id, workflow_id: 'wf-playback', node_id: 'publish', execution_id: 'publish', iteration_path: [], consumed_edge_evaluation_ids: [], session_id: `${id}-publish-session`, profile: 'research', agent: 'hermes', agent_mode: '', status: targetStatus, sequence: 2, started_at: 2, finished_at: targetStatus === 'completed' ? 3 : null, created_at: 2, updated_at: 3, error: null },
    ],
    edge_evaluations: [
      edgeEvaluation(id, 'prepare-publish', 'publish', 'taken', 3),
      edgeEvaluation(id, 'prepare-fallback', 'fallback', 'not_taken', 4),
    ],
    loop_epochs: [],
  })
  await mockHermesApi(page, {
    workflows: [{ id: 'wf-playback', name: 'Playback workflow', profile: 'research', workspace: null, nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
    workflowRuns: [run('run-live', 'running', 'running'), run('run-completed', 'completed', 'completed')],
  })

  await page.goto('/#/hermes/workflow')
  const runs = page.locator('.workflow-run-item')
  await runs.nth(0).click()
  const selectedEdge = page.locator('.vue-flow__edge[data-id="prepare-publish"]')
  const unusedEdge = page.locator('.vue-flow__edge[data-id="prepare-fallback"]')
  await expect(selectedEdge).toHaveClass(/workflow-edge--flowing/)
  await expect(selectedEdge).toHaveClass(/animated/)
  await expect(unusedEdge).toHaveClass(/workflow-edge--inactive/)

  await runs.nth(1).click()
  await expect(selectedEdge).toHaveClass(/workflow-edge--completed/)
  await expect(selectedEdge).not.toHaveClass(/animated/)
  await expect(unusedEdge).toHaveClass(/workflow-edge--inactive/)
})


test('workflow import reports an unsupported version without confirming or creating a workflow', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflows: [],
    workflowImportPreviewError: 'unsupported workflow import version',
  })
  await page.goto('/#/hermes/workflow')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import Workflow' }).click()
  const fileChooser = await chooser
  await fileChooser.setFiles({
    name: 'future.workflow.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'hermes-studio.workflow', version: 2, definition: {} })),
  })
  await expect(page.getByText(/unsupported workflow import version/)).toBeVisible()
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/confirm')).toHaveLength(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('workflow title is hidden on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, { workflows: [{
    id: 'wf-mobile', name: 'Mobile workflow title', profile: 'research', workspace: '/tmp/mobile-workspace',
    nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1,
  }] })
  await page.goto('/#/hermes/workflow')
  await expect(page.locator('.header-workflow-title')).toHaveText('Mobile workflow title')
  await expect(page.locator('.header-workflow-title')).toBeHidden()
  const workspaceBadge = page.locator('.workspace-badge')
  await expect(workspaceBadge).toHaveCSS('flex-grow', '1')
  await expect(workspaceBadge).toHaveCSS('max-width', 'none')
})
