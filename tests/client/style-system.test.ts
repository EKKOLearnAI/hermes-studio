import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const readClientFile = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')

describe('client style system', () => {
  it('keeps shared page headers on one layout baseline', () => {
    const globalStyles = readClientFile('styles/global.scss')

    expect(globalStyles).toContain('min-height: 64px;')
    expect(globalStyles).toContain('padding: 14px 20px;')
    expect(globalStyles).toContain('.page-header > .header-actions')
  })

  it('aligns SCSS surfaces and radii with the Naive UI theme', () => {
    const variables = readClientFile('styles/variables.scss')
    const theme = readClientFile('styles/theme.ts')

    expect(variables).toContain('--bg-card: #2a2a2a;')
    expect(theme).toContain("cardColor: '#2a2a2a'")
    expect(variables).toContain('$radius-sm: 6px;')
    expect(variables).toContain('$radius-md: 8px;')
    expect(variables).toContain('$radius-lg: 8px;')
    expect(theme).toContain("borderRadius: '8px'")
    expect(theme).toContain("borderRadiusSmall: '6px'")
  })
})
