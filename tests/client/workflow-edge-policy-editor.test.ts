import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const view = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')
const localeFiles = ['de.ts', 'en.ts', 'es.ts', 'fr.ts', 'ja.ts', 'ko.ts', 'pt.ts', 'ru.ts', 'zh-TW.ts', 'zh.ts']

describe('workflow edge policy editor contract', () => {
  it('preserves declarative orchestration data and opens an editor from edge click', () => {
    expect(view).toMatch(/interface WorkflowEdge[\s\S]*data\?: WorkflowEdgeData/)
    expect(view).toContain('data: normalizeWorkflowEdgeData(record.data)')
    expect(view).toContain('data: cloneWorkflowEdgeData(edge.data)')
    expect(view).toContain('function cloneWorkflowEdgeData')
    expect(view).toContain('@edge-click="handleEdgeClick"')
    expect(view).toContain('edgePolicyEditorVisible')
    expect(view).toContain("route: 'success' | 'failure' | 'always'")
    expect(view).toContain("loop?: { maxIterations: number }")
    expect(view).toContain("loop: structuredClone(policy.loop)")
    expect(view).toContain("operator: 'equals' | 'not_equals' | 'exists' | 'truthy' | 'contains'")
    expect(view).toContain('edgePolicyEditorConditionEnabled')
    expect(view).toContain('edgePolicyEditorConditionPath')
    expect(view).toContain('edgePolicyEditorConditionValue')
    expect(view).toContain('edgePolicyEditorLoopEnabled')
    expect(view).toContain('NInputNumber')
    expect(view).toContain(':min="1"')
    expect(view).toContain(':max="100"')
    expect(view).toContain("t('workflow.edgePolicy.loopConditionRequired')")
    expect(view).toContain('parseEdgeConditionValue')
    expect(view).not.toContain('eval(')
    expect(view).toContain("if (!Object.prototype.hasOwnProperty.call(data, 'orchestration'))")
    expect(view).toContain("return { orchestration: structuredClone(data.orchestration) as WorkflowEdgeData['orchestration'] }")
    for (const locale of localeFiles) {
      const source = readFileSync(`packages/client/src/i18n/locales/${locale}`, 'utf8')
      expect(source, locale).toMatch(/edgePolicy:\s*\{/)
      expect(source, locale).toMatch(/routes:\s*\{/)
      expect(source, locale).toMatch(/operators:\s*\{/)
      expect(source, locale).toMatch(/valueInvalid:\s*['"]/)
      expect(source, locale).toMatch(/loop:\s*['"]/)
      expect(source, locale).toMatch(/maxIterations:\s*['"]/)
      expect(source, locale).toMatch(/loopConditionRequired:\s*['"]/)
    }
  })
})
