import { readFile } from 'fs/promises'
import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

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
  const runItem = page.locator('.workflow-run-item')
  await runItem.click()
  await expect(firstNode).toHaveAttribute('style', /translate\(0px,\s*80px\)/)
  await expect(firstNode).toHaveCSS('width', '300px')
  await expect(firstNode).toHaveCSS('height', '550px')
  const evidence = page.getByLabel('Workflow execution details')
  const evidenceToggle = evidence.getByRole('button', { name: /Path checks/ })
  await expect(evidenceToggle).toContainText('18 used')
  await expect(evidenceToggle).toContainText('0 not used')
  await expect(evidenceToggle).toContainText('1 event')
  await expect(evidenceToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(evidence.getByTestId('workflow-actual-path')).toContainText('Agent A → Agent B')
  await expect(evidence.getByText('a-b', { exact: true })).toHaveCount(0)
  await expect(evidence.getByText('Agent A → Agent B', { exact: true }).first()).toBeVisible()
  await expect(evidence.getByText('This path was selected.', { exact: true }).first()).toBeVisible()
  await expect(evidence.getByText('Loop pass 19', { exact: true })).toBeVisible()
  await expect(evidence.getByText('a-b', { exact: true }).first()).toBeHidden()
  const evidenceList = evidence.locator('.workflow-evidence-list')
  await expect(evidenceList).toHaveCSS('overflow-y', 'auto')
  expect(await evidenceList.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await evidence.locator('.workflow-evidence-row').first().click()
  const evidenceDetailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(evidenceDetailModal).toBeVisible()
  await expect(evidenceDetailModal.getByText('Agent A → Agent B', { exact: true })).toBeVisible()
  await expect(evidenceDetailModal.getByText('a-b', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(evidenceDetailModal).toBeHidden()
  await runItem.click()
  await expect(runItem).not.toHaveClass(/active/)
  await expect(page.getByLabel('Workflow execution details')).toHaveCount(0)
  const joinHelpIcons = page.getByTestId('workflow-node-join-help')
  const joinHelp = page.getByText('All incoming routes must be taken; if one does not match, this node is skipped. Example: wait for both parallel checks.', { exact: true })
  await expect(joinHelpIcons).toHaveCount(2)
  await expect(joinHelp).toHaveCount(0)
  await joinHelpIcons.first().hover()
  await expect(joinHelp).toBeVisible()
  const edge = page.locator('.vue-flow__edge[data-id="a-b"]')
  const edgeLabel = page.locator('[data-testid="workflow-edge-condition-label"][data-edge-id="a-b"]')
  await expect(edgeLabel).toHaveText('Source returned normally')
  await edge.click({ force: true })
  await expect(edge).toHaveClass(/workflow-edge--preview/)
  await expect(edge).toHaveClass(/animated/)
  await expect(page.getByText('Edit connection', { exact: true })).toHaveCount(0)
  await edge.dblclick({ force: true })
  const edgeDialog = page.locator('.workflow-edge-editor-form').first()
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  const connectionSummary = edgeDialog.getByTestId('workflow-edge-connection-summary')
  await expect(connectionSummary).toContainText('Agent A')
  await expect(connectionSummary).toContainText('Agent B')
  const ruleSteps = edgeDialog.getByTestId('workflow-edge-rule-steps')
  await expect(ruleSteps).toHaveCount(0)
  await expect(edgeDialog.getByTestId('workflow-edge-continue-when-label')).toHaveText('Required source result')
  await expect(edgeDialog.getByTestId('workflow-edge-optional-check-label')).toHaveText('Which reply data should be checked?')
  const routeHelp = page.getByText('First match the source result. success: source succeeded; failure: source failed; always: either result. A condition, when present, must also match.', { exact: true })
  const routeExample = page.getByText('Example: use success for the normal path, failure for error handling, and always for cleanup.', { exact: true })
  await expect(routeHelp).toHaveCount(0)
  await expect(routeExample).toHaveCount(0)
  await page.getByTestId('workflow-edge-route-help').hover()
  await expect(routeHelp).toBeVisible()
  await expect(routeExample).toBeVisible()
  await edgeDialog.locator('.n-select').first().click()
  for (const route of ['Source returned normally', 'Source execution failed', 'Either result']) {
    await expect(page.getByText(route, { exact: true }).last()).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workflow-edge-condition-path-preset')).toBeVisible()
  await expect(page.getByTestId('workflow-edge-condition-operator')).toHaveCount(0)
  await page.getByTestId('workflow-edge-condition-path-preset').click()
  await expect(page.getByText('Do not inspect the reply', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Entire successful reply text (output, recommended)', { exact: true }).last()).toBeVisible()
  const structuredOutputOption = page.getByText('One JSON field value (outputJson.*)', { exact: true }).last()
  await expect(structuredOutputOption).toBeVisible()
  await expect(page.getByText('Failure error text (error)', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Advanced data path', { exact: true }).last()).toBeVisible()
  await structuredOutputOption.click()
  await expect(edgeDialog.getByTestId('workflow-edge-compare-using-label')).toHaveText('Compare using')
  await expect(edgeDialog.getByTestId('workflow-edge-expected-type-label')).toHaveText('Interpret expected value as')
  await expect(edgeDialog.getByTestId('workflow-edge-expected-value-label')).toHaveText('Expected field value')
  const structuredOutputPath = edgeDialog.getByTestId('workflow-edge-condition-path').locator('input')
  await expect(structuredOutputPath).toHaveValue('outputJson')
  await structuredOutputPath.fill('outputJson.route_token')
  await edgeDialog.getByTestId('workflow-edge-condition-value').locator('input').fill('HSR_RELEASED_OK')
  const structuredOutputHelp = page.getByText('Parses a complete JSON reply or exactly one fenced json block. Missing, malformed, or multiple JSON blocks leave outputJson unavailable, so the condition does not match.', { exact: true })
  await expect(structuredOutputHelp).toHaveCount(0)
  await page.getByTestId('workflow-edge-condition-path-help').hover()
  await expect(structuredOutputHelp).toBeVisible()
  await edgeDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(edgeLabel).toContainText('route_token')
  await expect(edgeLabel).toContainText('Equals')
  await expect(edgeLabel).toContainText('HSR_RELEASED_OK')
  const workflowPatchCount = api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-1').length
  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-1').length).toBe(workflowPatchCount + 1)
  const workflowPatchRequest = api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-1').at(-1)!
  const workflowPatch = JSON.parse(workflowPatchRequest.postData || '{}')
  expect(workflowPatch.edges[0].data.orchestration.condition).toEqual({
    path: 'outputJson.route_token', operator: 'equals', value: 'HSR_RELEASED_OK',
  })
  expect(workflowPatch.edges[0]).not.toHaveProperty('label')
  expect(workflowPatch.edges[0]).not.toHaveProperty('labelStyle')
  expect(workflowPatch.edges[0]).not.toHaveProperty('labelBgStyle')
  for (const key of ['Enter', 'Space']) {
    await edgeLabel.focus()
    await expect(edgeLabel).toBeFocused()
    await page.keyboard.press(key)
    await expect(edgeDialog).toBeVisible()
    await expect(edgeDialog.getByTestId('workflow-edge-condition-path').locator('input')).toHaveValue('outputJson.route_token')
    await page.keyboard.press('Escape')
    await expect(edgeDialog).toBeHidden()
  }
  await edgeLabel.dblclick()
  await expect(edgeDialog.getByTestId('workflow-edge-condition-path').locator('input')).toHaveValue('outputJson.route_token')
  const conditionSemantics = edgeDialog.getByTestId('workflow-edge-condition-semantics')
  const conditionSemanticsText = conditionSemantics.locator('p')
  const operatorLabels = [
    'Equals', 'Does not equal', 'Contains', 'Does not contain', 'Exists', 'Does not exist',
    'Greater than', 'Greater than or equal', 'Less than', 'Less than or equal', 'Is in list', 'Is not in list',
  ]
  let currentOperatorIndex = 0
  const chooseOperator = async (label: string) => {
    const index = operatorLabels.indexOf(label)
    expect(index).toBeGreaterThanOrEqual(0)
    const select = edgeDialog.getByTestId('workflow-edge-condition-operator').locator('.n-base-selection')
    await select.click()
    const key = index >= currentOperatorIndex ? 'ArrowDown' : 'ArrowUp'
    for (let step = 0; step < Math.abs(index - currentOperatorIndex); step += 1) await page.keyboard.press(key)
    await page.keyboard.press('Enter')
    currentOperatorIndex = index
    await expect(edgeDialog.getByTestId('workflow-edge-condition-operator')).toContainText(label)
    await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  }
  await expect(conditionSemanticsText).toHaveText('Reads the value at outputJson.route_token. Matches only when that field value exactly equals “HSR_RELEASED_OK”; it never compares the field name.')
  await chooseOperator('Contains')
  await expect(conditionSemanticsText).toHaveText('Reads the value at outputJson.route_token and checks whether that field value contains “HSR_RELEASED_OK”; it never searches the field name.')
  await chooseOperator('Does not contain')
  await expect(conditionSemanticsText).toHaveText('Reads the value at outputJson.route_token. Matches only when that field value does not contain “HSR_RELEASED_OK”; it never searches the field name.')
  await chooseOperator('Exists')
  await expect(conditionSemanticsText).toHaveText('Matches when the JSON field at outputJson.route_token exists. It does not compare the field value.')
  await chooseOperator('Does not exist')
  await expect(conditionSemanticsText).toHaveText('Matches when the JSON field at outputJson.route_token is missing. It does not compare the field value.')
  await chooseOperator('Does not equal')
  await expect(conditionSemanticsText).toHaveText('Reads the value at outputJson.route_token. Matches only when that field value is different from “HSR_RELEASED_OK”; it never compares the field name.')
  await chooseOperator('Equals')
  await page.getByTestId('workflow-edge-condition-path-preset').click()
  await page.getByText('Entire successful reply text (output, recommended)', { exact: true }).last().click()
  await expect(conditionSemanticsText).toHaveText('Matches only when the complete reply text exactly equals “HSR_RELEASED_OK”. It does not read or compare one JSON field value.')
  await chooseOperator('Does not equal')
  await expect(conditionSemanticsText).toHaveText('Matches only when the complete reply text is different from “HSR_RELEASED_OK”. It does not read or compare one JSON field value.')
  await chooseOperator('Contains')
  await expect(conditionSemanticsText).toHaveText('Looks for “HSR_RELEASED_OK” anywhere in the complete reply text. Text in either a JSON key or a JSON value can match; this is not a JSON field lookup.')
  await chooseOperator('Does not contain')
  await expect(conditionSemanticsText).toHaveText('Matches only when “HSR_RELEASED_OK” does not appear anywhere in the complete reply text, whether in a JSON key or a JSON value. This is not a JSON field lookup.')
  await chooseOperator('Exists')
  await expect(conditionSemanticsText).toHaveText('Matches when the complete reply text is available. It does not check whether any JSON key exists.')
  await chooseOperator('Does not exist')
  await expect(conditionSemanticsText).toHaveText('Matches when no complete reply text is available. It does not check whether a JSON key is missing.')
  await chooseOperator('Equals')
  const conditionHelp = page.getByText('For success, output is recommended. Choose Route only when no content check is needed.', { exact: true })
  const operatorHelp = page.getByText('Exactly equal, including type. Example: output equals "APPROVED".', { exact: true })
  const valueTypeHelp = page.getByText('Choose how Value is parsed and validated. This editing aid is inferred from the saved JSON value and is not stored separately.', { exact: true })
  const valueHelp = page.getByText('This checks the entire reply as literal text. With Contains, the text may appear in a JSON key or value; it does not look up a JSON field.', { exact: true })
  for (const help of [conditionHelp, operatorHelp, valueTypeHelp, valueHelp]) await expect(help).toHaveCount(0)
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

  await edge.dblclick({ force: true })
  const reopenedEdgeDialog = page.locator('.workflow-edge-editor-form').first()
  await expect(reopenedEdgeDialog.getByTestId('workflow-edge-condition-value-type')).toContainText('Object')
  await expect(reopenedEdgeDialog.getByTestId('workflow-edge-condition-value').locator('input')).toHaveValue('{"status":"ready"}')
  await reopenedEdgeDialog.getByTestId('workflow-edge-condition-operator').click()
  const greaterThanOption = page.getByText('Greater than', { exact: true }).last()
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
  await reopenedEdgeDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  await edge.dblclick({ force: true })
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByTestId('workflow-edge-condition-path-preset')).toContainText('Entire successful reply text (output, recommended)')
  await expect(page.getByTestId('workflow-edge-condition-value-type')).toContainText('Number')
  await expect(page.getByTestId('workflow-edge-condition-value').locator('input')).toHaveValue('42')
  await page.getByTestId('workflow-edge-condition-operator').click({ force: true })
  await page.getByText('Exists', { exact: true }).last().click()
  await expect(page.getByTestId('workflow-edge-condition-value-type')).toHaveCount(0)
  await expect(page.getByTestId('workflow-edge-condition-value')).toHaveCount(0)
  await edgeDialog.getByRole('button', { name: 'Save', exact: true }).click()

  await edge.dispatchEvent('contextmenu', { clientX: 300, clientY: 180, button: 2 })
  await page.getByText('Edit Connection', { exact: true }).click()
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.n-modal-mask:visible')).toHaveCount(0)

  const sourceHandle = page.locator('.vue-flow__node[data-id="a"] .vue-flow__handle[data-handleid="output"]')
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

test('workflow nodes connect from every side and create an automatic self loop', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [{
    id: 'review', type: 'agent', position: { x: 220, y: 100 },
    data: { title: 'Review', agent: 'hermes', input: 'Review the result', skills: [], images: [], approvalRequired: false },
  }]
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-self-loop', name: 'Self loop workflow', profile: 'research', workspace: null,
    nodes, edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [] })
  await page.goto('/#/hermes/workflow')

  const node = page.locator('.vue-flow__node[data-id="review"]')
  const handles = node.locator('.workflow-handle')
  await expect(handles).toHaveCount(4)
  for (const handleId of ['input', 'top', 'output', 'bottom']) {
    const handle = node.locator(`.workflow-handle[data-handleid="${handleId}"]`)
    await expect(handle).toHaveCount(1)
    await expect(handle).toHaveClass(/connectablestart/)
    await expect(handle).toHaveClass(/connectableend/)
  }

  const rightHandle = node.locator('.workflow-handle[data-handleid="output"]')
  const topHandle = node.locator('.workflow-handle[data-handleid="top"]')
  const rightBox = await rightHandle.boundingBox()
  const topBox = await topHandle.boundingBox()
  expect(rightBox).not.toBeNull()
  expect(topBox).not.toBeNull()
  await page.mouse.move(rightBox!.x + rightBox!.width / 2, rightBox!.y + rightBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(topBox!.x + topBox!.width / 2, topBox!.y + topBox!.height / 2, { steps: 12 })
  await page.mouse.up()

  const selfLoop = page.locator('.vue-flow__edge[data-id="review-review"]')
  await expect(selfLoop).toHaveCount(1)
  await expect(selfLoop).toHaveClass(/vue-flow__edge-workflow-self-loop/)
  await expect(page.locator('[data-testid="workflow-edge-condition-label"][data-edge-id="review-review"]')).toHaveText('Source returned normally')
  const selfLoopPath = selfLoop.locator('.vue-flow__edge-interaction')
  await expect(selfLoop.locator('.vue-flow__edge-path')).toHaveAttribute('d', /M\s/)
  const selfLoopCrossesNode = await selfLoop.locator('.vue-flow__edge-path').evaluate((path: SVGPathElement) => {
    const matrix = path.getScreenCTM()!
    const length = path.getTotalLength()
    const nodeRect = document.querySelector('.vue-flow__node[data-id="review"]')!.getBoundingClientRect()
    for (let step = 1; step < 40; step += 1) {
      const point = path.getPointAtLength(length * step / 40)
      const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
      if (
        screen.x > nodeRect.left + 1 && screen.x < nodeRect.right - 1
        && screen.y > nodeRect.top + 1 && screen.y < nodeRect.bottom - 1
      ) return true
    }
    return false
  })
  expect(selfLoopCrossesNode).toBe(false)
  const loopPoint = await selfLoopPath.evaluate((path: SVGPathElement) => {
    const matrix = path.getScreenCTM()!
    const length = path.getTotalLength()
    for (let step = 1; step < 20; step += 1) {
      const point = path.getPointAtLength(length * step / 20)
      const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
      const hit = document.elementFromPoint(screen.x, screen.y)?.closest('.vue-flow__edge')
      if (hit?.getAttribute('data-id') === 'review-review') return { x: screen.x, y: screen.y }
    }
    return null
  })
  expect(loopPoint).not.toBeNull()
  if (!loopPoint) throw new Error('self-loop interaction point not found')
  await page.mouse.dblclick(loopPoint.x, loopPoint.y)

  const editor = page.locator('.workflow-edge-editor-form').first()
  await expect(editor.getByTestId('workflow-edge-connection-summary')).toContainText('Review → Review')
  await expect(editor.getByTestId('workflow-edge-connection-summary')).toContainText('Review will run itself again')
  await expect(editor.getByTestId('workflow-edge-loop-summary')).toContainText('Returns to Review')
  await expect(editor.getByTestId('workflow-edge-loop-scope')).toContainText('Loop nodes: Review')
  await expect(editor.getByText('Feedback loop', { exact: true })).toHaveCount(0)
  await expect(editor.getByTestId('workflow-edge-loop-node')).toHaveCount(0)
  await editor.getByText('Advanced settings', { exact: true }).click()
  const historyNode = editor.getByTestId('workflow-edge-loop-node')
  await expect(historyNode).toBeVisible()
  await expect(historyNode.locator('input')).toHaveCount(0)
  await historyNode.click()
  await page.getByText('Review', { exact: true }).last().click()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()

  const patchCount = api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-self-loop').length
  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-self-loop').length).toBe(patchCount + 1)
  const saved = JSON.parse(api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-self-loop').at(-1)!.postData || '{}')
  expect(saved.edges).toEqual([expect.objectContaining({
    id: 'review-review', source: 'review', target: 'review',
    sourceHandle: 'output', targetHandle: 'top', type: 'workflow-self-loop',
    data: { orchestration: { route: 'success', feedback: { maxIterations: 3, loopId: 'review' } } },
  })])
  expect(saved.edges[0]).not.toHaveProperty('class')
  expect(saved.edges[0]).not.toHaveProperty('animated')
  expect(api.unexpectedRequests).toEqual([])
})

test('workflow edge editor never exposes technical node ids when node titles are blank', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const technicalNodeId = '11111111-1111-4111-8111-111111111111'
  const edgeId = 'blank-title-loop'
  const sessionId = 'blank-title-session'
  const session = {
    id: sessionId, title: 'Blank title session', source: 'cli', model: 'test-model', provider: 'test-provider',
    profile: 'research', started_at: 1, ended_at: 2, last_active: 2, message_count: 0, tool_call_count: 0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
    billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: 'unavailable',
    messages: [],
  }
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-blank-title-loop', name: 'Blank title loop', profile: 'research', workspace: null,
    nodes: [{
      id: technicalNodeId, type: 'agent', position: { x: 220, y: 100 },
      data: { title: '   ', agent: 'hermes', input: 'Review', skills: [], images: [], approvalRequired: false },
    }],
    edges: [{
      id: edgeId, source: technicalNodeId, target: technicalNodeId,
      sourceHandle: 'output', targetHandle: 'top', type: 'workflow-self-loop',
      data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } },
    }],
    viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [{
    id: 'run-blank-title', workflow_id: 'wf-blank-title-loop', profile: 'research', workspace: null,
    start_node_ids: [technicalNodeId], status: 'completed', snapshot_nodes: [{ id: technicalNodeId, data: { title: '   ' } }],
    snapshot_edges: [], compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null,
    node_sessions: [{
      id: 'blank-title-node-session', run_id: 'run-blank-title', workflow_id: 'wf-blank-title-loop',
      node_id: technicalNodeId, execution_id: technicalNodeId, iteration_path: [], consumed_edge_evaluation_ids: [],
      session_id: sessionId, profile: 'research', agent: 'hermes', agent_mode: '', status: 'completed', sequence: 1,
      started_at: 1, finished_at: 2, created_at: 1, updated_at: 2, error: null,
    }],
    edge_evaluations: [], loop_epochs: [],
  }], sessions: [session] })
  await page.route(`**/api/hermes/sessions/${sessionId}**`, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ session }),
  }))
  await mockChatSocket(page)

  await page.goto('/#/hermes/workflow')
  await page.locator(`[data-testid="workflow-edge-condition-label"][data-edge-id="${edgeId}"]`).dblclick()
  const editor = page.locator('.workflow-edge-editor-form').first()
  await expect(editor).toBeVisible()
  await expect(editor.getByTestId('workflow-edge-connection-summary')).toContainText('Unknown node → Unknown node')
  await expect(editor.getByTestId('workflow-edge-loop-summary')).toContainText('Unknown node')
  await expect(editor.getByTestId('workflow-edge-loop-scope')).toContainText('Unknown node')
  await expect(editor).not.toContainText(technicalNodeId)

  await editor.getByText('Advanced settings', { exact: true }).click()
  const historyNode = editor.getByTestId('workflow-edge-loop-node')
  await historyNode.click()
  const option = page.getByText('Unknown node', { exact: true }).last()
  await expect(option).toBeVisible()
  await expect(page.locator('.n-base-select-menu:visible')).not.toContainText(technicalNodeId)
  await option.click()
  await expect(historyNode).toContainText('Unknown node')
  await expect(editor).not.toContainText(technicalNodeId)
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()

  await page.locator('.workflow-run-item').click()
  await page.locator(`.vue-flow__node[data-id="${technicalNodeId}"]`).click()
  const chatTitle = page.locator('.workflow-chat-title')
  await expect(chatTitle).toContainText('Unknown node')
  await expect(chatTitle).not.toContainText(technicalNodeId)
  expect(api.unexpectedRequests).toEqual([])
})

