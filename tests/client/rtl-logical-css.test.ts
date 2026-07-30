import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const CLIENT_ROOT = join(process.cwd(), 'packages/client/src')

// Spacing, borders and text alignment must follow the writing direction rather
// than a physical side, otherwise a right-to-left locale keeps its gutters,
// dividers and indentation on the wrong edge. Every client component now uses
// the logical properties, so this walks the whole tree instead of a maintained
// list and fails as soon as a physical declaration appears anywhere.
const PHYSICAL_PATTERNS: Array<{ label: string, pattern: RegExp }> = [
  { label: 'margin-left', pattern: /\bmargin-left\b/g },
  { label: 'margin-right', pattern: /\bmargin-right\b/g },
  { label: 'padding-left', pattern: /\bpadding-left\b/g },
  { label: 'padding-right', pattern: /\bpadding-right\b/g },
  { label: 'border-left', pattern: /\bborder-left\b/g },
  { label: 'border-right', pattern: /\bborder-right\b/g },
  { label: 'text-align: left', pattern: /text-align:\s*left\b/g },
  { label: 'text-align: right', pattern: /text-align:\s*right\b/g },
]

function collectComponents(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectComponents(path, files)
    else if (entry.name.endsWith('.vue')) files.push(path)
  }
  return files
}

describe('client components use direction-aware CSS', () => {
  const components = collectComponents(CLIENT_ROOT)

  it('scans the whole client component tree', () => {
    expect(components.length).toBeGreaterThan(50)
  })

  it('has no physical inline-axis spacing, borders or text alignment', () => {
    const offenders: string[] = []

    for (const component of components) {
      const source = readFileSync(component, 'utf8')
      for (const { label, pattern } of PHYSICAL_PATTERNS) {
        const matches = source.match(pattern)
        if (matches) {
          offenders.push(`${relative(CLIENT_ROOT, component)}: ${label} × ${matches.length}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('actually uses the logical replacements', () => {
    const combined = components.map(component => readFileSync(component, 'utf8')).join('\n')

    for (const logical of [
      'margin-inline-start',
      'margin-inline-end',
      'padding-inline-start',
      'padding-inline-end',
      'border-inline-start',
      'text-align: start',
    ]) {
      expect(combined, logical).toContain(logical)
    }
  })
})
