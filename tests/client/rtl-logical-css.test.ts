import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { parse } from '@vue/compiler-sfc'

const CLIENT_ROOT = join(process.cwd(), 'packages/client/src')
const PHYSICAL_OVERRIDE_MARKER = 'rtl-physical'

// Spacing, borders and text alignment must follow the writing direction rather
// than a physical side by default. Rare deliberately physical declarations can
// carry an `rtl-physical` comment on the same line; this keeps the guard from
// forcing native chrome, coordinates, or other physical UI into a wrong
// mechanical conversion.
const PHYSICAL_PATTERNS: Array<{ label: string, pattern: RegExp }> = [
  { label: 'margin-left', pattern: /\bmargin-left\b/ },
  { label: 'margin-right', pattern: /\bmargin-right\b/ },
  { label: 'padding-left', pattern: /\bpadding-left\b/ },
  { label: 'padding-right', pattern: /\bpadding-right\b/ },
  { label: 'border-left', pattern: /\bborder-left\b/ },
  { label: 'border-right', pattern: /\bborder-right\b/ },
  { label: 'text-align: left', pattern: /text-align:\s*left\b/ },
  { label: 'text-align: right', pattern: /text-align:\s*right\b/ },
]

function collectComponents(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectComponents(path, files)
    else if (entry.name.endsWith('.vue')) files.push(path)
  }
  return files
}

function componentStyles(component: string): string[] {
  const source = readFileSync(component, 'utf8')
  return parse(source, { filename: component }).descriptor.styles.map(style => style.content)
}

describe('client components use direction-aware CSS', () => {
  const components = collectComponents(CLIENT_ROOT)

  it('scans the whole client component tree', () => {
    expect(components.length).toBeGreaterThan(50)
  })

  it('has no physical inline-axis spacing, borders or text alignment', () => {
    const offenders: string[] = []

    for (const component of components) {
      for (const style of componentStyles(component)) {
        for (const [index, line] of style.split('\n').entries()) {
          if (line.includes(PHYSICAL_OVERRIDE_MARKER)) continue
          for (const { label, pattern } of PHYSICAL_PATTERNS) {
            if (pattern.test(line)) {
              offenders.push(`${relative(CLIENT_ROOT, component)} style:${index + 1}: ${label}`)
            }
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('actually uses the logical replacements', () => {
    const combined = components.flatMap(component => componentStyles(component)).join('\n')

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

  it('preserves left-edge tail truncation for explicitly RTL path text', () => {
    const source = readFileSync(join(CLIENT_ROOT, 'components/hermes/skills/SkillList.vue'), 'utf8')
    const pathRule = source.match(/\.path-header-text\s*\{([\s\S]*?)\}/)?.[1] || ''

    expect(pathRule).toContain('direction: rtl;')
    expect(pathRule).toContain('text-align: end;')
    expect(pathRule).not.toContain('text-align: start;')
  })
})