test('opposite-side self loops use measured node bounds in the rendered SVG', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const feedback = { orchestration: { route: 'success', feedback: { maxIterations: 3 } } }
  const nodes = [
    {
      id: 'horizontal', type: 'agent', position: { x: 180, y: 180 }, style: { width: '480px', height: '260px' },
      data: { title: 'Horizontal', agent: 'hermes', input: 'Horizontal loop', skills: [], images: [], approvalRequired: false },
    },
    {
      id: 'vertical', type: 'agent', position: { x: 900, y: 120 }, style: { width: '360px', height: '480px' },
      data: { title: 'Vertical', agent: 'hermes', input: 'Vertical loop', skills: [], images: [], approvalRequired: false },
    },
  ]
  const edges = [
    {
      id: 'horizontal-horizontal', source: 'horizontal', target: 'horizontal',
      sourceHandle: 'input', targetHandle: 'output', type: 'workflow-self-loop', data: feedback,
    },
    {
      id: 'vertical-vertical', source: 'vertical', target: 'vertical',
      sourceHandle: 'top', targetHandle: 'bottom', type: 'workflow-self-loop', data: feedback,
    },
  ]
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-opposite-loops', name: 'Opposite loops', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .4 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [] })
  await page.goto('/#/hermes/workflow')

  for (const nodeId of ['horizontal', 'vertical']) {
    const result = await page.locator(`.vue-flow__edge[data-id="${nodeId}-${nodeId}"] .vue-flow__edge-path`)
      .evaluate((path: SVGPathElement, currentNodeId) => {
        const matrix = path.getScreenCTM()!
        const length = path.getTotalLength()
        const nodeRect = document.querySelector(`.vue-flow__node[data-id="${currentNodeId}"]`)!.getBoundingClientRect()
        let inside = 0
        let hit = 0
        for (let step = 1; step < 80; step += 1) {
          const point = path.getPointAtLength(length * step / 80)
          const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
          if (
            screen.x > nodeRect.left + 1 && screen.x < nodeRect.right - 1
            && screen.y > nodeRect.top + 1 && screen.y < nodeRect.bottom - 1
          ) inside += 1
          const hitElement = document.elementFromPoint(screen.x, screen.y)
          const hitEdge = hitElement?.closest('.vue-flow__edge')
          const hitLabel = hitElement?.closest('[data-testid="workflow-edge-condition-label"]')
          if (
            hitEdge?.getAttribute('data-id') === `${currentNodeId}-${currentNodeId}`
            || hitLabel?.getAttribute('data-edge-id') === `${currentNodeId}-${currentNodeId}`
          ) hit += 1
        }
        return { d: path.getAttribute('d'), inside, hit }
      }, nodeId)
    expect(result.d).toMatch(/^M\s/)
    expect(result.inside, `${nodeId}: ${result.d}`).toBe(0)
    expect(result.hit, `${nodeId}: ${result.d}`).toBe(79)
  }
  expect(api.unexpectedRequests).toEqual([])
})

