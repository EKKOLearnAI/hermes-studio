import { describe, expect, it } from 'vitest'
import { parseDotenvValue } from '../../packages/server/src/services/dotenv'

describe('parseDotenvValue', () => {
  it('handles blank lines, comments, export, and quoted values', () => {
    const content = [
      '',
      '# ignored',
      'PLAIN=value # trailing comment',
      'export SINGLE=\'single # value\' # ignored comment',
      '  export DOUBLE="double value"  ',
      'FRAGMENT=value#fragment',
      '',
    ].join('\n')

    expect(parseDotenvValue(content, 'PLAIN')).toBe('value')
    expect(parseDotenvValue(content, 'SINGLE')).toBe('single # value')
    expect(parseDotenvValue(content, 'DOUBLE')).toBe('double value')
    expect(parseDotenvValue(content, 'FRAGMENT')).toBe('value#fragment')
    expect(parseDotenvValue(content, 'MISSING')).toBe('')
  })

  it('rejects invalid key names', () => {
    expect(parseDotenvValue('export TOKEN=value', 'export TOKEN')).toBe('')
  })
})
