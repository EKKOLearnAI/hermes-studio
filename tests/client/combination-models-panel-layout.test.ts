import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  'packages/client/src/components/hermes/models/CombinationModelsPanel.vue',
  'utf8',
)

describe('combination models panel layout', () => {
  it('keeps the model, reasoning effort, and right-aligned actions on one row', () => {
    expect(source).toMatch(
      /\.slot-editor-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 130px auto;/s,
    )
    expect(source).not.toMatch(/\.aggregator-row\s*\{[^}]*grid-template-columns:/s)
  })
})