test('workflow loop validation blocks invalid editor and workflow saves before API writes', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'a', type: 'agent', position: { x: 0, y: 20 }, data: { title: 'A', agent: 'hermes', input: 'A', skills: [], images: [], approvalRequired: false } },
    { id: 'b', type: 'agent', position: { x: 360, y: 20 }, data: { title: 'B', agent: 'hermes', input: 'B', skills: [], images: [], approvalRequired: false } },
    { id: 'c', type: 'agent', position: { x: 0, y: 640 }, data: { title: 'C', agent: 'hermes', input: 'C', skills: [], images: [], approvalRequired: false } },
    { id: 'd', type: 'agent', position: { x: 360, y: 640 }, data: { title: 'D', agent: 'hermes', input: 'D', skills: [], images: [], approvalRequired: false } },
  ]
  const feedback = (loopId: string) => ({ orchestration: { route: 'success', feedback: { maxIterations: 3, loopId } } })
  const edges = [
    { id: 'a-b', source: 'a', target: 'b', type: 'smoothstep' },
    { id: 'b-a', source: 'b', target: 'a', type: 'smoothstep', data: feedback('retry') },
    { id: 'b-c', source: 'b', target: 'c', type: 'smoothstep' },
    { id: 'c-d', source: 'c', target: 'd', type: 'smoothstep' },
    { id: 'd-c', source: 'd', target: 'c', type: 'smoothstep', data: feedback('retry') },
  ]
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-invalid-loops', name: 'Invalid loops', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .65 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [] })
  await page.goto('/#/hermes/workflow')

  const patchCount = api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-invalid-loops').length
  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Each loop history label must be unique.', { exact: true }).last()).toBeVisible()
  await page.waitForTimeout(100)
  expect(api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-invalid-loops')).toHaveLength(patchCount)

  const feedbackEdge = page.locator('.vue-flow__edge[data-id="b-a"]')
  await feedbackEdge.dblclick({ force: true })
  const edgeDialog = page.locator('.workflow-edge-editor-form').first()
  await expect(edgeDialog).toBeVisible()
  await edgeDialog.getByText('Advanced settings', { exact: true }).click()
  const historyNode = edgeDialog.getByTestId('workflow-edge-loop-node')
  await expect(historyNode).toContainText('A')
  await expect(historyNode).not.toContainText('retry')
  await edgeDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(edgeDialog).toBeHidden()

  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-invalid-loops').length).toBe(patchCount + 1)
  const saved = JSON.parse(api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/hermes/workflows/wf-invalid-loops').at(-1)!.postData || '{}')
  expect(saved.edges.find((edge: { id: string }) => edge.id === 'b-a').data.orchestration.feedback.loopId).toBe('a')
  expect(saved.edges.find((edge: { id: string }) => edge.id === 'd-c').data.orchestration.feedback.loopId).toBe('retry')
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
  await expect(overview.getByText('Blocked', { exact: true })).toBeVisible()
  await expect(overview).not.toContainText('BLOCKED')
  await expect(overview.getByText('The release lock was missing before publication.', { exact: true })).toHaveCount(0)
  await expect(evidence.getByRole('button', { name: /Path checks/ })).toHaveAttribute('aria-expanded', 'true')
  await expect(evidence.getByRole('button', { name: 'Hide other details' })).toBeVisible()

  const blockerText = 'Publish release stopped the workflow (Blocked): The release lock was missing before publication. Continuing required “PUBLISHED”, but the upstream result was “Blocked”, so “Verify release” was not run.'
  await expect(evidence.getByText('Condition did not match', { exact: true })).toBeVisible()
  await expect(evidence.getByText('not_taken', { exact: true })).toHaveCount(0)
  const blockerRow = evidence.locator('.workflow-evidence-row').filter({ hasText: 'Publish release → Verify release' })
  await blockerRow.click()
  const detailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(detailModal).toBeVisible()
  await expect(detailModal.getByText(blockerText, { exact: true })).toBeVisible()
  await expect(detailModal.getByText('This connection was not used', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Only when the upstream node returns normally', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('The reply did not satisfy this connection’s condition.', { exact: true })).toBeVisible()
  await expect(detailModal).not.toContainText('not_taken')
  await expect(detailModal).not.toContainText('condition_not_matched')
  await expect(detailModal.getByText('PUBLISHED', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Blocked', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('BLOCKED', { exact: true })).toHaveCount(0)
  await expect(evidence.getByText('The source node returned normally; this path is only used when node execution fails.', { exact: true })).toBeVisible()
})

test('workflow business decisions use exact mappings and never invert unknown codes', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'source', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Source', agent: 'hermes', input: 'Source', skills: [], images: [], approvalRequired: false } },
    { id: 'target', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Target', agent: 'hermes', input: 'Target', skills: [], images: [], approvalRequired: false } },
  ]
  const edge = { id: 'source-target', source: 'source', target: 'target', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success' } } }
  const decisions = ['UNBLOCKED', 'NOT_PUBLISHED', 'UNVERIFIED', 'DO_NOT_SKIP', 'CUSTOM_INTERNAL_CODE']
  await mockHermesApi(page, {
    workflows: [{ id: 'wf-decisions', name: 'Decision workflow', profile: 'research', workspace: null, nodes, edges: [edge], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
    workflowRuns: decisions.map((decision, index) => ({
      id: `run-${decision}`, workflow_id: 'wf-decisions', profile: 'research', workspace: null, start_node_ids: ['source'], status: 'completed',
      snapshot_nodes: nodes, snapshot_edges: [edge], compiled_loops: [], started_at: index + 1, finished_at: index + 2, created_at: index + 1, error: null,
      node_sessions: [], edge_evaluations: [{
        id: `evaluation-${decision}`, run_id: `run-${decision}`, workflow_id: 'wf-decisions', edge_id: 'source-target',
        source_node_id: 'source', source_execution_id: 'source', iteration_path: [], target_node_id: 'target', source_outcome: 'success',
        status: 'taken', route: 'success', reason: null, sequence: 1, orchestration: { route: 'success' },
        condition_evaluation: { actual: JSON.stringify({ decision }) }, evaluated_at: index + 2,
      }], loop_epochs: [],
    })),
  })

  await page.goto('/#/hermes/workflow')
  const runs = page.locator('.workflow-run-item')
  for (let index = 0; index < decisions.length; index += 1) {
    await runs.nth(index).click()
    const overview = page.getByTestId('workflow-evidence-overview')
    await expect(overview).toContainText('Completed')
    await expect(overview).not.toContainText(decisions[index])
    await expect(overview).not.toContainText('Blocked')
    await expect(overview).not.toContainText('Published')
    await expect(overview).not.toContainText('Verified')
    await expect(overview).not.toContainText('No action needed')
  }
})

test('workflow history localizes structured decision field values without hiding ordinary JSON operands', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'source', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Source', agent: 'hermes', input: 'Source', skills: [], images: [], approvalRequired: false } },
    { id: 'target', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Target', agent: 'hermes', input: 'Target', skills: [], images: [], approvalRequired: false } },
    { id: 'gate', type: 'agent', position: { x: 420, y: 260 }, data: { title: 'Gate', agent: 'hermes', input: 'Gate', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [
    { id: 'source-target', source: 'source', target: 'target', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success', condition: { path: 'outputJson.decision', operator: 'equals', value: 'PUBLISHED' } } } },
    { id: 'source-gate', source: 'source', target: 'gate', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success', condition: { path: 'outputJson.failed_gate', operator: 'equals', value: 'release' } } } },
  ]
  await mockHermesApi(page, {
    workflows: [{ id: 'wf-structured-decision', name: 'Structured decision workflow', profile: 'research', workspace: null, nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
    workflowRuns: [{
      id: 'run-structured-decision', workflow_id: 'wf-structured-decision', profile: 'research', workspace: null, start_node_ids: ['source'], status: 'completed',
      snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null, node_sessions: [],
      edge_evaluations: [{
        id: 'evaluation-decision', run_id: 'run-structured-decision', workflow_id: 'wf-structured-decision', edge_id: 'source-target',
        source_node_id: 'source', source_execution_id: 'source', iteration_path: [], target_node_id: 'target', source_outcome: 'success',
        status: 'not_taken', route: 'success', reason: 'future_internal_reason', sequence: 1, orchestration: edges[0].data.orchestration,
        condition_evaluation: { status: 'not_matched', actual: 'BLOCKED' }, evaluated_at: 2,
      }, {
        id: 'evaluation-gate', run_id: 'run-structured-decision', workflow_id: 'wf-structured-decision', edge_id: 'source-gate',
        source_node_id: 'source', source_execution_id: 'source', iteration_path: [], target_node_id: 'gate', source_outcome: 'success',
        status: 'not_taken', route: 'success', reason: 'condition_not_matched', sequence: 2, orchestration: edges[1].data.orchestration,
        condition_evaluation: { status: 'not_matched', actual: 'image-build' }, evaluated_at: 2,
      }], loop_epochs: [],
    }],
  })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-run-item').click()
  const evidence = page.getByLabel('Workflow execution details')
  const decisionRow = evidence.locator('.workflow-evidence-row').filter({ hasText: 'Source → Target' })
  await expect(decisionRow.getByText('Parsed business decision', { exact: true })).toBeVisible()
  await expect(decisionRow.getByText('Blocked', { exact: true })).toBeVisible()
  await expect(decisionRow).not.toContainText('BLOCKED')
  await decisionRow.click()
  const detailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(detailModal).toBeVisible()
  await expect(detailModal.getByText('Blocked', { exact: true })).toBeVisible()
  await expect(detailModal).not.toContainText('BLOCKED')
  await expect(detailModal).not.toContainText('future_internal_reason')
  await detailModal.getByRole('button', { name: 'Close' }).click()
  const gateRow = evidence.locator('.workflow-evidence-row').filter({ hasText: 'Source → Gate' })
  await expect(gateRow.getByText('Actual upstream result', { exact: true })).toBeVisible()
  await expect(gateRow.getByText('image-build', { exact: true })).toBeVisible()
})

test('workflow history never exposes technical ids when snapshot node titles are missing', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const sourceId = '11111111-1111-4111-8111-111111111111'
  const targetId = '22222222-2222-4222-8222-222222222222'
  const nodes = [
    { id: sourceId, type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Source', agent: 'hermes', input: 'Source', skills: [], images: [], approvalRequired: false } },
    { id: targetId, type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Target', agent: 'hermes', input: 'Target', skills: [], images: [], approvalRequired: false } },
  ]
  const edge = { id: '33333333-3333-4333-8333-333333333333', source: sourceId, target: targetId, sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success' } } }
  await mockHermesApi(page, {
    workflows: [{ id: 'wf-missing-titles', name: 'Missing titles workflow', profile: 'research', workspace: null, nodes, edges: [edge], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
    workflowRuns: [{
      id: 'run-missing-titles', workflow_id: 'wf-missing-titles', profile: 'research', workspace: null, start_node_ids: [sourceId], status: 'completed',
      snapshot_nodes: [{ id: sourceId, data: {} }, { id: targetId, data: {} }], snapshot_edges: [edge], compiled_loops: [],
      started_at: 1, finished_at: 2, created_at: 1, error: null, node_sessions: [],
      edge_evaluations: [{
        id: 'evaluation-missing-titles', run_id: 'run-missing-titles', workflow_id: 'wf-missing-titles', edge_id: edge.id,
        source_node_id: sourceId, source_execution_id: sourceId, iteration_path: [], target_node_id: targetId, source_outcome: 'success',
        status: 'taken', route: 'success', reason: null, sequence: 1, orchestration: edge.data.orchestration,
        condition_evaluation: null, evaluated_at: 2,
      }], loop_epochs: [],
    }],
  })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-run-item').click()
  const row = page.getByLabel('Workflow execution details').locator('.workflow-evidence-row').first()
  await expect(row).toContainText('Unknown node → Unknown node')
  await expect(row).not.toContainText(sourceId)
  await expect(row).not.toContainText(targetId)
  await row.click()
  const modal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(modal).toContainText('Unknown node → Unknown node')
  await expect(modal).not.toContainText(sourceId)
  await expect(modal).not.toContainText(targetId)
})

test('workflow history explains raw-text and JSON-field existence checks separately', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'source', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Source', agent: 'hermes', input: 'Source', skills: [], images: [], approvalRequired: false } },
    ...['raw-exists', 'raw-missing', 'json-exists', 'json-missing'].map((id, index) => ({
      id, type: 'agent', position: { x: 420, y: 40 + index * 140 },
      data: { title: id, agent: 'hermes', input: id, skills: [], images: [], approvalRequired: false },
    })),
  ]
  const conditions = [
    { id: 'raw-exists', path: 'output', operator: 'exists', status: 'taken', evaluation: { status: 'matched', actual: 'reply' } },
    { id: 'raw-missing', path: 'output', operator: 'not_exists', status: 'not_taken', evaluation: { status: 'not_matched', actual: 'reply' } },
    { id: 'json-exists', path: 'outputJson.failed_gate', operator: 'exists', status: 'taken', evaluation: { status: 'matched', actual: 'quality' } },
    { id: 'json-missing', path: 'outputJson.failed_gate', operator: 'not_exists', status: 'not_taken', evaluation: { status: 'not_matched', reason: 'path_not_found' } },
  ] as const
  const edges = conditions.map(item => ({
    id: `source-${item.id}`, source: 'source', target: item.id, sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep',
    data: { orchestration: { route: 'success', condition: { path: item.path, operator: item.operator } } },
  }))
  await mockHermesApi(page, {
    workflows: [{ id: 'wf-existence', name: 'Existence workflow', profile: 'research', workspace: null, nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
    workflowRuns: [{
      id: 'run-existence', workflow_id: 'wf-existence', profile: 'research', workspace: null, start_node_ids: ['source'], status: 'completed',
      snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null, node_sessions: [],
      edge_evaluations: conditions.map((item, index) => ({
        id: `evaluation-${item.id}`, run_id: 'run-existence', workflow_id: 'wf-existence', edge_id: `source-${item.id}`,
        source_node_id: 'source', source_execution_id: 'source', iteration_path: [], target_node_id: item.id, source_outcome: 'success',
        status: item.status, route: 'success', reason: item.status === 'taken' ? null : 'condition_not_matched', sequence: index + 1,
        orchestration: edges[index].data.orchestration, condition_evaluation: item.evaluation, evaluated_at: 2,
      })),
      loop_epochs: [],
    }],
  })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-run-item').click()
  const evidence = page.getByLabel('Workflow execution details')
  const row = (title: string) => evidence.locator('.workflow-evidence-row').filter({ hasText: `Source → ${title}` })
  await expect(row('raw-exists')).toContainText('Matches when the complete reply text is available. It does not check whether any JSON key exists.')
  await expect(row('raw-missing')).toContainText('Matches when no complete reply text is available. It does not check whether a JSON key is missing.')
  await expect(row('json-exists')).toContainText('Matches when the JSON field at outputJson.failed_gate exists. It does not compare the field value.')
  await expect(row('json-missing')).toContainText('Matches when the JSON field at outputJson.failed_gate is missing. It does not compare the field value.')
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
  await expect(overview.getByText('Blocked', { exact: true })).toBeVisible()
  await expect(overview).not.toContainText('BLOCKED')
  await expect(overview).not.toContainText('quality-container-setup')
  await expect(overview).not.toContainText('The container workdir did not exist before the first command.')
  const actualPath = overview.getByTestId('workflow-actual-path')
  await expect(actualPath).toContainText('Build and publish → Blocked outcome')
  await expect(actualPath).toContainText('Blocked outcome → Plain-language summary')
  await expect(actualPath).not.toContainText('Verify release')

  const detailsToggle = evidence.getByRole('button', { name: /Path checks/ })
  await expect(detailsToggle).toContainText('2 used')
  await expect(detailsToggle).toContainText('3 not used')
  await expect(detailsToggle).toHaveAttribute('aria-expanded', 'true')
  const selectedPaths = evidence.getByTestId('workflow-selected-paths')
  await expect(selectedPaths.locator('.workflow-evidence-row')).toHaveCount(2)
  const blockedPath = selectedPaths.locator('.workflow-evidence-row').filter({ hasText: 'Build and publish → Blocked outcome' })
  const blockedCondition = blockedPath.getByTestId('workflow-condition-comparison')
  await expect(blockedCondition).toContainText('Checked data')
  await expect(blockedCondition).toContainText('Entire reply text')
  await expect(blockedCondition).toContainText('output')
  await expect(blockedCondition).toContainText('Comparison')
  await expect(blockedCondition).toContainText('Contains')
  await expect(blockedCondition).toContainText('Text to find')
  await expect(blockedCondition).toContainText('failed_gate')
  await expect(blockedCondition).toContainText('Parsed business decision')
  await expect(blockedCondition).toContainText('Blocked')
  await expect(blockedCondition).not.toContainText('BLOCKED')
  await expect(blockedCondition).toContainText('Failed step (value of failed_gate)')
  await expect(blockedCondition).toContainText('quality-container-setup')
  await expect(blockedCondition).toContainText('Looks for “failed_gate” anywhere in the complete reply text. Text in either a JSON key or a JSON value can match; this is not a JSON field lookup.')
  await expect(blockedCondition).toContainText('Matched')
  await expect(selectedPaths).not.toContainText('Continued after success')
  await expect(selectedPaths.getByText('Build and publish → Verify release', { exact: true })).toHaveCount(0)

  const alternativesToggle = evidence.getByRole('button', { name: 'Hide other details' })
  await expect(alternativesToggle).toBeVisible()
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
  await expect(detailModal.getByText('This connection was used', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Only when the upstream node returns normally', { exact: true })).toBeVisible()
  await expect(detailModal).not.toContainText('(taken)')
  await expect(detailModal).not.toContainText('(success)')
  await page.keyboard.press('Escape')
  await expect(detailModal).toBeHidden()
  await expect(page.locator('.n-modal-mask:visible')).toHaveCount(0)

  const resizeHandle = evidence.getByTestId('workflow-evidence-resize-handle')
  await expect(resizeHandle).toHaveAttribute('role', 'separator')
  await expect(resizeHandle).toHaveAttribute('aria-orientation', 'horizontal')
  await expect(resizeHandle).toHaveAttribute('aria-valuemin', /\d+/)
  await expect(resizeHandle).toHaveAttribute('aria-valuemax', /\d+/)
  await expect(resizeHandle).toHaveAttribute('aria-valuenow', /\d+/)
  await resizeHandle.focus()
  const beforeKeyboardResize = await evidence.boundingBox()
  await page.keyboard.press('ArrowUp')
  const afterKeyboardResize = await evidence.boundingBox()
  expect(afterKeyboardResize!.height).toBeGreaterThan(beforeKeyboardResize!.height)
  const beforeResize = await evidence.boundingBox()
  const handleBox = await resizeHandle.boundingBox()
  expect(beforeResize).not.toBeNull()
  expect(handleBox).not.toBeNull()
  const handleCenter = { x: handleBox!.x + handleBox!.width / 2, y: handleBox!.y + handleBox!.height / 2 }
  const handleHit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return {
      tag: element?.tagName,
      className: element?.getAttribute('class'),
      testId: element?.getAttribute('data-testid'),
    }
  }, handleCenter)
  expect(handleHit).toMatchObject({ tag: 'BUTTON', testId: 'workflow-evidence-resize-handle' })
  await page.mouse.move(handleCenter.x, handleCenter.y)
  await page.mouse.down()
  await expect(page.locator('body')).toHaveCSS('cursor', 'row-resize')
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 90, { steps: 5 })
  await expect(evidence).toHaveAttribute('style', /height:\s*\d+px/)
  await page.mouse.up()
  const afterResize = await evidence.boundingBox()
  expect(afterResize!.height).toBeGreaterThan(beforeResize!.height + 60)
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
